"""Personal oncology-consilium appointment scheduling."""
from __future__ import annotations

import re
import sqlite3
import uuid
import json
from datetime import date as date_type, datetime, timedelta
from pathlib import Path

from .. import clock, policy
from ..db import now_iso, transaction
from ..models import ConsiliumAppointmentIn, ConsiliumAppointmentUpdateIn, strict_iso_date


GROUPS = (
    ("general", "Общеонкологическая"),
    ("thoracic", "Торакальная"),
    ("abdominal", "Абдоминальная"),
    ("colorectal", "Колопроктологическая"),
    ("breast", "Маммологическая"),
    ("urology", "Онкоурологическая"),
    ("gynecology", "Онкогинекологическая"),
    ("head_neck", "Опухоли головы и шеи"),
)
GROUP_LABELS = dict(GROUPS)
TIME_SLOTS = tuple(f"{hour:02d}:{minute:02d}" for hour in range(9, 17) for minute in (0, 30))
STATUS_LABELS = {
    "recorded": "Записан",
    "in_review": "На рассмотрении",
    "needs_revision": "На доработке",
    "revised": "Возвращен с доработки",
    "signed": "Подписан",
}
TREATMENT_LABELS = {
    "radiotherapy": "Лучевая терапия",
    "chemotherapy": "Химиотерапевтическое лечение",
    "surgery": "Хирургическое лечение",
    "active_observation": "Активное наблюдение",
    "dispensary_observation": "Диспансерное наблюдение",
}
class ConsiliumStateError(ValueError):
    """The requested transition is not allowed from the record's current state."""


class ConsiliumAccessLost(Exception):
    """The current user no longer has authority to perform the operation."""


VERSION_CONFLICT_CODE = "consilium_version_conflict"
VERSION_CONFLICT_MESSAGE = (
    "Данные записи изменились. Пока вы редактировали запись, ее обновили. "
    "Обновите данные и повторите действие"
)


class ConsiliumVersionConflict(Exception):
    """The client acted on an outdated version of the record (WP2.3-B1).

    Not a ValueError: routes answer 409 with the code before any state check."""
    code = VERSION_CONFLICT_CODE

    def __init__(self) -> None:
        super().__init__(VERSION_CONFLICT_MESSAGE)


def _require_version(existing: dict, expected_version: int) -> None:
    """Called inside the operation's transaction, before any state check."""
    if existing["version"] != expected_version:
        raise ConsiliumVersionConflict()


# Хранимый status: recorded → in_review → signed. Возврат на доработку
# оставляет status = 'recorded' с revision_comment; пока врач не отправил
# исправления (revision_submitted_at IS NULL), рассмотрение начать нельзя.
_AWAITING_CHAIR = (
    "status = 'recorded' AND deleted_at IS NULL"
    " AND (revision_comment IS NULL OR revision_submitted_at IS NOT NULL)"
)


def public_status(row: sqlite3.Row) -> str:
    if row["status"] == "signed":
        return "signed"
    if row["status"] == "in_review":
        return "in_review"
    if row["revision_comment"]:
        return "revised" if row["revision_submitted_at"] else "needs_revision"
    return "recorded"


TREATMENT_SCHEMES = json.loads(
    (Path(__file__).resolve().parent.parent / "data" / "treatment_schemes.json").read_text(encoding="utf-8")
)


def metadata() -> dict:
    now = clock.now_moscow()
    return {
        "groups": [{"value": value, "label": label} for value, label in GROUPS],
        # Прежнее поле контракта; клиент не использует его как источник слотов
        # (WP2.3-B2): свободные слоты — только из расписания председателя.
        "timeSlots": list(TIME_SLOTS),
        "treatmentSchemes": TREATMENT_SCHEMES,
        "institutionTimezone": clock.INSTITUTION_TIMEZONE,
        "institutionNow": now.isoformat(timespec="seconds"),
        "institutionToday": now.date().isoformat(),
    }


