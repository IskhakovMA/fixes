"""Shared FastAPI dependencies: DB connection, session auth, CSRF, current user."""
import sqlite3

from fastapi import Depends, HTTPException, Request, status

from . import audit, config, policy, security
from .db import _connect, init_db


_initialized_db_paths: set[str] = set()


def get_db():
    conn = _connect(config.DB_PATH)
    # Схема и сиды применяются один раз на путь в процессе (lifespan тоже
    # вызывает init_db), а не отдельной пишущей транзакцией на каждый запрос.
    key = str(config.DB_PATH)
    if key not in _initialized_db_paths:
        init_db(conn)
        _initialized_db_paths.add(key)
    try:
        yield conn
    finally:
        conn.close()


def require_session(request: Request, conn: sqlite3.Connection = Depends(get_db)) -> sqlite3.Row:
    token = request.cookies.get(config.SESSION_COOKIE_NAME)
    session = security.validate_session(conn, token)
    if session is None:
        # Same response for missing, expired and forged sessions — nothing here
        # tells a caller which of the three it was.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return session


def require_user(
    session: sqlite3.Row = Depends(require_session),
    conn: sqlite3.Connection = Depends(get_db),
) -> policy.CurrentUser:
    """Пользователь текущей сессии. Статус и роль перечитываются из БД на
    каждый запрос, поэтому блокировка, деактивация и смена роли действуют
    немедленно, без ожидания истечения сессии."""
    user_id = session["user_id"]
    user = policy.load_current_user(conn, user_id) if user_id else None
    if user is None or user.status != "active":
        # Сессия неактивного пользователя удаляется — блокировка окончательна.
        if user_id:
            with conn:
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return user


def require_active_password(user: policy.CurrentUser = Depends(require_user)) -> policy.CurrentUser:
    """Для всех рабочих endpoints: при обязательной смене временного пароля
    доступ ограничен до /api/auth/change-password."""
    if user.must_change_password:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password change required",
        )
    return user


def current_actor(session: sqlite3.Row = Depends(require_session)) -> str | None:
    """Anonymised audit actor for the calling session."""
    return audit.actor_from_token_hash(session["token_hash"])


def require_csrf(request: Request, session: sqlite3.Row = Depends(require_session)) -> sqlite3.Row:
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        referer = request.headers.get("referer")
        current_origin = f"{request.url.scheme}://{request.headers.get('host', '')}"
        if origin and origin != current_origin:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-site request rejected")
        if referer and not referer.startswith(current_origin + "/"):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-site request rejected")
    header_token = request.headers.get("x-csrf-token")
    if not header_token or header_token != session["csrf_token"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="CSRF token missing or invalid")
    return session


def abuse_rate_limit(name: str, max_requests: int, window_seconds: int = 60):
    def dependency(request: Request, user: policy.CurrentUser = Depends(require_active_password)) -> None:
        client_host = request.client.host if request.client else "unknown"
        key = f"{name}:{user.id}:{client_host}"
        wait = security.check_request_rate_limit(key, max_requests, window_seconds)
        if wait > 0:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Please wait before trying again.",
                headers={"Retry-After": str(int(wait) + 1)},
            )
    return dependency
