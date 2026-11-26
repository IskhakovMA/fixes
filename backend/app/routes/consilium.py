"""Oncology consilium appointments owned by the current account."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse, Response

from .. import audit, config, policy, session_context
from ..deps import abuse_rate_limit, get_db, require_active_password, require_csrf
from ..models import (
    ConsiliumAppointmentIn,
    ConsiliumAppointmentUpdateIn,
    ConsiliumBackdatedAppointmentIn,
    ConsiliumBackdatedSlotIn,
    ConsiliumDecisionIn,
    ConsiliumRegistryCompletionIn,
    ConsiliumRevisionIn,
    ConsiliumScheduleGenerateIn,
    ConsiliumVersionIn,
    strict_iso_date,
)
from ..services import consilium
from ..services.xlsx_export import workbook_bytes


router = APIRouter(prefix="/api/consilium", tags=["consilium"])

# Лимиты на пользователя и адрес (config.CONSILIUM_*_RATE_LIMIT, по умолчанию
# 60 изменений и 20 выгрузок/генераций сетки в минуту). Запись врачом и решения
# председателя — штучные действия: 60/мин покрывают заседание и останавливают
# скрипт; выгрузки реестров с ПДн и генерация сетки тяжелее и реже.
_WINDOW = config.CONSILIUM_RATE_LIMIT_WINDOW_SECONDS
_WRITE_LIMIT = Depends(abuse_rate_limit("consilium_write", config.CONSILIUM_WRITE_RATE_LIMIT, _WINDOW))
_DECISION_LIMIT = Depends(abuse_rate_limit("consilium_decision", config.CONSILIUM_WRITE_RATE_LIMIT, _WINDOW))
_SCHEDULE_LIMIT = Depends(abuse_rate_limit("consilium_schedule_generate", config.CONSILIUM_SCHEDULE_RATE_LIMIT, _WINDOW))
_EXPORT_LIMIT = Depends(abuse_rate_limit("consilium_registry_export", config.CONSILIUM_EXPORT_RATE_LIMIT, _WINDOW))


def _not_found():
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Appointment not found")


def _require(conn: sqlite3.Connection, user: policy.CurrentUser, allowed: bool, action: str) -> None:
    if not allowed:
        audit.record(
            conn, audit.ACCESS_DENIED, result=audit.RESULT_DENIED,
            detail=f"action={action}", **audit.actor_ctx(user),
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def _require_manage(conn: sqlite3.Connection, user: policy.CurrentUser) -> None:
    _require(conn, user, policy.can_manage_consilium(user), "consilium_manage")


def _require_decision(conn: sqlite3.Connection, user: policy.CurrentUser) -> None:
    _require(conn, user, policy.can_decide_consilium(user), "consilium_decision")


def _require_favorites(conn: sqlite3.Connection, user: policy.CurrentUser) -> None:
    _require(conn, user, policy.can_use_chair_favorites(user), "consilium_favorites")


def _require_referral_mark(conn: sqlite3.Connection, user: policy.CurrentUser) -> None:
    _require(conn, user, policy.can_mark_referral_completion(user), "consilium_referral_completion")


def _require_access(conn: sqlite3.Connection, user: policy.CurrentUser) -> None:
    _require(conn, user, policy.can_access_consilium(user), "consilium_access")


def _require_booking(conn: sqlite3.Connection, user: policy.CurrentUser) -> None:
    _require(conn, user, policy.can_book_consilium(user), "consilium_booking")


def _validated_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        strict_iso_date(value)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="date must be YYYY-MM-DD") from exc
    return value


def _require_writable_patient(
    conn: sqlite3.Connection, user: policy.CurrentUser, patient_id: str
) -> None:
    if not policy.can_read_patient(conn, user, patient_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient not found")
    # Одно чтение области: повторный can_write_patient мог бы увидеть уже
    # закоммиченную смену лечащего врача и ответить 403 вместо 404 (WP2.3-B2).
    # Окончательная проверка — внутри транзакции записи.
    if not policy.can_write_patient_data(user):
        audit.record(
            conn, audit.ACCESS_DENIED, result=audit.RESULT_DENIED,
            detail="action=consilium_appointment_write", **audit.actor_ctx(user),
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def _required_audit(conn: sqlite3.Connection, user: policy.CurrentUser, event_type: str, *, with_round: bool = False):
    """Обязательный аудит решения председателя в транзакции самого перехода.

    Пациент и номер раунда читаются той же транзакцией, что и изменение.
    Ошибка записи аудита откатывает переход (AuditWriteFailed → 503)."""
    def hook(appointment_id: str) -> None:
        row = conn.execute(
            "SELECT patient_id, revision_count FROM oncology_consilium_appointments WHERE id = ?", (appointment_id,)
        ).fetchone()
        audit.record_required_or_fail(
            conn, event_type, patient_id=row["patient_id"],
            detail=f"revision_round={row['revision_count']}" if with_round else None,
            **audit.actor_ctx(user))
    return hook


def _audit_unavailable(what: str = "Запись консилиума не изменена"):
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"Не удалось сохранить изменение вместе с записью журнала аудита. {what}, повторите попытку позже",
    )


def _database_busy(exc: sqlite3.OperationalError, what: str = "Запись консилиума не изменена"):
    """503 только для ожидаемой блокировки SQLite (SQLITE_BUSY/SQLITE_LOCKED,
    включая расширенные коды): транзакция уже откатана, запрос можно повторить.
    Любая другая ошибка SQL — дефект, она не маскируется и уходит дальше (500)."""
    code = getattr(exc, "sqlite_errorcode", None)
    if code is None or (code & 0xFF) not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
        raise exc
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=f"База данных временно занята. {what}, повторите попытку",
    ) from exc


def _version_conflict(exc: consilium.ConsiliumVersionConflict) -> JSONResponse:
    """409 устаревшей версии (WP2.3-B1): detail — готовый текст для интерфейса,
    code — для кнопки «Обновить данные». Данные не изменены, аудита нет."""
    return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": str(exc), "code": exc.code})


def _detail(**facts) -> str:
    """Технический detail аудита расписания: только id, дата, время, группа и
    счётчики (значения проверены моделью или взяты из БД), без ФИО, диагнозов
    и комментариев. Формат key=value;… как у остальных событий."""
    return ";".join(f"{key}={str(value).lower() if isinstance(value, bool) else value}" for key, value in facts.items())


def _schedule_audit(conn: sqlite3.Connection, user: policy.CurrentUser, event_type: str, render):
    """Обязательный аудит операции расписания в её транзакции (WP2.3-A).

    render(facts) → (patient_id, detail). Ошибка записи аудита — AuditWriteFailed:
    вся операция откатывается, маршрут отвечает 503."""
    def hook(facts: dict) -> None:
        patient_id, detail = render(facts)
        audit.record_required_or_fail(conn, event_type, patient_id=patient_id, detail=detail, **audit.actor_ctx(user))
    return hook


def _slot_detail(facts: dict, **prefix) -> tuple[str | None, str]:
    return facts.get("patient_id"), _detail(
        **prefix, appointment_id=facts["appointment_id"],
        slot_date=facts["date"], slot_time=facts["time"], group=facts["group"],
    )


@router.get("/meta")
def get_consilium_meta(
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_access(conn, user)
    return consilium.metadata()


@router.get("/appointments")
def list_consilium_appointments(
    archived: bool = Query(False),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_access(conn, user)
    return {"appointments": consilium.list_for_user(conn, user, archived=archived)}


@router.get("/booked-patients")
def list_booked_consilium_patients(
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_booking(conn, user)
    return {"patientIds": consilium.booked_patient_ids(conn, user)}


@router.get("/schedule")
def list_consilium_schedule(
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_access(conn, user)
    return {"slots": consilium.schedule_slots(conn, user)}


@router.post("/schedule/generate", dependencies=[Depends(require_csrf), _SCHEDULE_LIMIT])
def generate_consilium_schedule(
    body: ConsiliumScheduleGenerateIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_manage(conn, user)
    hook = _schedule_audit(conn, user, audit.CONSILIUM_SCHEDULE_GENERATED, lambda f: (None, _detail(
        created=f["created"], interval=f["interval"], slot_date=f["date"], group=f["group"],
        start=f["start"], end=f["end"], skipped_past=f["skipped_past"],
    )))
    try:
        result = consilium.generate_schedule(
            conn, user, body.scheduledDate, body.consiliumGroup,
            body.startTime, body.endTime, body.intervalMinutes, audit_hook=hook,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable("Расписание не изменено")
    except sqlite3.OperationalError as exc:
        _database_busy(exc, "Расписание не изменено")
    # skippedPast — время сегодняшнего интервала, которое уже прошло по Москве:
    # такие слоты не создаются (WP2.3-B2).
    return {"created": result["created"], "skippedPast": result["skippedPast"],
            "slots": consilium.schedule_slots(conn, user)}


@router.post("/schedule/backdated", dependencies=[Depends(require_csrf), _SCHEDULE_LIMIT],
             status_code=status.HTTP_201_CREATED)
def create_backdated_consilium_slot(
    body: ConsiliumBackdatedSlotIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    """«Создать слот задним числом» (WP2.3-B3): только председатель, прошедшие
    дата и время по Москве, обязательная причина. Текст причины — в отдельной
    таблице, в аудите только reason_id."""
    _require(conn, user, policy.can_create_backdated_slot(user), "consilium_backdated_slot")
    hook = _schedule_audit(conn, user, audit.CONSILIUM_BACKDATED_SLOT_CREATED, lambda f: (None, _detail(
        slot_id=f["slot_id"], slot_date=f["date"], slot_time=f["time"], group=f["group"], reason_id=f["reason_id"],
    )))
    try:
        slot = consilium.create_backdated_slot(
            conn, user, body.scheduledDate, body.scheduledTime, body.consiliumGroup, body.reason, audit_hook=hook)
    except consilium.ConsiliumAccessLost:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable("Слот не создан")
    except sqlite3.OperationalError as exc:
        _database_busy(exc, "Слот не создан")
    return slot


@router.get("/schedule/{slot_id}/backdating")
def read_backdated_slot_reason(
    slot_id: str,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    """Причина исторического слота — только председатель; чтение в аудите."""
    _require(conn, user, user.role_id == policy.ROLE_CONSILIUM_CHAIR, "consilium_backdating_reason")
    hook = _schedule_audit(conn, user, audit.CONSILIUM_BACKDATING_REASON_VIEWED,
                           lambda f: (None, _detail(slot_id=f["slot_id"])))
    try:
        result = consilium.backdating_reason_for_slot(conn, user, slot_id, audit_hook=hook)
    except audit.AuditWriteFailed:
        _audit_unavailable("Причина не показана")
    except sqlite3.OperationalError as exc:
        _database_busy(exc, "Причина не показана")
    if result is None:
        _not_found()
    return result


@router.delete("/schedule/{slot_id}", dependencies=[Depends(require_csrf), _WRITE_LIMIT])
def delete_consilium_schedule_slot(
    slot_id: str,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_manage(conn, user)
    hook = _schedule_audit(conn, user, audit.CONSILIUM_SCHEDULE_SLOT_DELETED, lambda f: (None, _detail(
        slot_id=f["slot_id"], slot_date=f["date"], slot_time=f["time"], group=f["group"],
    )))
    try:
        deleted = consilium.delete_schedule_slot(conn, slot_id, audit_hook=hook)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable("Слот не удален")
    except sqlite3.OperationalError as exc:
        _database_busy(exc, "Слот не удален")
    if not deleted:
        _not_found()
    return {"deleted": True}


@router.post("/appointments/{appointment_id}/archive", dependencies=[Depends(require_csrf), _WRITE_LIMIT])
def archive_consilium_appointment(
    appointment_id: str,
    body: ConsiliumVersionIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_booking(conn, user)
    hook = _schedule_audit(conn, user, audit.CONSILIUM_ARCHIVED, _slot_detail)
    try:
        appointment = consilium.set_archived(conn, user, appointment_id, True, body.version, audit_hook=hook)
    except consilium.ConsiliumVersionConflict as exc:
        return _version_conflict(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable()
    except sqlite3.OperationalError as exc:
        _database_busy(exc)
    if appointment is None:
        _not_found()
    return appointment


@router.post("/appointments/{appointment_id}/restore", dependencies=[Depends(require_csrf), _WRITE_LIMIT])
def restore_consilium_appointment(
    appointment_id: str,
    body: ConsiliumVersionIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_booking(conn, user)
    hook = _schedule_audit(conn, user, audit.CONSILIUM_RESTORED, _slot_detail)
    try:
        appointment = consilium.set_archived(conn, user, appointment_id, False, body.version, audit_hook=hook)
    except consilium.ConsiliumVersionConflict as exc:
        return _version_conflict(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable()
    except sqlite3.OperationalError as exc:
        _database_busy(exc)
    if appointment is None:
        _not_found()
    return appointment


@router.post(
    "/appointments",
    dependencies=[Depends(require_csrf), _WRITE_LIMIT],
    status_code=status.HTTP_201_CREATED,
)
def create_consilium_appointment(
    body: ConsiliumAppointmentIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_booking(conn, user)
    _require_writable_patient(conn, user, body.patientId)
    hook = _schedule_audit(conn, user, audit.CONSILIUM_APPOINTMENT_CREATED, _slot_detail)
    try:
        appointment = consilium.create(conn, user, body, audit_hook=hook)
    except consilium.ConsiliumAccessLost:
        # Пациент вышел из области сотрудника, пока запрос ждал блокировку.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient not found")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable("Запись на консилиум не создана")
    except sqlite3.OperationalError as exc:
        _database_busy(exc, "Запись на консилиум не создана")
    return appointment


@router.post(
    "/appointments/backdated",
    dependencies=[Depends(require_csrf), _WRITE_LIMIT],
    status_code=status.HTTP_201_CREATED,
)
def create_backdated_consilium_appointment(
    body: ConsiliumBackdatedAppointmentIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    """«Оформить консилиум задним числом» (WP2.3-B3): только заведующий, пациент
    своего отделения, исторический слот председателя, обязательная причина."""
    _require(conn, user, policy.can_backdate_consilium(user), "consilium_backdated_appointment")
    _require_writable_patient(conn, user, body.patientId)
    hook = _schedule_audit(conn, user, audit.CONSILIUM_BACKDATED_APPOINTMENT_CREATED, lambda f: (f["patient_id"], _detail(
        appointment_id=f["appointment_id"], slot_id=f["slot_id"], slot_date=f["date"], slot_time=f["time"],
        group=f["group"], reason_id=f["reason_id"],
    )))
    try:
        appointment = consilium.create_backdated(conn, user, body, audit_hook=hook)
    except consilium.ConsiliumAccessLost:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient not found")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable("Запись на консилиум не создана")
    except sqlite3.OperationalError as exc:
        _database_busy(exc, "Запись на консилиум не создана")
    return appointment


@router.get("/appointments/{appointment_id}/backdating")
def read_backdating_reasons(
    appointment_id: str,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    """Причины записи задним числом и ее исторического слота: председатель —
    любая запись, заведующий — записи своих отделений. Врач видит только отметку
    в записи (403), остальные роли — 403. Чужая или обычная запись — 404."""
    _require(conn, user, policy.can_read_backdating_reasons(user), "consilium_backdating_reason")
    hook = _schedule_audit(conn, user, audit.CONSILIUM_BACKDATING_REASON_VIEWED,
                           lambda f: (f["patient_id"], _detail(appointment_id=f["appointment_id"])))
    try:
        result = consilium.backdating_reasons_for_appointment(conn, user, appointment_id, audit_hook=hook)
    except audit.AuditWriteFailed:
        _audit_unavailable("Причина не показана")
    except sqlite3.OperationalError as exc:
        _database_busy(exc, "Причина не показана")
    if result is None:
        _not_found()
    return result


@router.put("/appointments/{appointment_id}", dependencies=[Depends(require_csrf), _WRITE_LIMIT])
def update_consilium_appointment(
    appointment_id: str,
    body: ConsiliumAppointmentUpdateIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_booking(conn, user)
    existing = consilium.get_manageable(conn, user, appointment_id)
    if existing is None:
        _not_found()
    _require_writable_patient(conn, user, body.patientId)
    hook = _schedule_audit(conn, user, audit.CONSILIUM_APPOINTMENT_UPDATED, lambda f: (f["patient_id"], _detail(
        appointment_id=f["appointment_id"], group=f["group"],
        from_date=f["from_date"], from_time=f["from_time"], to_date=f["to_date"], to_time=f["to_time"],
        slot_changed=f["slot_changed"],
    )))
    try:
        appointment = consilium.update(conn, user, appointment_id, body, audit_hook=hook)
    except consilium.ConsiliumVersionConflict as exc:
        return _version_conflict(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable()
    except sqlite3.OperationalError as exc:
        _database_busy(exc)
    if appointment is None:
        _not_found()
    return appointment


@router.delete("/appointments/{appointment_id}", dependencies=[Depends(require_csrf), _WRITE_LIMIT])
def delete_consilium_appointment(
    appointment_id: str,
    version: int = Query(..., ge=1, le=2**63 - 1),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_booking(conn, user)
    hook = _schedule_audit(conn, user, audit.CONSILIUM_APPOINTMENT_DELETED, lambda f: _slot_detail(
        f, **({"mode": "soft", "history_preserved": True} if f["soft"] else {"mode": "hard"})))
    try:
        appointment = consilium.delete_owned(conn, user, appointment_id, version, audit_hook=hook)
    except consilium.ConsiliumVersionConflict as exc:
        return _version_conflict(exc)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable()
    except sqlite3.OperationalError as exc:
        _database_busy(exc)
    if appointment is None:
        _not_found()
    return {"deleted": True, "historyPreserved": appointment["historyPreserved"], "releasedSlot": {
        "scheduledDate": appointment["scheduledDate"],
        "scheduledTime": appointment["scheduledTime"],
        "consiliumGroup": appointment["consiliumGroup"],
    }}


@router.post("/appointments/{appointment_id}/resubmit", dependencies=[Depends(require_csrf), _WRITE_LIMIT])
def resubmit_consilium_appointment(
    appointment_id: str,
    body: ConsiliumVersionIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    """«Отправить на повторное рассмотрение» (WP2.3-B1): отдельное действие
    после доработки; правка и перенос статус needs_revision не меняют."""
    _require_booking(conn, user)
    hook = _schedule_audit(conn, user, audit.CONSILIUM_RESUBMITTED, lambda f: (f["patient_id"], _detail(
        appointment_id=f["appointment_id"], round=f["round"],
    )))
    try:
        appointment = consilium.resubmit(conn, user, appointment_id, body.version, audit_hook=hook)
    except consilium.ConsiliumVersionConflict as exc:
        return _version_conflict(exc)
    except consilium.ConsiliumStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable()
    except sqlite3.OperationalError as exc:
        _database_busy(exc)
    if appointment is None:
        _not_found()
    return appointment


@router.post("/appointments/{appointment_id}/review", dependencies=[Depends(require_csrf), _DECISION_LIMIT])
def start_consilium_review(
    appointment_id: str,
    body: ConsiliumVersionIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_decision(conn, user)
    try:
        appointment = consilium.start_review(
            conn, user, appointment_id, body.version,
            audit_hook=_required_audit(conn, user, audit.CONSILIUM_REVIEW_STARTED))
    except consilium.ConsiliumAccessLost:
        raise session_context.ContextChanged("ACCESS_CONTEXT_CHANGED") from None
    except consilium.ConsiliumVersionConflict as exc:
        return _version_conflict(exc)
    except consilium.ConsiliumStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable()
    except sqlite3.OperationalError as exc:
        _database_busy(exc)
    if appointment is None:
        _not_found()
    return appointment


@router.post("/appointments/{appointment_id}/sign", dependencies=[Depends(require_csrf), _DECISION_LIMIT])
def sign_consilium(
    appointment_id: str,
    body: ConsiliumDecisionIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_decision(conn, user)
    try:
        appointment = consilium.sign(
            conn, user, appointment_id, body.version, body.treatmentType, body.treatmentScheme,
            body.treatmentSchemeCode, body.goc, body.goc65Plus,
            audit_hook=_required_audit(conn, user, audit.CONSILIUM_SIGNED),
        )
    except consilium.ConsiliumAccessLost:
        raise session_context.ContextChanged("ACCESS_CONTEXT_CHANGED") from None
    except consilium.ConsiliumVersionConflict as exc:
        return _version_conflict(exc)
    except consilium.ConsiliumStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable()
    except sqlite3.OperationalError as exc:
        _database_busy(exc)
    if appointment is None:
        _not_found()
    return appointment


@router.post("/appointments/{appointment_id}/return", dependencies=[Depends(require_csrf), _DECISION_LIMIT])
def return_consilium_for_revision(
    appointment_id: str,
    body: ConsiliumRevisionIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_decision(conn, user)
    try:
        # Текст комментария в аудит не пишется: он может содержать сведения о пациенте.
        appointment = consilium.return_for_revision(
            conn, user, appointment_id, body.version, body.comment,
            audit_hook=_required_audit(conn, user, audit.CONSILIUM_RETURNED, with_round=True))
    except consilium.ConsiliumCommentError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    except consilium.ConsiliumAccessLost:
        raise session_context.ContextChanged("ACCESS_CONTEXT_CHANGED") from None
    except consilium.ConsiliumVersionConflict as exc:
        return _version_conflict(exc)
    except consilium.ConsiliumStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except audit.AuditWriteFailed:
        _audit_unavailable()
    except sqlite3.OperationalError as exc:
        _database_busy(exc)
    if appointment is None:
        _not_found()
    return appointment


@router.get("/appointments/{appointment_id}/revisions")
def consilium_revision_history(
    appointment_id: str,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    """Texts of every return round: only for the chair and for whoever manages
    the record (doctor — own patients, head — own departments; WP2.3-B2);
    anyone else gets 404, as for a record they cannot see. Comments are never
    written to the audit log."""
    _require_access(conn, user)
    if policy.can_decide_consilium(user):
        if consilium.get_for_management(conn, appointment_id) is None:
            _not_found()
    elif consilium.get_manageable(conn, user, appointment_id) is None:
        _not_found()
    return {"revisions": consilium.revision_history(conn, appointment_id)}


@router.get("/analytics")
def consilium_analytics(
    date_from: str | None = Query(None, max_length=10),
    date_to: str | None = Query(None, max_length=10),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_manage(conn, user)
    return consilium.analytics_summary(conn, _validated_date(date_from), _validated_date(date_to))


@router.post("/favorites/{patient_id}", dependencies=[Depends(require_csrf), _WRITE_LIMIT])
def add_consilium_favorite(
    patient_id: str,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_favorites(conn, user)
    linked = conn.execute(
        "SELECT 1 FROM oncology_consilium_appointments WHERE patient_id = ? AND deleted_at IS NULL",
        (patient_id,),
    ).fetchone()
    if linked is None or not consilium.add_favorite(conn, user, patient_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient not found")
    audit.record(
        conn, audit.CONSILIUM_FAVORITE_ADDED, patient_id=patient_id,
        **audit.actor_ctx(user),
    )
    return {"patientId": patient_id, "favorite": True}


@router.delete("/favorites/{patient_id}", dependencies=[Depends(require_csrf), _WRITE_LIMIT])
def remove_consilium_favorite(
    patient_id: str,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_favorites(conn, user)
    consilium.remove_favorite(conn, user, patient_id)
    audit.record(
        conn, audit.CONSILIUM_FAVORITE_REMOVED, patient_id=patient_id,
        **audit.actor_ctx(user),
    )
    return {"patientId": patient_id, "favorite": False}


@router.post("/appointments/{appointment_id}/referral-completion", dependencies=[Depends(require_csrf), _DECISION_LIMIT])
def set_surgical_referral_completion(
    appointment_id: str,
    body: ConsiliumRegistryCompletionIn,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_referral_mark(conn, user)
    try:
        appointment = consilium.set_referral_completed(
            conn, user, appointment_id, body.completed
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    if appointment is None:
        _not_found()
    audit.record(
        conn, audit.CONSILIUM_REFERRAL_COMPLETED,
        patient_id=appointment["patientId"],
        detail=f"completed={str(body.completed).lower()}",
        **audit.actor_ctx(user),
    )
    return appointment


@router.get("/registries")
def treatment_registries(
    date: str | None = Query(None, max_length=10),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_manage(conn, user)
    selected_date = _validated_date(date)
    return {
        "surgical": consilium.registry_rows(conn, "surgery", selected_date),
        "chemotherapy": consilium.registry_rows(conn, "chemotherapy", selected_date),
        "goc": consilium.goc_registry_rows(conn, "goc", selected_date),
        "goc65Plus": consilium.goc_registry_rows(conn, "goc_65_plus", selected_date),
    }


_TREATMENT_HEADER = [
    "Дата", "Время", "Пациент", "Полис ОМС", "Диагноз",
    "Назначенное лечение", "Схема лечения", "Лечащий врач", "Консилиумная группа",
]


def _registry_xlsx(
    conn: sqlite3.Connection,
    user: policy.CurrentUser,
    *,
    registry: str,
    date: str | None,
    sheet_name: str,
    filename: str,
    header: list[str],
    items: list[dict],
    columns: tuple[str, ...],
) -> Response:
    """Build the workbook and log the export.

    The audit row holds only the registry, the date filter and the row
    count: never names, policy numbers or diagnoses from the file.
    """
    rows: list[list[object]] = [header, *[[item[c] for c in columns] for item in items]]
    content = workbook_bytes(sheet_name, rows)
    suffix = date or "all"
    # WP-C (AUD-06): запись аудита фиксируется до выдачи файла с ПДн.
    audit.record_committed_or_fail(
        conn, audit.CONSILIUM_REGISTRY_EXPORTED,
        release_objects=[obj for item in items for obj in (
            {'type': 'patient', 'id': item['patientId']},
            {'type': 'appointment', 'id': item['id']},
        )],
        detail=f"registry={registry};date={suffix};row_count={len(items)};format=xlsx",
        **audit.actor_ctx(user),
    )
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}_{suffix}.xlsx"'},
    )


# GET с обязательным X-CSRF-Token, как /api/export: файл содержит ПДн, а
# межсайтовая навигация верхнего уровня не может задать заголовок.
@router.get("/registries/chemotherapy.xlsx", dependencies=[Depends(require_csrf), _EXPORT_LIMIT])
def export_chemotherapy_registry(
    date: str | None = Query(None, max_length=10),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_manage(conn, user)
    selected_date = _validated_date(date)
    return _registry_xlsx(
        conn, user, registry="chemotherapy", date=selected_date,
        sheet_name="Химиотерапия", filename="chemotherapy_registry",
        header=[
            "Дата", "Время", "Пациент", "Полис ОМС", "Диагноз",
            "Код схемы", "Схема лечения", "Лечащий врач", "Консилиумная группа",
        ],
        items=consilium.registry_rows(conn, "chemotherapy", selected_date),
        columns=(
            "scheduledDate", "scheduledTime", "patientName", "policyNumber", "primaryDiagnosis",
            "treatmentSchemeCode", "treatmentScheme", "treatingDoctorName", "consiliumGroupLabel",
        ),
    )


_GOC_COLUMNS = (
    "scheduledDate", "scheduledTime", "patientName", "policyNumber", "primaryDiagnosis",
    "treatmentTypeLabel", "treatmentScheme", "treatingDoctorName", "consiliumGroupLabel",
)


@router.get("/registries/goc.xlsx", dependencies=[Depends(require_csrf), _EXPORT_LIMIT])
def export_goc_registry(
    date: str | None = Query(None, max_length=10),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_manage(conn, user)
    selected_date = _validated_date(date)
    return _registry_xlsx(
        conn, user, registry="goc", date=selected_date,
        sheet_name="ГОК", filename="goc_registry", header=_TREATMENT_HEADER,
        items=consilium.goc_registry_rows(conn, "goc", selected_date), columns=_GOC_COLUMNS,
    )


@router.get("/registries/goc-65-plus.xlsx", dependencies=[Depends(require_csrf), _EXPORT_LIMIT])
def export_goc_65_plus_registry(
    date: str | None = Query(None, max_length=10),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    _require_manage(conn, user)
    selected_date = _validated_date(date)
    return _registry_xlsx(
        conn, user, registry="goc_65_plus", date=selected_date,
        sheet_name="ГОК 65+", filename="goc_65_plus_registry", header=_TREATMENT_HEADER,
        items=consilium.goc_registry_rows(conn, "goc_65_plus", selected_date), columns=_GOC_COLUMNS,
    )