def _to_dict(row: sqlite3.Row, *, favorite: bool = False) -> dict:
    status = public_status(row)
    return {
        "id": row["id"],
        "patientId": row["patient_id"],
        "patientName": row["patient_name"],
        "scheduledDate": row["scheduled_date"],
        "scheduledTime": row["scheduled_time"],
        "consiliumGroup": row["consilium_group"],
        "consiliumGroupLabel": GROUP_LABELS.get(row["consilium_group"], row["consilium_group"]),
        "hasBenefit": bool(row["has_benefit"]),
        "policyNumber": row["policy_number"] or row["patient_policy_number"] or "",
        "diagnosisLocalization": row["diagnosis_localization"] or "",
        # Подписанное решение хранит лечащего врача на момент подписи; текущий
        # врач пациента — отдельным полем, без подмены исторических данных.
        "treatingDoctorName": (
            row["signed_treating_doctor_name"]
            if row["status"] == "signed" and row["signed_treating_doctor_name"]
            else row["current_treating_doctor_name"]
        ),
        "currentTreatingDoctorName": row["current_treating_doctor_name"],
        # Этап маршрута, к которому относится подписанное решение (исторический,
        # не текущий этап пациента). source: recorded — записан при подписи;
        # derived — восстановлен миграцией по истории; unknown — не установлен.
        "routeContext": ({
            "stage": row["signed_route_stage"],
            "historyEntryId": row["signed_route_history_entry_id"],
            "enteredAt": row["signed_route_entered_at"],
            "source": row["signed_route_link_source"],
        } if status == "signed" else None),
        "primaryDiagnosis": row["primary_diagnosis"],
        "additionalDiagnosis": row["additional_diagnosis"] or "",
        "comment": row["comment"] or "",
        "additionalParticipant": row["additional_participant"] or "",
        "needsSurgeon": bool(row["needs_surgeon"]),
        "needsRadiotherapist": bool(row["needs_radiotherapist"]),
        "status": status,
        "statusLabel": STATUS_LABELS.get(status, status),
        "treatmentType": row["treatment_type"] or "",
        "treatmentTypeLabel": TREATMENT_LABELS.get(row["treatment_type"], "") if row["treatment_type"] else "",
        "treatmentScheme": row["treatment_scheme"] or "",
        "treatmentSchemeCode": row["treatment_scheme_code"] or "",
        "goc": bool(row["goc"]),
        "goc65Plus": bool(row["goc_65_plus"]),
        "uvRuv": bool(row["uv_ruv"]),
        "revisionComment": row["revision_comment"] or "",
        "revisionCount": row["revision_count"],
        "reviewStartedAt": row["review_started_at"],
        "signedAt": row["signed_at"],
        "referralCompleted": bool(row["referral_completed_at"]),
        "referralCompletedAt": row["referral_completed_at"],
        "archived": bool(row["archived_at"]),
        "archivedAt": row["archived_at"],
        "archivedByUserId": row["archived_by_user_id"],
        "isFavorite": favorite,
        "version": row["version"],
        # Запись без слота председателя (старые данные): показывается отдельно,
        # не удаляется и не переносится автоматически (WP2.3-B2).
        "outsideSchedule": not row["in_schedule"],
        # WP2.3-B3: отметка оформления задним числом (без текста причины).
        # createdAt — фактическое время внесения, scheduledDate/Time — дата проведения.
        "backdated": bool(row["backdated"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


# Лечащий врач — из актуальной карточки пациента (как в store.patient_to_dict),
# а не автор записи: запись может создать заведующий, пациента могут передать
# другому врачу. a.treating_doctor_name — снимок на момент записи, запасной.
_SELECT = """
    SELECT a.*, patients.name AS patient_name,
           patients.policy_number AS patient_policy_number,
           COALESCE(treating_doctor.full_name, NULLIF(patients.doctor, ''), a.treating_doctor_name)
               AS current_treating_doctor_name,
           EXISTS (
               SELECT 1 FROM consilium_schedule_slots s
               WHERE s.scheduled_date = a.scheduled_date AND s.scheduled_time = a.scheduled_time
                 AND s.consilium_group = a.consilium_group
           ) AS in_schedule
    FROM oncology_consilium_appointments a
    JOIN patients ON patients.id = a.patient_id AND a.deleted_at IS NULL
    LEFT JOIN users treating_doctor ON treating_doctor.id = patients.treating_doctor_user_id
"""


def _current_treating_doctor_name(conn: sqlite3.Connection, patient_id: str) -> str:
    row = conn.execute(
        """SELECT COALESCE(treating_doctor.full_name, NULLIF(patients.doctor, ''), '') AS name
           FROM patients
           LEFT JOIN users treating_doctor ON treating_doctor.id = patients.treating_doctor_user_id
           WHERE patients.id = ?""",
        (patient_id,),
    ).fetchone()
    return row["name"] if row else ""


def list_for_user(
    conn: sqlite3.Connection, user: policy.CurrentUser, *, archived: bool = False
) -> list[dict]:
    if user.role_id == policy.ROLE_CONSILIUM_CHAIR:
        rows = conn.execute(
            _SELECT + " ORDER BY a.scheduled_date ASC, a.scheduled_time ASC, a.created_at ASC"
        ).fetchall()
        favorite_ids = {
            row["patient_id"] for row in conn.execute(
                "SELECT patient_id FROM consilium_chair_favorites WHERE user_id = ?",
                (user.id,),
            ).fetchall()
        }
        return [_to_dict(row, favorite=row["patient_id"] in favorite_ids) for row in rows]
    # Врач — записи своих пациентов, заведующий — пациентов своих отделений,
    # кто бы их ни создал (WP2.3-B2). Архив — общее состояние записи: архивная
    # запись видна в архиве каждому, кто управляет ею, и не видна в работе.
    condition, params = policy.consilium_record_filter(user)
    visibility_clause = "AND a.archived_at IS NOT NULL " if archived else "AND a.archived_at IS NULL "
    rows = conn.execute(
        _SELECT + f" WHERE {condition} "
        + visibility_clause
        + "ORDER BY a.scheduled_date ASC, a.scheduled_time ASC, a.created_at ASC",
        params,
    ).fetchall()
    return [_to_dict(row) for row in rows]


def booked_patient_ids(conn: sqlite3.Connection, user: policy.CurrentUser) -> list[str]:
    """Visible patients with an unfinished appointment: they cannot be booked
    again until it is signed (v22). Signed and deleted records do not block."""
    condition, params = policy.patient_scope_filter(user)
    rows = conn.execute(
        """SELECT DISTINCT a.patient_id
           FROM oncology_consilium_appointments a
           JOIN patients ON patients.id = a.patient_id AND a.deleted_at IS NULL AND a.status != 'signed'
           WHERE """ + condition,  # nosec B608 - scope condition is generated by policy; values are bound.
        params,
    ).fetchall()
    return [row["patient_id"] for row in rows]


def set_archived(
    conn: sqlite3.Connection,
    user: policy.CurrentUser,
    appointment_id: str,
    archived: bool,
    expected_version: int,
    *,
    audit_hook=None,
) -> dict | None:
    """Move a signed record to the shared archive, or back (WP2.3-B2: any
    staff member who manages the record — the archive is the record's state).

    Only archived_at / archived_by_user_id (and updated_at) change; the signed
    decision itself is protected by trg_consilium_signed_immutable. Who
    archived and restored, and when, stays in the audit log.
    """
    now = now_iso()
    # Проверка прав и состояния, изменение, обязательный аудит и ответ — одна
    # транзакция BEGIN IMMEDIATE: при сбое аудита архивная отметка откатывается,
    # а ответ не перечитывается после коммита (WP2.3-B2, B2-01).
    with transaction(conn):
        fresh = _locked_user(conn, user)
        existing = get_manageable(conn, fresh, appointment_id) if fresh else None
        if existing is None:
            return None
        _require_version(existing, expected_version)
        if existing["status"] != "signed":
            raise ConsiliumStateError("Архивировать можно только подписанное решение")
        if archived:
            cursor = conn.execute(
                """UPDATE oncology_consilium_appointments
                   SET archived_at = ?, archived_by_user_id = ?, updated_at = ?
                   WHERE id = ? AND status = 'signed' AND archived_at IS NULL AND version = ?""",
                (now, user.id, now, appointment_id, expected_version),
            )
        else:
            cursor = conn.execute(
                """UPDATE oncology_consilium_appointments
                   SET archived_at = NULL, archived_by_user_id = NULL, updated_at = ?
                   WHERE id = ? AND status = 'signed' AND archived_at IS NOT NULL AND version = ?""",
                (now, appointment_id, expected_version),
            )
        if cursor.rowcount == 0:
            raise ConsiliumStateError("Запись уже в архиве" if archived else "Запись не находится в архиве")
        if audit_hook is not None:
            audit_hook(_slot_facts(existing))
        result = _committed_result(conn, fresh, appointment_id)
    return result


def _slot_facts(item: dict) -> dict:
    """Technical facts of a record for the audit detail: ids and slot only."""
    return {
        "appointment_id": item["id"], "patient_id": item["patientId"],
        "date": item["scheduledDate"], "time": item["scheduledTime"], "group": item["consiliumGroup"],
    }


def get_for_management(conn: sqlite3.Connection, appointment_id: str) -> dict | None:
    row = conn.execute(_SELECT + " WHERE a.id = ?", (appointment_id,)).fetchone()
    return _to_dict(row) if row else None


def get_manageable(conn: sqlite3.Connection, user: policy.CurrentUser, appointment_id: str) -> dict | None:
    """The record if `user` manages it (policy.consilium_record_filter), else None.

    Inside a write transaction pass the user from _locked_user(): the scope
    is then the one committed at the moment of the change."""
    condition, params = policy.consilium_record_filter(user)
    row = conn.execute(
        _SELECT + f" WHERE a.id = ? AND {condition}",
        [appointment_id, *params],
    ).fetchone()
    return _to_dict(row) if row else None


def _locked_user(conn: sqlite3.Connection, user: policy.CurrentUser) -> policy.CurrentUser | None:
    """Permissions re-read inside BEGIN IMMEDIATE (WP2.3-B2): a treating doctor
    reassignment or a change of the head's departments that committed while
    the request waited for the lock is taken into account."""
    return policy.reload_current_user(conn, user)


def _manageable_locked(conn: sqlite3.Connection, user: policy.CurrentUser, appointment_id: str) -> dict | None:
    fresh = _locked_user(conn, user)
    return get_manageable(conn, fresh, appointment_id) if fresh else None


def _committed_result(conn: sqlite3.Connection, fresh: policy.CurrentUser, appointment_id: str) -> dict:
    """The response of a change, built inside its BEGIN IMMEDIATE transaction
    with the permissions checked there (WP2.3-B2, B2-01).

    Reading it again after the commit would apply a newer scope: a treating
    doctor reassigned in between would turn a committed change into 404 or
    null. Within the transaction the scope cannot change, so the record is
    always found; anything else is a defect and aborts the transaction."""
    result = get_manageable(conn, fresh, appointment_id)
    if result is None:
        raise RuntimeError("consilium record left the scope inside its own transaction")
    return result


def delete_owned(
    conn: sqlite3.Connection, user: policy.CurrentUser, appointment_id: str, expected_version: int,
    *, audit_hook=None,
) -> dict | None:
    """Delete an unsigned record that is not under review.

    A record that already went through a return round is only marked
    deleted: its return history (author, time, round, text) stays attached.
    A record made after the fact (backdated = 1, WP2.3-B3) is always only
    marked deleted: its id, consilium date, author and the link to its
    backdating reason stay. Either way it leaves every list, frees the slot
    and allows booking the patient again. Any other record without history
    is removed as before.
    """
    now = now_iso()
    with transaction(conn):
        existing = _manageable_locked(conn, user, appointment_id)
        if existing is None:
            return None
        _require_version(existing, expected_version)
        soft = existing["revisionCount"] > 0 or bool(existing.get("backdated"))
        if soft:
            cursor = conn.execute(
                """UPDATE oncology_consilium_appointments
                   SET deleted_at = ?, deleted_by_user_id = ?, updated_at = ?
                   WHERE id = ? AND status = 'recorded' AND deleted_at IS NULL AND version = ?""",
                (now, user.id, now, appointment_id, expected_version),
            )
        else:
            cursor = conn.execute(
                "DELETE FROM oncology_consilium_appointments "
                "WHERE id = ? AND status = 'recorded' AND deleted_at IS NULL AND version = ?",
                (appointment_id, expected_version),
            )
        existing["historyPreserved"] = soft
        if cursor.rowcount == 0:
            raise ConsiliumStateError(
                "Подписанная запись недоступна для удаления"
                if existing["status"] == "signed"
                else "Запись на рассмотрении у председателя недоступна для удаления"
            )
        if audit_hook is not None:
            audit_hook({**_slot_facts(existing), "soft": soft})
    return existing


def create(
    conn: sqlite3.Connection, user: policy.CurrentUser, body: ConsiliumAppointmentIn, *, audit_hook=None
) -> dict:
    """Book a patient on a slot.

    The patient and slot checks, the INSERT and the required audit row run
    in one BEGIN IMMEDIATE transaction (WP2.3-A): a concurrent slot deletion
    or booking waits for it instead of slipping between check and write.
    """
    appointment_id = uuid.uuid4().hex
    now = now_iso()
    try:
        with transaction(conn):
            fresh = _locked_user(conn, user)
            if fresh is None or not policy.can_write_patient(conn, fresh, body.patientId):
                raise ConsiliumAccessLost()
            patient = conn.execute(
                "SELECT policy_number, diagnosis FROM patients WHERE id = ?", (body.patientId,)
            ).fetchone()
            if patient is None:
                raise ValueError("Пациент не найден")
            _require_group_for_patient(patient["diagnosis"], body.consiliumGroup)
            _require_patient_not_booked(conn, body.patientId)
            policy_number = body.policyNumber or (patient["policy_number"] if patient else "") or None
            _require_available_slot(conn, body.scheduledDate, body.scheduledTime, body.consiliumGroup)
            conn.execute(
                """INSERT INTO oncology_consilium_appointments (
                   id, patient_id, created_by_user_id, scheduled_date, scheduled_time,
                   consilium_group, has_benefit, treating_doctor_name, policy_number, diagnosis_localization,
                   primary_diagnosis, additional_diagnosis, comment,
                   additional_participant, needs_surgeon, needs_radiotherapist, uv_ruv,
                   created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    appointment_id, body.patientId, user.id, body.scheduledDate,
                    body.scheduledTime, body.consiliumGroup, int(body.hasBenefit),
                    _current_treating_doctor_name(conn, body.patientId), policy_number,
                    body.diagnosisLocalization or None,
                    body.primaryDiagnosis, body.additionalDiagnosis or None,
                    body.comment or None, body.additionalParticipant or None,
                    int(body.needsSurgeon), int(body.needsRadiotherapist), int(body.uvRuv), now, now,
                ),
            )
            if audit_hook is not None:
                audit_hook({
                    "appointment_id": appointment_id, "patient_id": body.patientId,
                    "date": body.scheduledDate, "time": body.scheduledTime, "group": body.consiliumGroup,
                })
            # Ответ — в той же транзакции, с правами, проверенными в ней (B2-01).
            result = _committed_result(conn, fresh, appointment_id)
    except sqlite3.IntegrityError as exc:
        raise ValueError(_integrity_error_message(exc)) from exc
    return result


def _chair_record(conn: sqlite3.Connection, user: policy.CurrentUser, appointment_id: str,
                  expected_version: int) -> dict | None:
    """Recheck authority and the version under the same lock as the write."""
    fresh = _locked_user(conn, user)
    if fresh is None or fresh.must_change_password or not policy.can_decide_consilium(fresh):
        raise ConsiliumAccessLost()
    # The chair has the existing institution-wide consilium scope.
    record = get_for_management(conn, appointment_id)
    if record is not None:
        _require_version(record, expected_version)
    return record


def _transition(conn: sqlite3.Connection, user: policy.CurrentUser, appointment_id: str, expected_version: int,
                sql: str, params: tuple, refusal: str, audit_hook=None) -> dict | None:
    """Compare the version, apply the state transition, and record required audit together."""
    with transaction(conn):
        if _chair_record(conn, user, appointment_id, expected_version) is None:
            return None
        cursor = conn.execute(sql, params)
        if cursor.rowcount != 1:
            raise ConsiliumStateError(refusal)
        if audit_hook is not None:
            audit_hook(appointment_id)
        return get_for_management(conn, appointment_id)


def start_review(conn: sqlite3.Connection, user: policy.CurrentUser, appointment_id: str, expected_version: int,
                 *, audit_hook=None) -> dict | None:
    now = now_iso()
    return _transition(
        conn, user, appointment_id, expected_version,
        f"""UPDATE oncology_consilium_appointments
            SET status = 'in_review', review_started_at = ?, updated_at = ?
            WHERE id = ? AND {_AWAITING_CHAIR}""",
        (now, now, appointment_id),
        "Рассмотрение можно начать только для записи, ожидающей председателя",
        audit_hook,
    )


def sign(
    conn: sqlite3.Connection,
    user: policy.CurrentUser,
    appointment_id: str,
    expected_version: int,
    treatment_type: str,
    treatment_scheme: str,
    treatment_scheme_code: str,
    goc: bool,
    goc_65_plus: bool,
    *,
    audit_hook=None,
) -> dict | None:
    now = now_iso()
    return _transition(
        conn, user, appointment_id, expected_version,
        """UPDATE oncology_consilium_appointments
           SET status = 'signed', treatment_type = ?, treatment_scheme = ?, treatment_scheme_code = ?,
               goc = ?, goc_65_plus = ?,
               revision_comment = NULL, signed_at = ?, signed_by_user_id = ?, updated_at = ?,
               signed_treating_doctor_user_id = (
                   SELECT patients.treating_doctor_user_id FROM patients
                   WHERE patients.id = oncology_consilium_appointments.patient_id),
               signed_treating_doctor_name = (
                   SELECT COALESCE(treating_doctor.full_name, NULLIF(patients.doctor, ''),
                                   oncology_consilium_appointments.treating_doctor_name)
                   FROM patients
                   LEFT JOIN users treating_doctor ON treating_doctor.id = patients.treating_doctor_user_id
                   WHERE patients.id = oncology_consilium_appointments.patient_id),
               -- Контекст маршрута на момент подписи: текущий этап пациента и
               -- последняя запись его истории. Только фиксируется; этап
               -- пациента подпись не меняет.
               signed_route_stage = (
                   SELECT patients.stage FROM patients
                   WHERE patients.id = oncology_consilium_appointments.patient_id),
               signed_route_history_entry_id = (
                   SELECT h.id FROM history_entries h
                   WHERE h.patient_id = oncology_consilium_appointments.patient_id
                   ORDER BY h.seq DESC LIMIT 1),
               signed_route_entered_at = (
                   SELECT h.entered_at FROM history_entries h
                   WHERE h.patient_id = oncology_consilium_appointments.patient_id
                   ORDER BY h.seq DESC LIMIT 1),
               signed_route_link_source = 'recorded'
           WHERE id = ? AND status = 'in_review' AND deleted_at IS NULL""",
        (treatment_type, treatment_scheme or None, treatment_scheme_code or None,
         int(goc), int(goc_65_plus), now, user.id, now, appointment_id),
        "Подписать можно только запись, рассмотрение которой начато",
        audit_hook,
    )


class ConsiliumCommentError(ValueError):
    """The revision comment repeats the previous one."""


def return_for_revision(
    conn: sqlite3.Connection, user: policy.CurrentUser, appointment_id: str, expected_version: int,
    comment: str, *, audit_hook=None,
) -> dict | None:
    """Return a record under review and preserve its reason as one audited round."""
    now = now_iso()
    with transaction(conn):
        existing = _chair_record(conn, user, appointment_id, expected_version)
        if existing is None:
            return None
        if existing["status"] == "in_review" and existing["revisionComment"] == comment:
            raise ConsiliumCommentError("Комментарий должен отличаться от предыдущего возврата")
        cursor = conn.execute(
            """UPDATE oncology_consilium_appointments
               SET status = 'recorded', revision_comment = ?, revision_submitted_at = NULL,
                   review_started_at = NULL, revision_count = revision_count + 1, updated_at = ?
               WHERE id = ? AND status = 'in_review' AND archived_at IS NULL AND deleted_at IS NULL""",
            (comment, now, appointment_id),
        )
        if cursor.rowcount != 1:
            raise ConsiliumStateError("Вернуть на доработку можно только запись, рассмотрение которой начато")
        # Раунд, причина, автор и обязательный аудит входят в транзакцию возврата.
        conn.execute(
            """INSERT INTO consilium_revision_history
                   (id, appointment_id, round, comment, returned_by_user_id, returned_at)
               SELECT ?, id, revision_count, ?, ?, ? FROM oncology_consilium_appointments WHERE id = ?""",
            (uuid.uuid4().hex, comment, user.id, now, appointment_id),
        )
        if audit_hook is not None:
            audit_hook(appointment_id)
        return get_for_management(conn, appointment_id)



def resubmit(
    conn: sqlite3.Connection,
    user: policy.CurrentUser,
    appointment_id: str,
    expected_version: int,
    *,
    audit_hook=None,
) -> dict | None:
    """Send a returned record back to the chair (needs_revision → revised).

    Explicit action, separate from editing (v22): the version check, the
    status change, the append-only consilium_resubmissions row with the real
    author and time, and the required audit row share one BEGIN IMMEDIATE
    transaction. The version grows (trigger)."""
    now = now_iso()
    with transaction(conn):
        fresh = _locked_user(conn, user)
        existing = get_manageable(conn, fresh, appointment_id) if fresh else None
        if existing is None:
            return None
        _require_version(existing, expected_version)
        if existing["status"] != "needs_revision" or existing["archived"]:
            raise ConsiliumStateError(
                "Отправить на повторное рассмотрение можно только запись, возвращенную на доработку")
        cursor = conn.execute(
            """UPDATE oncology_consilium_appointments
               SET revision_submitted_at = ?, updated_at = ?
               WHERE id = ? AND status = 'recorded'
                 AND revision_comment IS NOT NULL AND revision_submitted_at IS NULL
                 AND archived_at IS NULL AND deleted_at IS NULL AND version = ?""",
            (now, now, appointment_id, expected_version),
        )
        if cursor.rowcount == 0:
            raise ConsiliumStateError(
                "Отправить на повторное рассмотрение можно только запись, возвращенную на доработку")
        conn.execute(
            """INSERT INTO consilium_resubmissions
                   (id, appointment_id, round, submitted_by_user_id, submitted_at, migrated)
               VALUES (?, ?, ?, ?, ?, 0)""",
            (uuid.uuid4().hex, appointment_id, existing["revisionCount"], user.id, now),
        )
        if audit_hook is not None:
            audit_hook({**_slot_facts(existing), "round": existing["revisionCount"]})
        result = _committed_result(conn, fresh, appointment_id)  # B2-01: ответ внутри транзакции
    return result


def revision_history(conn: sqlite3.Connection, appointment_id: str) -> list[dict]:
    rows = conn.execute(
        """SELECT h.round, h.comment, h.returned_at, h.migrated, u.full_name AS returned_by_name,
                  r.submitted_at, r.migrated AS submission_migrated, su.full_name AS submitted_by_name
           FROM consilium_revision_history h
           LEFT JOIN users u ON u.id = h.returned_by_user_id
           LEFT JOIN consilium_resubmissions r ON r.appointment_id = h.appointment_id AND r.round = h.round
           LEFT JOIN users su ON su.id = r.submitted_by_user_id
           WHERE h.appointment_id = ?
           ORDER BY h.round""",
        (appointment_id,),
    ).fetchall()
    # Повторная подача раунда: время и автор — только если они известны.
    # Для подачи, перенесенной из v21, автор не хранился (resubmittedByName = "").
    return [{
        "round": r["round"],
        "comment": r["comment"],
        "returnedAt": r["returned_at"],
        "returnedByName": r["returned_by_name"] or "",
        "migrated": bool(r["migrated"]),
        "resubmittedAt": r["submitted_at"],
        "resubmittedByName": r["submitted_by_name"] or "",
        "resubmissionMigrated": bool(r["submission_migrated"]) if r["submitted_at"] else False,
    } for r in rows]


def analytics_summary(
    conn: sqlite3.Connection, date_from: str | None = None, date_to: str | None = None
) -> dict:
    rows = conn.execute(
        """SELECT * FROM oncology_consilium_appointments
           WHERE deleted_at IS NULL
             AND (? IS NULL OR scheduled_date >= ?) AND (? IS NULL OR scheduled_date <= ?)""",
        (date_from, date_from, date_to, date_to),
    ).fetchall()
    from ..request_security import current
    state = current.get()
    if state is not None and state.resource.startswith('/api/consilium/analytics'):
        state.aggregate_objects.update(('appointment', row['id']) for row in rows)
        state.aggregate_objects.update(('patient', row['patient_id']) for row in rows)
    total = len(rows)
    signed = sum(row["status"] == "signed" for row in rows)
    in_review = sum(row["status"] == "in_review" for row in rows)
    returned = sum(public_status(row) == "needs_revision" for row in rows)
    specialist = sum(bool(row["needs_surgeon"] or row["needs_radiotherapist"]) for row in rows)
    treatment_counts = {code: 0 for code in TREATMENT_LABELS}
    scheme_counts: dict[tuple[str, str], int] = {}
    for row in rows:
        if row["treatment_type"] in treatment_counts:
            treatment_counts[row["treatment_type"]] += 1
        if row["status"] == "signed" and row["treatment_type"] == "chemotherapy" and row["treatment_scheme"]:
            key = (row["treatment_scheme_code"] or "", row["treatment_scheme"])
            scheme_counts[key] = scheme_counts.get(key, 0) + 1
    # Вместимость — фактические слоты председателя за период (WP2.3-B2), а не
    # константа времени. Записи вне расписания — отдельной строкой, в
    # знаменатель не входят. Без слотов — состояние «Нет расписания».
    slot_keys = {
        (row["scheduled_date"], row["scheduled_time"], row["consilium_group"])
        for row in conn.execute(
            """SELECT scheduled_date, scheduled_time, consilium_group FROM consilium_schedule_slots
               WHERE (? IS NULL OR scheduled_date >= ?) AND (? IS NULL OR scheduled_date <= ?)""",
            (date_from, date_from, date_to, date_to),
        ).fetchall()
    }
    appointment_keys = [(row["scheduled_date"], row["scheduled_time"], row["consilium_group"]) for row in rows]
    occupied = len({key for key in appointment_keys if key in slot_keys})
    outside = sum(1 for key in appointment_keys if key not in slot_keys)
    capacity = len(slot_keys)
    return {
        "summary": {
            "total": total,
            "signed": signed,
            "inReview": in_review,
            "awaiting": total - signed,
            "returned": returned,
            "needsSpecialists": specialist,
        },
        "treatments": [
            {"code": code, "label": label, "count": treatment_counts[code]}
            for code, label in TREATMENT_LABELS.items()
        ],
        "schemes": [
            {"code": code, "label": name, "count": count}
            for (code, name), count in sorted(
                scheme_counts.items(), key=lambda item: (-item[1], item[0][0], item[0][1])
            )
        ],
        "schedule": {
            "state": "ok" if capacity else "no_schedule",
            "slots": capacity,
            "occupied": occupied,
            "loadPercent": round((occupied / capacity * 100), 1) if capacity else None,
            "outsideSchedule": outside,
            "activeDays": len({key[0] for key in slot_keys}),
            # Прежние имена полей того же смысла (совместимость клиента).
            "occupiedSlots": occupied,
            "capacitySlots": capacity,
        },
    }


def update(
    conn: sqlite3.Connection,
    user: policy.CurrentUser,
    appointment_id: str,
    body: ConsiliumAppointmentUpdateIn,
    *,
    audit_hook=None,
) -> dict | None:
    """Edit or reschedule the author's record.

    The state read, the new slot check, the UPDATE and the required audit
    row run in one BEGIN IMMEDIATE transaction (WP2.3-A).
    """
    try:
        with transaction(conn):
            return _update_locked(conn, user, appointment_id, body, audit_hook)
    except sqlite3.IntegrityError as exc:
        raise ValueError(_integrity_error_message(exc)) from exc


def _update_locked(
    conn: sqlite3.Connection,
    user: policy.CurrentUser,
    appointment_id: str,
    body: ConsiliumAppointmentUpdateIn,
    audit_hook,
) -> dict | None:
    fresh = _locked_user(conn, user)
    if fresh is None or get_manageable(conn, fresh, appointment_id) is None:
        return None
    existing = conn.execute(
        """SELECT id, patient_id, status, scheduled_date, scheduled_time, consilium_group, version, backdated
           FROM oncology_consilium_appointments
           WHERE id = ? AND deleted_at IS NULL""",
        (appointment_id,),
    ).fetchone()
    if existing is None:
        return None
    # Версия — до проверки состояния: устаревшая форма получает 409 с кодом
    # конфликта, а не сообщение о статусе, которого пользователь не видел.
    _require_version(dict(existing), body.version)
    if existing["status"] != "recorded":
        raise ConsiliumStateError(
            "Подписанная запись недоступна для редактирования"
            if existing["status"] == "signed"
            else "Запись на рассмотрении у председателя недоступна для редактирования"
        )
    if body.patientId != existing["patient_id"]:
        raise ValueError("При переносе нельзя изменить пациента")
    if body.consiliumGroup != existing["consilium_group"]:
        raise ValueError("Перенос возможен только внутри прежней консилиумной группы")
    patient = conn.execute(
        "SELECT diagnosis FROM patients WHERE id = ?", (existing["patient_id"],)
    ).fetchone()
    if patient is None:
        raise ValueError("Пациент не найден")
    _require_group_for_patient(patient["diagnosis"], body.consiliumGroup)
    same_slot = (
        existing["scheduled_date"] == body.scheduledDate
        and existing["scheduled_time"] == body.scheduledTime
        and existing["consilium_group"] == body.consiliumGroup
    )
    if not same_slot and existing["backdated"]:
        # Запись задним числом описывает прошедший консилиум в историческом слоте
        # председателя (WP2.3-B3): перенос в другой слот исказил бы ее смысл.
        raise ValueError("Запись, оформленную задним числом, нельзя перенести в другой слот")
    if not same_slot:
        _require_available_slot(
            conn, body.scheduledDate, body.scheduledTime, body.consiliumGroup,
            exclude_appointment_id=appointment_id,
        )
    now = now_iso()
    cursor = conn.execute(
        """UPDATE oncology_consilium_appointments
           SET scheduled_date = ?, scheduled_time = ?,
               has_benefit = ?, treating_doctor_name = ?, policy_number = ?, diagnosis_localization = ?,
               primary_diagnosis = ?, additional_diagnosis = ?, comment = ?,
               additional_participant = ?, needs_surgeon = ?,
               needs_radiotherapist = ?, uv_ruv = ?,
               updated_at = ?
           WHERE id = ? AND status = 'recorded' AND deleted_at IS NULL AND version = ?""",
        (
            body.scheduledDate, body.scheduledTime,
            int(body.hasBenefit), _current_treating_doctor_name(conn, existing["patient_id"]),
            body.policyNumber or None,
            body.diagnosisLocalization or None,
            body.primaryDiagnosis, body.additionalDiagnosis or None,
            body.comment or None, body.additionalParticipant or None,
            # Правка и перенос не означают повторную подачу (v22): статус
            # needs_revision сохраняется до явного resubmit.
            int(body.needsSurgeon), int(body.needsRadiotherapist), int(body.uvRuv), now,
            appointment_id, body.version,
        ),
    )
    if cursor.rowcount == 0:
        raise ConsiliumStateError("Запись на рассмотрении у председателя недоступна для редактирования")
    if audit_hook is not None:
        audit_hook({
            "appointment_id": appointment_id, "patient_id": existing["patient_id"],
            "group": existing["consilium_group"],
            "from_date": existing["scheduled_date"], "from_time": existing["scheduled_time"],
            "to_date": body.scheduledDate, "to_time": body.scheduledTime,
            "slot_changed": not same_slot,
        })
    return get_manageable(conn, fresh, appointment_id)


def group_for_diagnosis(value: str | None) -> str:
    raw = str(value or "").strip().upper()
    if len(raw) < 3 or raw[0] != "C" or not raw[1:3].isdigit():
        return "general"
    code = int(raw[1:3])
    if 0 <= code <= 14 or 30 <= code <= 32:
        return "head_neck"
    if 15 <= code <= 16 or 22 <= code <= 25:
        return "abdominal"
    if code == 34:
        return "thoracic"
    if 51 <= code <= 57:
        return "gynecology"
    if 60 <= code <= 68:
        return "urology"
    if code == 50:
        return "breast"
    if 17 <= code <= 20:
        return "colorectal"
    return "general"


def _require_group_for_patient(diagnosis: str | None, consilium_group: str) -> None:
    if group_for_diagnosis(diagnosis) != consilium_group:
        raise ValueError("Консилиумная группа должна соответствовать коду МКБ-10 из карточки пациента")


def _require_patient_not_booked(conn: sqlite3.Connection, patient_id: str) -> None:
    """At most one unfinished appointment per patient (v22): a new consilium
    is possible once every earlier one is signed or deleted. The database
    enforces the same rule (trg_consilium_one_open_per_patient_*)."""
    if conn.execute(
        """SELECT 1 FROM oncology_consilium_appointments
           WHERE patient_id = ? AND deleted_at IS NULL AND status != 'signed' LIMIT 1""",
        (patient_id,),
    ).fetchone():
        raise ValueError(
            "Пациент уже записан на онкологический консилиум. Используйте перенос существующей записи."
        )


def _integrity_error_message(exc: sqlite3.IntegrityError) -> str:
    text = str(exc)
    if "consilium_patient_has_open_record" in text or "consilium_patient_already_booked" in text:
        return "Пациент уже записан на онкологический консилиум. Используйте перенос существующей записи."
    if "scheduled_date" in text and "scheduled_time" in text and "consilium_group" in text:
        return "Выбранный слот уже занят"
    return "Не удалось сохранить запись: нарушено ограничение уникальности"


NO_SCHEDULE_MESSAGE = "Расписание председателя не создано: запись недоступна"
SLOT_NOT_IN_SCHEDULE_MESSAGE = "Выбранный слот отсутствует в расписании председателя"
SLOT_IN_PAST_MESSAGE = "Выбранный слот уже прошел: запись возможна только на будущее время"


def _require_available_slot(
    conn: sqlite3.Connection,
    scheduled_date: str,
    scheduled_time: str,
    consilium_group: str,
    *,
    exclude_appointment_id: str | None = None,
) -> None:
    """The slot exists in the chair's schedule, starts strictly after the
    current Moscow time and is free (WP2.3-B2).

    Called inside the booking transaction, after BEGIN IMMEDIATE: "now" is
    taken when the lock is held. There is no generated current week and no
    booking without a schedule any more."""
    if consilium_group not in GROUP_LABELS:
        raise ValueError("Выберите действующую консилиумную группу")
    if not conn.execute("SELECT 1 FROM consilium_schedule_slots LIMIT 1").fetchone():
        raise ValueError(NO_SCHEDULE_MESSAGE)
    slot = conn.execute(
        """SELECT id FROM consilium_schedule_slots
           WHERE scheduled_date = ? AND scheduled_time = ? AND consilium_group = ?""",
        (scheduled_date, scheduled_time, consilium_group),
    ).fetchone()
    if slot is None:
        raise ValueError(SLOT_NOT_IN_SCHEDULE_MESSAGE)
    if not clock.is_strictly_future(scheduled_date, scheduled_time, clock.now_moscow()):
        raise ValueError(SLOT_IN_PAST_MESSAGE)
    occupied = conn.execute(
        """SELECT id FROM oncology_consilium_appointments
           WHERE scheduled_date = ? AND scheduled_time = ? AND consilium_group = ? AND deleted_at IS NULL
             AND (? IS NULL OR id != ?) LIMIT 1""",
        (scheduled_date, scheduled_time, consilium_group, exclude_appointment_id, exclude_appointment_id),
    ).fetchone()
    if occupied is not None:
        raise ValueError("Выбранный слот уже занят")


def _slot_appointment(row: sqlite3.Row, user: policy.CurrentUser, manageable_ids: set[str]) -> dict | None:
    """Details of the appointment occupying a slot, or None.

    - the chair and the developer (schedule management) and whoever manages
      the record (doctor — own patients, head — own departments): full details;
      canManage tells whether this user may change the record;
    - everyone else: None, the slot is reported only as occupied.
    """
    can_manage = row["id"] in manageable_ids
    if not (can_manage or policy.can_manage_consilium(user) or policy.can_decide_consilium(user)):
        return None
    status = public_status(row)
    return {
        "id": row["id"],
        "patientId": row["patient_id"],
        "patientName": row["patient_name"],
        "primaryDiagnosis": row["primary_diagnosis"],
        "treatingDoctorName": row["treating_doctor_name"],
        "policyNumber": row["policy_number"],
        "status": status,
        "statusLabel": STATUS_LABELS.get(status, status),
        "uvRuv": bool(row["uv_ruv"]),
        "createdByUserId": row["created_by_user_id"],
        "isMine": row["created_by_user_id"] == user.id,
        "canManage": can_manage,
        "view": "full",
    }


def _manageable_ids(conn: sqlite3.Connection, user: policy.CurrentUser) -> set[str]:
    condition, params = policy.consilium_record_filter(user)
    rows = conn.execute(
        f"""SELECT a.id FROM oncology_consilium_appointments a
            JOIN patients ON patients.id = a.patient_id AND a.deleted_at IS NULL
            WHERE {condition}""",  # nosec B608 - condition comes from policy; values are bound.
        params,
    ).fetchall()
    return {row["id"] for row in rows}


def schedule_slots(conn: sqlite3.Connection, user: policy.CurrentUser) -> list[dict]:
    """The chair's schedule — the only source of bookable slots (WP2.3-B2).

    isPast / bookable are computed in Moscow time; a slot occupied by any
    record (signed ones too) stays occupied."""
    slot_rows = conn.execute(
        """SELECT * FROM consilium_schedule_slots
           ORDER BY scheduled_date ASC, scheduled_time ASC, consilium_group ASC"""
    ).fetchall()
    appointment_rows = conn.execute(
        """SELECT a.id, a.patient_id, a.created_by_user_id, a.scheduled_date, a.scheduled_time,
                  a.consilium_group, a.primary_diagnosis,
                  COALESCE(
                      CASE WHEN a.status = 'signed' THEN a.signed_treating_doctor_name END,
                      treating_doctor.full_name, NULLIF(patients.doctor, ''), a.treating_doctor_name
                  ) AS treating_doctor_name,
                  COALESCE(a.policy_number, patients.policy_number, '') AS policy_number, a.status,
                  a.uv_ruv, a.revision_comment, a.revision_submitted_at, patients.name AS patient_name
           FROM oncology_consilium_appointments a
           JOIN patients ON patients.id = a.patient_id AND a.deleted_at IS NULL
           LEFT JOIN users treating_doctor ON treating_doctor.id = patients.treating_doctor_user_id"""
    ).fetchall()
    appointments = {
        (row["scheduled_date"], row["scheduled_time"], row["consilium_group"]): row
        for row in appointment_rows
    }
    manageable = _manageable_ids(conn, user)
    now = clock.now_moscow()
    slots = []
    for row in slot_rows:
        if row["consilium_group"] not in GROUP_LABELS:
            continue
        key = (row["scheduled_date"], row["scheduled_time"], row["consilium_group"])
        occupant = appointments.get(key)
        is_past = not clock.is_strictly_future(row["scheduled_date"], row["scheduled_time"], now)
        slots.append({
            "id": row["id"],
            "scheduledDate": row["scheduled_date"],
            "scheduledTime": row["scheduled_time"],
            "consiliumGroup": row["consilium_group"],
            "consiliumGroupLabel": GROUP_LABELS.get(row["consilium_group"], row["consilium_group"]),
            "occupied": occupant is not None,
            "appointment": _slot_appointment(occupant, user, manageable) if occupant else None,
            "isPast": is_past,
            "bookable": occupant is None and not is_past,
            # Исторический слот председателя (WP2.3-B3): только для записи задним числом.
            "backdated": bool(row["backdated"]),
            # Прежнее поле контракта: вычисляемой недели больше нет (WP2.3-B2).
            "isDefaultWeek": False,
        })
    return slots


def generate_schedule(
    conn: sqlite3.Connection,
    user: policy.CurrentUser,
    scheduled_date: str,
    consilium_group: str,
    start_time: str,
    end_time: str,
    interval_minutes: int,
    *,
    audit_hook=None,
) -> dict:
    """Create the chair's slots of one day and group (Moscow time).

    Only slots strictly in the future are created: for today the times that
    already passed are skipped and counted in skippedPast; a past date, or a
    today's interval that is entirely over, creates nothing. Past slots with
    a reason belong to WP2.3-B3."""
    if consilium_group not in GROUP_LABELS:
        raise ValueError("Unknown consilium group")
    start = datetime.strptime(f"{scheduled_date} {start_time}", "%Y-%m-%d %H:%M")
    end = datetime.strptime(f"{scheduled_date} {end_time}", "%Y-%m-%d %H:%M")
    if end <= start:
        raise ValueError("Время окончания должно быть позже времени начала")
    if end - start > timedelta(hours=12):
        raise ValueError("Сетка расписания не может быть длиннее 12 часов")
    times = []
    moment = start
    while moment < end:
        times.append(moment.strftime("%H:%M"))
        moment += timedelta(minutes=interval_minutes)
    created = 0
    created_at = now_iso()
    with transaction(conn):
        now = clock.now_moscow()
        if scheduled_date < now.date().isoformat():
            raise ValueError("Нельзя создать расписание на прошедшую дату")
        future = [t for t in times if clock.is_strictly_future(scheduled_date, t, now)]
        if not future:
            raise ValueError("Время выбранного интервала уже прошло: расписание не создано")
        for scheduled_time in future:
            cursor = conn.execute(
                """INSERT OR IGNORE INTO consilium_schedule_slots
                   (id, scheduled_date, scheduled_time, consilium_group, created_by_user_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (uuid.uuid4().hex, scheduled_date, scheduled_time, consilium_group, user.id, created_at),
            )
            created += cursor.rowcount
        skipped_past = len(times) - len(future)
        if audit_hook is not None:
            audit_hook({"created": created, "date": scheduled_date, "group": consilium_group,
                        "start": start_time, "end": end_time, "interval": interval_minutes,
                        "skipped_past": skipped_past})
    return {"created": created, "skippedPast": skipped_past}


BACKDATED_FUTURE_MESSAGE = "Задним числом можно оформить только прошедшие дату и время (по Москве)"
BACKDATED_SLOT_REQUIRED_MESSAGE = (
    "Запись задним числом возможна только в исторический слот председателя"
)


def _insert_backdating_reason(
    conn: sqlite3.Connection, user: policy.CurrentUser, kind: str, reason: str, created_at: str,
) -> str:
    reason_id = uuid.uuid4().hex
    conn.execute(
        """INSERT INTO consilium_backdating_reasons (id, kind, reason, created_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (reason_id, kind, reason, user.id, created_at),
    )
    return reason_id


def _slot_dict(conn: sqlite3.Connection, slot_id: str) -> dict:
    row = conn.execute("SELECT * FROM consilium_schedule_slots WHERE id = ?", (slot_id,)).fetchone()
    return {
        "id": row["id"], "scheduledDate": row["scheduled_date"], "scheduledTime": row["scheduled_time"],
        "consiliumGroup": row["consilium_group"],
        "consiliumGroupLabel": GROUP_LABELS.get(row["consilium_group"], row["consilium_group"]),
        "backdated": bool(row["backdated"]), "createdAt": row["created_at"],
        "occupied": False, "isPast": True, "bookable": False, "isDefaultWeek": False,
    }


def create_backdated_slot(
    conn: sqlite3.Connection,
    user: policy.CurrentUser,
    scheduled_date: str,
    scheduled_time: str,
    consilium_group: str,
    reason: str,
    *,
    audit_hook=None,
) -> dict:
    """Stage 1 of backdating (WP2.3-B3): the chair creates a historical slot.

    One BEGIN IMMEDIATE transaction: the chair's role re-read, the slot strictly
    not in the future in Moscow time, the key free, the reason row (separate
    from the technical audit), the slot with backdated = 1, the required audit
    row and the response. created_at is the real time of creation."""
    if consilium_group not in GROUP_LABELS:
        raise ValueError("Выберите действующую консилиумную группу")
    slot_id = uuid.uuid4().hex
    with transaction(conn):
        fresh = _locked_user(conn, user)
        if fresh is None or not policy.can_create_backdated_slot(fresh):
            raise ConsiliumAccessLost()
        # Только строго прошедший момент: слот «ровно сейчас» еще не прошел (B3-04).
        if not clock.is_strictly_past(scheduled_date, scheduled_time, clock.now_moscow()):
            raise ValueError(BACKDATED_FUTURE_MESSAGE)
        if conn.execute(
            """SELECT 1 FROM consilium_schedule_slots
               WHERE scheduled_date = ? AND scheduled_time = ? AND consilium_group = ?""",
            (scheduled_date, scheduled_time, consilium_group),
        ).fetchone():
            raise ValueError("Слот на эти дату, время и группу уже существует")
        created_at = now_iso()      # после получения блокировки, рядом с записью данных
        reason_id = _insert_backdating_reason(conn, fresh, "slot", reason, created_at)
        conn.execute(
            """INSERT INTO consilium_schedule_slots
               (id, scheduled_date, scheduled_time, consilium_group, created_by_user_id, created_at,
                backdated, backdating_reason_id)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?)""",
            (slot_id, scheduled_date, scheduled_time, consilium_group, fresh.id, created_at, reason_id),
        )
        if audit_hook is not None:
            audit_hook({"slot_id": slot_id, "date": scheduled_date, "time": scheduled_time,
                        "group": consilium_group, "reason_id": reason_id})
        result = _slot_dict(conn, slot_id)
    return result


def _require_backdated_slot(
    conn: sqlite3.Connection, scheduled_date: str, scheduled_time: str, consilium_group: str,
) -> str:
    """The chair's historical slot (backdated = 1 with a slot reason), in the
    past in Moscow time and free. Returns the slot id. Inside the transaction."""
    if consilium_group not in GROUP_LABELS:
        raise ValueError("Выберите действующую консилиумную группу")
    slot = conn.execute(
        """SELECT s.id FROM consilium_schedule_slots s
           JOIN consilium_backdating_reasons r ON r.id = s.backdating_reason_id AND r.kind = 'slot'
           WHERE s.scheduled_date = ? AND s.scheduled_time = ? AND s.consilium_group = ? AND s.backdated = 1""",
        (scheduled_date, scheduled_time, consilium_group),
    ).fetchone()
    if slot is None:
        raise ValueError(BACKDATED_SLOT_REQUIRED_MESSAGE)
    if not clock.is_strictly_past(scheduled_date, scheduled_time, clock.now_moscow()):
        raise ValueError(BACKDATED_FUTURE_MESSAGE)
    if conn.execute(
        """SELECT 1 FROM oncology_consilium_appointments
           WHERE scheduled_date = ? AND scheduled_time = ? AND consilium_group = ? AND deleted_at IS NULL LIMIT 1""",
        (scheduled_date, scheduled_time, consilium_group),
    ).fetchone():
        raise ValueError("Выбранный слот уже занят")
    return slot["id"]


def create_backdated(
    conn: sqlite3.Connection, user: policy.CurrentUser, body, *, audit_hook=None
) -> dict:
    """Stage 2 of backdating (WP2.3-B3): a department head books a patient of
    own department into the chair's historical slot, with a reason.

    One BEGIN IMMEDIATE transaction: role and scope re-read, the patient's
    group and the «one unfinished consilium» rule, the historical slot (past,
    free, backdated), the reason row, the record (backdated = 1, created_at =
    the real time taken after the lock), the required audit row and the response (B2-01). Earlier
    signed consiliums of the patient are not touched: the record is separate
    and dated by its slot."""
    appointment_id = uuid.uuid4().hex
    try:
        with transaction(conn):
            fresh = _locked_user(conn, user)
            if (fresh is None or not policy.can_backdate_consilium(fresh)
                    or not policy.can_write_patient(conn, fresh, body.patientId)):
                raise ConsiliumAccessLost()
            patient = conn.execute(
                "SELECT policy_number, diagnosis FROM patients WHERE id = ?", (body.patientId,)
            ).fetchone()
            if patient is None:
                raise ConsiliumAccessLost()
            _require_group_for_patient(patient["diagnosis"], body.consiliumGroup)
            _require_patient_not_booked(conn, body.patientId)
            slot_id = _require_backdated_slot(conn, body.scheduledDate, body.scheduledTime, body.consiliumGroup)
            # Фактическое время внесения — после получения блокировки, одно для
            # причины и записи: ожидание чужой транзакции его не искажает (B3-02).
            now = now_iso()
            reason_id = _insert_backdating_reason(conn, fresh, "appointment", body.reason, now)
            conn.execute(
                """INSERT INTO oncology_consilium_appointments (
                   id, patient_id, created_by_user_id, scheduled_date, scheduled_time,
                   consilium_group, has_benefit, treating_doctor_name, policy_number, diagnosis_localization,
                   primary_diagnosis, additional_diagnosis, comment,
                   additional_participant, needs_surgeon, needs_radiotherapist, uv_ruv,
                   backdated, backdating_reason_id, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                (
                    appointment_id, body.patientId, fresh.id, body.scheduledDate,
                    body.scheduledTime, body.consiliumGroup, int(body.hasBenefit),
                    _current_treating_doctor_name(conn, body.patientId),
                    body.policyNumber or patient["policy_number"] or None,
                    body.diagnosisLocalization or None,
                    body.primaryDiagnosis, body.additionalDiagnosis or None,
                    body.comment or None, body.additionalParticipant or None,
                    int(body.needsSurgeon), int(body.needsRadiotherapist), int(body.uvRuv),
                    reason_id, now, now,
                ),
            )
            if audit_hook is not None:
                audit_hook({
                    "appointment_id": appointment_id, "patient_id": body.patientId,
                    "date": body.scheduledDate, "time": body.scheduledTime, "group": body.consiliumGroup,
                    "slot_id": slot_id, "reason_id": reason_id,
                })
            result = _committed_result(conn, fresh, appointment_id)
    except sqlite3.IntegrityError as exc:
        raise ValueError(_integrity_error_message(exc)) from exc
    return result


def backdating_reasons_for_appointment(
    conn: sqlite3.Connection, user: policy.CurrentUser, appointment_id: str, *, audit_hook=None
) -> dict | None:
    """Reason texts of a backdated record (WP2.3-B3). The chair sees any
    record; a head — records of own departments (the same scope as managing).
    None — the record is not visible to the user or not backdated (404: no
    difference is disclosed). The read is audited fail-closed, without text."""
    with transaction(conn):
        fresh = _locked_user(conn, user)
        if fresh is None or not policy.can_read_backdating_reasons(fresh):
            return None
        if fresh.role_id == policy.ROLE_CONSILIUM_CHAIR:
            record = get_for_management(conn, appointment_id)
        else:
            record = get_manageable(conn, fresh, appointment_id)
        if record is None or not record["backdated"]:
            return None
        row = conn.execute(
            """SELECT a.id, a.patient_id, a.created_at, ar.reason AS appointment_reason,
                      ar.created_at AS appointment_reason_at, au.full_name AS appointment_reason_by,
                      sr.reason AS slot_reason, sr.created_at AS slot_reason_at, su.full_name AS slot_reason_by
               FROM oncology_consilium_appointments a
               JOIN consilium_backdating_reasons ar ON ar.id = a.backdating_reason_id AND ar.kind = 'appointment'
               LEFT JOIN users au ON au.id = ar.created_by_user_id
               LEFT JOIN consilium_schedule_slots s ON s.scheduled_date = a.scheduled_date
                    AND s.scheduled_time = a.scheduled_time AND s.consilium_group = a.consilium_group
               LEFT JOIN consilium_backdating_reasons sr ON sr.id = s.backdating_reason_id AND sr.kind = 'slot'
               LEFT JOIN users su ON su.id = sr.created_by_user_id
               WHERE a.id = ?""",
            (appointment_id,),
        ).fetchone()
        if row is None:
            return None
        if audit_hook is not None:
            audit_hook({"appointment_id": appointment_id, "patient_id": row["patient_id"]})
        return {
            "appointmentId": appointment_id,
            "scheduledDate": record["scheduledDate"], "scheduledTime": record["scheduledTime"],
            "createdAt": row["created_at"],
            "appointmentReason": {"text": row["appointment_reason"], "createdAt": row["appointment_reason_at"],
                                  "createdByName": row["appointment_reason_by"] or ""},
            "slotReason": ({"text": row["slot_reason"], "createdAt": row["slot_reason_at"],
                            "createdByName": row["slot_reason_by"] or ""} if row["slot_reason"] else None),
        }


def backdating_reason_for_slot(
    conn: sqlite3.Connection, user: policy.CurrentUser, slot_id: str, *, audit_hook=None
) -> dict | None:
    """Reason of a historical slot — the chair only (a head reads it through
    an accessible record). Audited fail-closed, without text."""
    with transaction(conn):
        fresh = _locked_user(conn, user)
        if fresh is None or fresh.role_id != policy.ROLE_CONSILIUM_CHAIR:
            return None
        row = conn.execute(
            """SELECT s.id, s.scheduled_date, s.scheduled_time, s.consilium_group, s.created_at,
                      r.reason, r.created_at AS reason_at, u.full_name AS reason_by
               FROM consilium_schedule_slots s
               JOIN consilium_backdating_reasons r ON r.id = s.backdating_reason_id AND r.kind = 'slot'
               LEFT JOIN users u ON u.id = r.created_by_user_id
               WHERE s.id = ? AND s.backdated = 1""",
            (slot_id,),
        ).fetchone()
        if row is None:
            return None
        if audit_hook is not None:
            audit_hook({"slot_id": slot_id, "patient_id": None})
        return {
            "slotId": slot_id, "scheduledDate": row["scheduled_date"], "scheduledTime": row["scheduled_time"],
            "consiliumGroup": row["consilium_group"], "createdAt": row["created_at"],
            "slotReason": {"text": row["reason"], "createdAt": row["reason_at"], "createdByName": row["reason_by"] or ""},
        }


def delete_schedule_slot(conn: sqlite3.Connection, slot_id: str, *, audit_hook=None) -> bool:
    """Remove a free chair slot.

    The occupancy check and the DELETE share one BEGIN IMMEDIATE transaction
    with create/update (WP2.3-A): a booking cannot land in a slot that is
    being removed. Without slots booking is impossible (WP2.3-B2).
    """
    with transaction(conn):
        slot = conn.execute(
            "SELECT * FROM consilium_schedule_slots WHERE id = ?", (slot_id,)
        ).fetchone()
        if slot is None:
            return False
        occupied = conn.execute(
            """SELECT 1 FROM oncology_consilium_appointments
               WHERE scheduled_date = ? AND scheduled_time = ? AND consilium_group = ? AND deleted_at IS NULL""",
            (slot["scheduled_date"], slot["scheduled_time"], slot["consilium_group"]),
        ).fetchone()
        if occupied is not None:
            raise ValueError("Нельзя удалить занятый слот")
        conn.execute("DELETE FROM consilium_schedule_slots WHERE id = ?", (slot_id,))
        if audit_hook is not None:
            audit_hook({"slot_id": slot["id"], "date": slot["scheduled_date"],
                        "time": slot["scheduled_time"], "group": slot["consilium_group"]})
    return True


def add_favorite(
    conn: sqlite3.Connection, user: policy.CurrentUser, patient_id: str
) -> bool:
    exists = conn.execute("SELECT 1 FROM patients WHERE id = ?", (patient_id,)).fetchone()
    if exists is None:
        return False
    with conn:
        conn.execute(
            """INSERT OR IGNORE INTO consilium_chair_favorites
               (user_id, patient_id, created_at) VALUES (?, ?, ?)""",
            (user.id, patient_id, now_iso()),
        )
    return True


def remove_favorite(
    conn: sqlite3.Connection, user: policy.CurrentUser, patient_id: str
) -> bool:
    with conn:
        cursor = conn.execute(
            "DELETE FROM consilium_chair_favorites WHERE user_id = ? AND patient_id = ?",
            (user.id, patient_id),
        )
    return cursor.rowcount > 0


def set_referral_completed(
    conn: sqlite3.Connection,
    user: policy.CurrentUser,
    appointment_id: str,
    completed: bool,
) -> dict | None:
    existing = get_for_management(conn, appointment_id)
    if existing is None:
        return None
    if existing["status"] != "signed" or existing["treatmentType"] != "surgery":
        raise ValueError("Only signed surgical referrals can be completed")
    now = now_iso()
    with conn:
        conn.execute(
            """UPDATE oncology_consilium_appointments
               SET referral_completed_at = ?, referral_completed_by_user_id = ?, updated_at = ?
               WHERE id = ?""",
            (now if completed else None, user.id if completed else None, now, appointment_id),
        )
        result = get_for_management(conn, appointment_id)  # B2-01: ответ внутри транзакции
    return result


def registry_rows(
    conn: sqlite3.Connection, treatment_type: str, scheduled_date: str | None = None
) -> list[dict]:
    params: list[str] = [treatment_type]
    date_clause = ""
    if scheduled_date:
        date_clause = " AND a.scheduled_date = ?"
        params.append(scheduled_date)
    rows = conn.execute(
        _SELECT
        + " WHERE a.status = 'signed' AND a.treatment_type = ?"
        + date_clause
        + " ORDER BY a.scheduled_date ASC, a.scheduled_time ASC, patients.name ASC",
        params,
    ).fetchall()
    return [_to_dict(row) for row in rows]


def goc_registry_rows(
    conn: sqlite3.Connection,
    registry_type: str,
    scheduled_date: str | None = None,
) -> list[dict]:
    if registry_type not in {"goc", "goc_65_plus"}:
        raise ValueError("Unknown GOC registry type")
    params: list[str] = []
    date_clause = ""
    if scheduled_date:
        date_clause = " AND a.scheduled_date = ?"
        params.append(scheduled_date)
    rows = conn.execute(
        _SELECT
        + f" WHERE a.status = 'signed' AND a.{registry_type} = 1"
        + date_clause
        + " ORDER BY a.scheduled_date ASC, a.scheduled_time ASC, patients.name ASC",
        params,
    ).fetchall()
    return [_to_dict(row) for row in rows]


_CANONICAL_TIME_RE = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]")


def _canonical_date(value) -> bool:
    try:
        strict_iso_date(value)
    except (ValueError, TypeError):
        return False
    return True


def schedule_diagnostics(conn: sqlite3.Connection) -> dict:
    """Read-only aggregate check of stored schedule data (WP2.3-A, WP2.3-B2).

    Only counts: no ids, names, diagnoses or dates of particular records.
    Nothing is corrected; legacy rows are reported for a separate decision.
    """
    appointments = conn.execute(
        """SELECT scheduled_date, scheduled_time, consilium_group
           FROM oncology_consilium_appointments WHERE deleted_at IS NULL"""
    ).fetchall()
    slots = conn.execute(
        "SELECT scheduled_date, scheduled_time, consilium_group FROM consilium_schedule_slots"
    ).fetchall()
    slot_keys = {(r["scheduled_date"], r["scheduled_time"], r["consilium_group"]) for r in slots}
    real_slots: dict[tuple, int] = {}
    outside_grid = 0
    for r in appointments:
        try:
            real_date = date_type.fromisoformat(str(r["scheduled_date"]).strip()).isoformat()
        except ValueError:
            real_date = str(r["scheduled_date"])
        key = (real_date, r["scheduled_time"], r["consilium_group"])
        real_slots[key] = real_slots.get(key, 0) + 1
        stored = (r["scheduled_date"], r["scheduled_time"], r["consilium_group"])
        if stored not in slot_keys:
            outside_grid += 1
    duplicates = [count for count in real_slots.values() if count > 1]
    open_by_patient: dict[str, int] = {}
    open_in_past = 0
    now = clock.now_moscow()
    for r in conn.execute(
        """SELECT patient_id, scheduled_date, scheduled_time FROM oncology_consilium_appointments
           WHERE deleted_at IS NULL AND status != 'signed'"""
    ).fetchall():
        open_by_patient[r["patient_id"]] = open_by_patient.get(r["patient_id"], 0) + 1
        moment = clock.slot_moment(str(r["scheduled_date"]), str(r["scheduled_time"]))
        if moment is not None and moment <= now:  # нестандартные даты не сравниваются
            open_in_past += 1
    return {
        "appointments": len(appointments),
        "nonCanonicalAppointmentDates": sum(not _canonical_date(r["scheduled_date"]) for r in appointments),
        "nonCanonicalAppointmentTimes": sum(
            not _CANONICAL_TIME_RE.fullmatch(str(r["scheduled_time"])) for r in appointments),
        "unknownAppointmentGroups": sum(r["consilium_group"] not in GROUP_LABELS for r in appointments),
        "scheduleSlots": len(slots),
        "nonCanonicalSlotDates": sum(not _canonical_date(r["scheduled_date"]) for r in slots),
        "nonCanonicalSlotTimes": sum(not _CANONICAL_TIME_RE.fullmatch(str(r["scheduled_time"])) for r in slots),
        # Записи без слота председателя (WP2.3-B2: вычисляемой недели и режима
        # пустой сетки больше нет). Видны в списках с отметкой «Вне расписания».
        "appointmentsOutsideGrid": outside_grid,
        "realSlotsWithSeveralAppointments": len(duplicates),
        "appointmentsInSharedRealSlots": sum(duplicates),
        # Исторические дубли: пациенты с несколькими незавершенными записями (до v17).
        "patientsWithSeveralOpenRecords": sum(1 for count in open_by_patient.values() if count > 1),
        # Незавершенные записи, время которых уже прошло (по Москве; справочно).
        "openRecordsInPastSlots": open_in_past,
    }
