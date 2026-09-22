"""FastAPI application: wiring, security headers, static frontend serving.

Deliberately has no CORS middleware — the frontend is served by this same
process on the same origin, so there is nothing to allow-list. If this is
ever split into separate origins, CORS must be added back restrictively.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import config, security
from .db import get_connection, init_db
from .routes import ai, analytics, audit_log, auth, data_quality, importexport, internal_notifications, migrate, notifications, patients, staff, structure

logging.basicConfig(
    level=logging.DEBUG if config.DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("clinic")


class _DropQueryStringFilter(logging.Filter):
    """uvicorn access log пишет полный request target. Строка запроса может
    содержать ФИО пациента (поиск в списках), поэтому она отбрасывается —
    в журнал попадает только путь."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str) and "?" in args[2]:
            record.args = args[:2] + (args[2].split("?", 1)[0],) + args[3:]
        return True


_access_logger = logging.getLogger("uvicorn.access")
if not any(isinstance(f, _DropQueryStringFilter) for f in _access_logger.filters):
    _access_logger.addFilter(_DropQueryStringFilter())

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
FRONTEND_HTML = PROJECT_ROOT / "index.html"
STATIC_DIR = PROJECT_ROOT / "static"

# Никаких послаблений: ни inline-скриптов, ни inline-стилей, ни eval.
# Весь CSS и JS грузятся отдельными файлами с собственного origin.
CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "script-src-attr 'none'; "
    "style-src 'self'; "
    "style-src-attr 'none'; "
    "img-src 'self' data:; "
    "font-src 'self' data:; "
    "connect-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'none'; "
    "form-action 'self'"
)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    conn = get_connection()
    init_db(conn)
    security.purge_expired_sessions(conn)
    logger.info(
        "clinic-tracker backend starting on %s:%s (https=%s debug=%s)",
        config.HOST,
        config.PORT,
        config.HTTPS,
        config.DEBUG,
    )
    yield


app = FastAPI(
    title="Система планирования API",
    docs_url="/api/docs" if config.DEBUG else None,
    openapi_url="/openapi.json" if config.DEBUG else None,
    redoc_url=None,
    lifespan=lifespan,
)

class _BodyTooLarge(Exception):
    pass


class BodySizeLimitMiddleware:
    """Отклоняет тело больше config.MAX_REQUEST_BODY_BYTES кодом 413 до того,
    как FastAPI буферизует и разбирает его (и до проверки сессии): и по
    Content-Length, и по фактически полученным байтам (chunked)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = config.MAX_REQUEST_BODY_BYTES
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    too_large = int(value) > limit
                except ValueError:
                    too_large = True
                if too_large:
                    await self._reject(send)
                    return
        received = 0
        started = False
        rejected = False

        async def limited_receive():
            nonlocal received, rejected
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # Ответить 413 сразу: приложение может перехватить
                    # исключение чтения тела и попытаться ответить само.
                    if not started and not rejected:
                        rejected = True
                        await self._reject(send)
                    raise _BodyTooLarge()
            return message

        async def tracking_send(message):
            nonlocal started
            if rejected:
                return
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _BodyTooLarge:
            pass

    @staticmethod
    async def _reject(send):
        body = b'{"error":"Request body too large"}'
        await send({"type": "http.response.start", "status": 413, "headers": [
            (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
        ]})
        await send({"type": "http.response.body", "body": body})


app.add_middleware(TrustedHostMiddleware, allowed_hosts=[config.HOST, "127.0.0.1", "localhost"])
app.add_middleware(BodySizeLimitMiddleware)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    if config.HTTPS:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


app.include_router(auth.router)
app.include_router(ai.router)
app.include_router(patients.router)
app.include_router(importexport.router)
app.include_router(migrate.router)
app.include_router(audit_log.router)
app.include_router(data_quality.router)
app.include_router(notifications.router)
app.include_router(notifications.templates_router)
app.include_router(analytics.router)
app.include_router(internal_notifications.router)
app.include_router(staff.router)
app.include_router(structure.router)


# Единственная точка входа приложения. Устаревшие страницы прежних версий
# намеренно не раздаются — обращение к ним даёт 404.
@app.get("/")
def serve_index():
    return FileResponse(FRONTEND_HTML, media_type="text/html")


STATIC_FILES = {
    "styles.css": "text/css",
    "fonts.css": "text/css",
    "app.js": "application/javascript",
    "logo.png": "image/png",
}


@app.get("/static/{filename}")
def serve_static(filename: str):
    """Отдаёт только явно перечисленные файлы: имя не используется для
    построения пути к произвольному файлу на диске."""
    media_type = STATIC_FILES.get(filename)
    if media_type is None:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(STATIC_DIR / filename, media_type=media_type)
