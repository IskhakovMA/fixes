"""Read-only AI assistant API."""
from __future__ import annotations

import sqlite3
import threading

from fastapi import APIRouter, Depends, HTTPException, Query, status

from .. import config, policy
from ..ai import orchestrator
from ..ai.provider import AIProviderError, AIProviderUnavailable, provider_health
from ..ai.schemas import AIChatIn, AIChatOut, AIStatusOut
from ..ai.tools import ToolPermissionError
from ..deps import abuse_rate_limit, get_db, require_active_password, require_csrf

router = APIRouter(prefix="/api/ai", tags=["ai"])

# Вызовы провайдера блокируют поток из общего пула: без ограничения один
# пользователь может занять его целиком и задержать остальные запросы.
_ai_slots = threading.BoundedSemaphore(config.AI_MAX_CONCURRENT_REQUESTS)
_AI_BUSY = "ИИ-помощник сейчас занят. Повторите запрос через несколько секунд."


@router.get(
    "/status",
    response_model=AIStatusOut,
    dependencies=[
        Depends(abuse_rate_limit("ai_status", config.AI_RATE_LIMIT_REQUESTS, config.AI_RATE_LIMIT_WINDOW_SECONDS)),
    ],
)
def status_endpoint(
    refresh: bool = Query(False),
    _user: policy.CurrentUser = Depends(require_active_password),
):
    if refresh and not _ai_slots.acquire(blocking=False):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=_AI_BUSY)
    try:
        health = provider_health(force_refresh=refresh)
    finally:
        if refresh:
            _ai_slots.release()
    return {
        "enabled": health.state != "disabled",
        "available": health.available,
        "state": health.state,
        "reason": health.reason,
        "message": health.message,
    }


@router.post(
    "/chat",
    response_model=AIChatOut,
    dependencies=[
        Depends(require_csrf),
        Depends(abuse_rate_limit("ai_chat", config.AI_RATE_LIMIT_REQUESTS, config.AI_RATE_LIMIT_WINDOW_SECONDS)),
    ],
)
def chat_endpoint(
    body: AIChatIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    if not _ai_slots.acquire(blocking=False):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=_AI_BUSY)
    try:
        return orchestrator.answer(conn, user, body)
    except ToolPermissionError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except AIProviderUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    except AIProviderError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    finally:
        _ai_slots.release()
