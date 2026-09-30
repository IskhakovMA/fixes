"""Server-side management analytics.

This module intentionally computes aggregates on the backend and always starts
from ``policy.patient_scope_filter``. It does not expose medical analytics,
rank physicians, call external services, or read provider credentials.
"""
from __future__ import annotations

import json
import sqlite3
import csv
import io
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from .. import config, policy
from ..db import in_chunks, temp_id_table
from ..localization_catalog import ALL_LOCALIZATIONS
from ..models import STAGES, TERMINAL_STAGES
from ..phone import phone_sendable
from ..services import data_quality, notifications, patient_attention
from .filters import AnalyticsFilters, app_timezone, today_local
from .metrics import duration_stats, ordered_stage_rows, overdue_bucket, percent, stage_label

SUMMARY_DEFINITIONS = {
    "total_patients": "Все пациенты, доступные текущей роли с учётом фильтров.",
    "active_patients": "Доступные пациенты в этапах маршрута до завершения.",
    "completed_patients": "Доступные пациенты на этапе «Завершено».",
    "patients_need_attention": "Пациенты с минимум одной активной ручной отметкой «требует внимания».",
    "operational_signals": "Автоматические сигналы: просрочки, проблемы качества данных, незавершённые чек-листы и отсутствие закреплённого врача.",
    "data_quality_issues": "Все текущие критические проблемы и предупреждения Центра качества данных по доступным пациентам.",
    "unassigned_patients": "Доступные пациенты без закреплённой учётной записи лечащего врача.",
    "patients_with_overdue": "Пациенты с текущими просроченными событиями по правилам Центра качества данных.",
    "overdue_events": "Текущие плановые события в прошлом без фактического выполнения по правилам Центра качества данных.",
    "critical_quality": "Текущие критические проблемы Центра качества данных.",
    "warning_quality": "Текущие предупреждения Центра качества данных.",
    "incomplete_required_checklists": "Обязательные пункты чек-листа, не отмеченные выполненными.",
    "pending_notifications": "Уведомления, ожидающие отправки.",
    "failed_notifications": "Уведомления с ошибкой отправки.",
    "nosology_filter": "Фильтр по локализации/клиентскому пути; внутреннее API/БД поле остаётся nosology.",
}

PULSE_DEFINITIONS = {
    "active_patients": "Пациенты на незавершённых этапах маршрута в текущей области доступа.",
    "routes_under_control": (
        "Доля активных пациентов с будущим плановым действием, без просроченного события, "
        "активной ручной отметки внимания и критической проблемы качества данных."
    ),
    "needs_attention": (
        "Уникальные активные пациенты с просроченным событием, активной ручной отметкой "
        "внимания, критической проблемой качества данных или без следующего планового действия."
    ),
    "overdue_routes": "Уникальные активные пациенты с плановым событием в прошлом без фактического выполнения.",
    "no_next_action": (
        "Активные пациенты без незавершённого планового события на сегодня или будущее "
        "в текущем этапе маршрута."
    ),
    "open_problems": "Открытые ручные отметки «требует внимания» по доступным активным пациентам.",
}


def _computed_meta(user: policy.CurrentUser, filters: AnalyticsFilters, definitions: dict[str, str] | None = None) -> dict:
    return {
        "computed_at": datetime.now(app_timezone()).isoformat(),
        "timezone": config.APP_TIMEZONE,
        "scope": user.scope_strategy,
        "filters": filters.as_dict(),
        "definitions": definitions or {},
    }


def _scope_where(user: policy.CurrentUser) -> tuple[list[str], list[Any]]:
    cond, params = policy.patient_scope_filter(user)
    return [f"({cond})"], list(params)


def _localization_label(code: str) -> str:
    rule = ALL_LOCALIZATIONS.get(code)
    return rule.label if rule else code


def _analytics_nosology_codes(value: str | None) -> list[str]:
    code = (value or "").strip()
    if not code:
        return []
    rule = ALL_LOCALIZATIONS.get(code)
    if rule is None:
        return [code]
    label = rule.label
    return sorted(
        other_code
        for other_code, other_rule in ALL_LOCALIZATIONS.items()
        if other_rule.label == label and other_rule.has_client_path
    ) or [code]


def _base_patient_where(filters: AnalyticsFilters, user: policy.CurrentUser) -> tuple[list[str], list[Any]]:
    where, params = _scope_where(user)
    if filters.department_id:
        where.append(
            """EXISTS (
                SELECT 1 FROM user_departments aud
                JOIN departments ad ON ad.id = aud.department_id AND ad.status = 'active'
                WHERE aud.user_id = patients.treating_doctor_user_id AND ad.id = ?
            )"""
        )
        params.append(filters.department_id)
    if filters.doctor_user_id:
        where.append("patients.treating_doctor_user_id = ?")
        params.append(filters.doctor_user_id)
    if filters.stage:
        where.append("patients.stage = ?")
        params.append(filters.stage)
    nosology_codes = _analytics_nosology_codes(filters.nosology)
    if len(nosology_codes) == 1:
        where.append("patients.nosology = ?")
        params.append(nosology_codes[0])
    elif nosology_codes:
        where.append(f"patients.nosology IN ({','.join('?' for _ in nosology_codes)})")  # nosec B608 - placeholders are generated from allowlisted codes.
        params.extend(nosology_codes)
    return where, params


def _ids_clause(conn: sqlite3.Connection, ids: set[str] | list[str] | None) -> tuple[str, list[str]]:
    # None — ошибка вызывающего кода: без явного набора пациентов scope не
    # применяется, поэтому отказ закрыт (ничего не выбирается).
    if not ids:
        return "0 = 1", []
    ordered = sorted(ids)
    if len(ordered) > conn.getlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER) - 16:
        # Большой scope: набор id через TEMP-таблицу, а не по переменной на id.
        return f"patients.id IN (SELECT id FROM {temp_id_table(conn, ordered)})", []  # nosec B608 - generated identifier
    return f"patients.id IN ({','.join('?' for _ in ordered)})", ordered


def _quality_context(conn: sqlite3.Connection, user: policy.CurrentUser) -> dict:
    return data_quality.evaluate(conn, user, today=today_local())


def _quality_issue_ids(result: dict, *, severity: str | None = None, code: str | None = None) -> set[str]:
    ids = set()
    for issue in result["issues"]:
        if severity and issue["severity"] != severity:
            continue
        if code and issue["code"] != code:
            continue
        ids.add(issue["patient_id"])
    return ids


def _filtered_patient_ids(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters, quality: dict | None = None) -> set[str]:
    where, params = _base_patient_where(filters, user)
    rows = conn.execute(  # nosec B608 - clauses come from server-side allowlisted filters and bound params.
        f"SELECT patients.id FROM patients WHERE {' AND '.join(where)}", params  # nosec B608
    ).fetchall()
    ids = {r["id"] for r in rows}
    if not ids:
        return set()
    q = quality or _quality_context(conn, user)
    if filters.has_overdue is not None:
        overdue_ids = _quality_issue_ids(q, code="overdue_event")
        ids = (ids & overdue_ids) if filters.has_overdue else (ids - overdue_ids)
    if filters.data_quality_severity:
        ids &= _quality_issue_ids(q, severity=filters.data_quality_severity)
    if filters.notification_status:
        matched: set[str] = set()
        for chunk in in_chunks(conn, sorted(ids)):
            marks = ",".join("?" for _ in chunk)
            nrows = conn.execute(
                f"""SELECT DISTINCT notifications.patient_id
                    FROM notifications
                    JOIN patients ON patients.id = notifications.patient_id
                    WHERE notifications.status = ? AND patients.id IN ({marks})""",  # nosec B608
                [filters.notification_status, *chunk],
            ).fetchall()
            matched.update(r["patient_id"] for r in nrows)
        ids &= matched
    if filters.attention_reason:
        ids &= patient_attention.active_patient_ids(conn, ids, filters.attention_reason)
    return ids


def _patient_rows(conn: sqlite3.Connection, patient_ids: set[str] | None = None) -> list[sqlite3.Row]:
    cond, params = _ids_clause(conn, patient_ids)
    return conn.execute(
        f"""SELECT patients.id, patients.name, patients.stage, patients.nosology, patients.arrival,
                   patients.treating_doctor_user_id, patients.doctor,
                   u.full_name AS treating_doctor_name,
                   GROUP_CONCAT(DISTINCT d.id) AS department_ids,
                   GROUP_CONCAT(DISTINCT d.name) AS department_names
            FROM patients
            LEFT JOIN users u ON u.id = patients.treating_doctor_user_id
            LEFT JOIN user_departments ud ON ud.user_id = patients.treating_doctor_user_id
            LEFT JOIN departments d ON d.id = ud.department_id AND d.status = 'active'
            WHERE {cond}
            GROUP BY patients.id
            ORDER BY patients.name ASC, patients.id ASC""",  # nosec B608
        params,
    ).fetchall()


def _patient_ref(row: sqlite3.Row) -> dict:
    return {
        "patient_id": row["id"],
        "patient_name": row["name"],
        "stage": row["stage"],
        "stage_label": stage_label(row["stage"]),
        "treating_doctor_user_id": row["treating_doctor_user_id"],
        "treating_doctor_name": row["treating_doctor_name"] or row["doctor"] or "Не назначен",
        "department_names": [x for x in (row["department_names"] or "").split(",") if x],
    }


def _notification_counts(conn: sqlite3.Connection, patient_ids: set[str]) -> dict[str, int]:
    if not patient_ids:
        return {status: 0 for status in notifications.QUEUE_STATUSES}
    cond, params = _ids_clause(conn, patient_ids)
    rows = conn.execute(
        f"""SELECT notifications.status, COUNT(*) AS c
            FROM notifications JOIN patients ON patients.id = notifications.patient_id
            WHERE {cond}
            GROUP BY notifications.status""",  # nosec B608
        params,
    ).fetchall()
    counts = {status: 0 for status in notifications.QUEUE_STATUSES}
    counts.update({r["status"]: r["c"] for r in rows})
    return counts


def _future_action_patient_ids(conn: sqlite3.Connection, patient_ids: set[str]) -> set[str]:
    """Patients with an unfinished dated event today or later in the current route entry."""
    if not patient_ids:
        return set()
    cond, params = _ids_clause(conn, patient_ids)
    rows = conn.execute(
        f"""SELECT DISTINCT patients.id
            FROM patients
            JOIN history_entries h ON h.patient_id = patients.id
             AND h.seq = (SELECT MAX(current_h.seq) FROM history_entries current_h
                          WHERE current_h.patient_id = patients.id)
            JOIN events e ON e.history_entry_id = h.id
            WHERE {cond}
              AND COALESCE(e.no_plan, 0) = 0
              AND COALESCE(e.actual_date, '') = ''
              AND COALESCE(e.date, '') >= ?""",  # nosec B608 - generated patient-id placeholders only.
        [*params, today_local().isoformat()],
    ).fetchall()
    return {row["id"] for row in rows}


def _open_attention_issue_count(conn: sqlite3.Connection, patient_ids: set[str]) -> int:
    if not patient_ids:
        return 0
    total = 0
    for chunk in in_chunks(conn, sorted(patient_ids)):
        marks = ",".join("?" for _ in chunk)
        row = conn.execute(
            f"""SELECT COUNT(*) AS c FROM patient_attention_issues
                WHERE status = 'open' AND patient_id IN ({marks})""",  # nosec B608 - placeholders generated server-side.
            chunk,
        ).fetchone()
        total += int(row["c"] or 0)
    return total


def _pulse_state(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict[str, Any]:
    quality = _quality_context(conn, user)
    patient_ids = _filtered_patient_ids(conn, user, filters, quality)
    rows = _patient_rows(conn, patient_ids)
    active_ids = {row["id"] for row in rows if row["stage"] not in TERMINAL_STAGES}
    overdue_ids = _quality_issue_ids(quality, code="overdue_event") & active_ids
    critical_quality_ids = _quality_issue_ids(quality, severity="critical") & active_ids
    attention_ids = patient_attention.active_patient_ids(conn, active_ids)
    future_action_ids = _future_action_patient_ids(conn, active_ids)
    no_next_action_ids = active_ids - future_action_ids
    needs_attention_ids = overdue_ids | critical_quality_ids | attention_ids | no_next_action_ids
    under_control_ids = future_action_ids - overdue_ids - critical_quality_ids - attention_ids
    return {
        "rows": rows,
        "active_ids": active_ids,
        "overdue_ids": overdue_ids,
        "critical_quality_ids": critical_quality_ids,
        "attention_ids": attention_ids,
        "future_action_ids": future_action_ids,
        "no_next_action_ids": no_next_action_ids,
        "needs_attention_ids": needs_attention_ids,
        "under_control_ids": under_control_ids,
        "open_problem_count": _open_attention_issue_count(conn, active_ids),
        "quality": quality,
    }


def _pulse_workspace(user: policy.CurrentUser) -> dict[str, str]:
    if user.role_id in {policy.ROLE_DEPUTY_CHIEF, policy.ROLE_CAOP_HEAD}:
        return {
            "code": "clinic_pulse",
            "title": "Пульс клиники",
            "subtitle": "Состояние пациентских маршрутов и отклонения, требующие управленческого внимания",
        }
    if user.role_id == policy.ROLE_DEPARTMENT_HEAD:
        return {
            "code": "department_contour",
            "title": "Контур отделения",
            "subtitle": "Маршруты, сроки и проблемы пациентов вашего отделения",
        }
    if user.role_id == policy.ROLE_DOCTOR:
        return {
            "code": "my_day",
            "title": "Мой день",
            "subtitle": "Пациенты и действия, которые требуют вашего внимания",
        }
    return {
        "code": "admin",
        "title": "Административный обзор",
        "subtitle": "Сводное состояние доступных пациентских маршрутов",
    }


def pulse(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    state = _pulse_state(conn, user, filters)
    active_count = len(state["active_ids"])
    controlled_count = len(state["under_control_ids"])
    controlled_percent = percent(controlled_count, active_count) if active_count else None
    metrics = [
        {
            "code": "active_patients", "label": "Активные пациенты", "value": active_count,
            "unit": "count", "detail_type": "pulse_active", "definition": PULSE_DEFINITIONS["active_patients"],
        },
        {
            "code": "routes_under_control", "label": "Маршруты под контролем", "value": controlled_percent,
            "unit": "percent", "detail_type": "pulse_under_control", "definition": PULSE_DEFINITIONS["routes_under_control"],
            "numerator": controlled_count, "denominator": active_count,
        },
        {
            "code": "needs_attention", "label": "Требуют внимания", "value": len(state["needs_attention_ids"]),
            "unit": "count", "detail_type": "pulse_needs_attention", "definition": PULSE_DEFINITIONS["needs_attention"],
        },
        {
            "code": "overdue_routes", "label": "Просроченные маршруты", "value": len(state["overdue_ids"]),
            "unit": "count", "detail_type": "pulse_overdue", "definition": PULSE_DEFINITIONS["overdue_routes"],
        },
        {
            "code": "no_next_action", "label": "Без следующего действия", "value": len(state["no_next_action_ids"]),
            "unit": "count", "detail_type": "pulse_no_next_action", "definition": PULSE_DEFINITIONS["no_next_action"],
        },
        {
            "code": "open_problems", "label": "Открытые проблемы", "value": state["open_problem_count"],
            "unit": "count", "detail_type": "pulse_open_problems", "definition": PULSE_DEFINITIONS["open_problems"],
        },
    ]
    return {
        "meta": _computed_meta(user, filters, PULSE_DEFINITIONS),
        "workspace": _pulse_workspace(user),
        "metrics": metrics,
    }


def _checklist_state(conn: sqlite3.Connection, patient_ids: set[str]) -> dict:
    if not patient_ids:
        return {
            "total_required": 0,
            "completed_required": 0,
            "incomplete_required": 0,
            "patients": [],
            "by_stage": {},
            "by_doctor": {},
            "by_department": {},
        }
    cond, params = _ids_clause(conn, patient_ids)
    rows = conn.execute(
        f"""SELECT patients.id AS patient_id, patients.name, patients.stage, patients.nosology,
                   patients.treating_doctor_user_id, patients.doctor,
                   u.full_name AS treating_doctor_name,
                   h.stage AS history_stage, h.checklist_json,
                   GROUP_CONCAT(DISTINCT d.name) AS department_names
            FROM patients
            LEFT JOIN users u ON u.id = patients.treating_doctor_user_id
            LEFT JOIN user_departments ud ON ud.user_id = patients.treating_doctor_user_id
            LEFT JOIN departments d ON d.id = ud.department_id AND d.status = 'active'
            LEFT JOIN history_entries h ON h.id = (
                SELECT h2.id FROM history_entries h2
                WHERE h2.patient_id = patients.id ORDER BY h2.seq DESC LIMIT 1
            )
            WHERE {cond}
            GROUP BY patients.id
            ORDER BY patients.name ASC, patients.id ASC""",  # nosec B608
        params,
    ).fetchall()
    state = {
        "total_required": 0,
        "completed_required": 0,
        "incomplete_required": 0,
        "patients": [],
        "by_stage": defaultdict(lambda: {"total": 0, "completed": 0, "incomplete": 0}),
        "by_doctor": defaultdict(lambda: {"total": 0, "completed": 0, "incomplete": 0, "doctor_user_id": None}),
        "by_department": defaultdict(lambda: {"total": 0, "completed": 0, "incomplete": 0}),
    }
    for row in rows:
        current_stage = row["history_stage"] or row["stage"]
        required = data_quality.REQUIRED_CHECKLISTS.get(row["nosology"] or "", {}).get(current_stage or "", [])
        checklist = json.loads(row["checklist_json"]) if row["checklist_json"] else {}
        completed = sum(1 for item in required if checklist.get(item) is True)
        total = len(required)
        incomplete = total - completed
        state["total_required"] += total
        state["completed_required"] += completed
        state["incomplete_required"] += incomplete
        stage_key = current_stage or row["stage"] or ""
        stage_bucket = state["by_stage"][stage_key]
        stage_bucket["total"] += total
        stage_bucket["completed"] += completed
        stage_bucket["incomplete"] += incomplete
        doctor_name = row["treating_doctor_name"] or row["doctor"] or "Не назначен"
        doctor_bucket = state["by_doctor"][doctor_name]
        doctor_bucket["doctor_user_id"] = row["treating_doctor_user_id"]
        doctor_bucket["total"] += total
        doctor_bucket["completed"] += completed
        doctor_bucket["incomplete"] += incomplete
        departments = [x for x in (row["department_names"] or "").split(",") if x] or ["Отделение не указано"]
        for department in departments:
            dept_bucket = state["by_department"][department]
            dept_bucket["total"] += total
            dept_bucket["completed"] += completed
            dept_bucket["incomplete"] += incomplete
        if incomplete:
            state["patients"].append({
                "patient_id": row["patient_id"],
                "patient_name": row["name"],
                "stage": stage_key,
                "stage_label": stage_label(stage_key),
                "treating_doctor_name": doctor_name,
                "department_names": departments if departments != ["Отделение не указано"] else [],
                "total_required": total,
                "completed_required": completed,
                "incomplete_required": incomplete,
            })
    return state


def summary(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    quality = _quality_context(conn, user)
    patient_ids = _filtered_patient_ids(conn, user, filters, quality)
    rows = _patient_rows(conn, patient_ids)
    ids = {r["id"] for r in rows}
    overdue_issues = [i for i in quality["issues"] if i["code"] == "overdue_event" and i["patient_id"] in ids]
    critical = [i for i in quality["issues"] if i["severity"] == "critical" and i["patient_id"] in ids]
    warnings = [i for i in quality["issues"] if i["severity"] == "warning" and i["patient_id"] in ids]
    quality_patient_ids = {i["patient_id"] for i in quality["issues"] if i["patient_id"] in ids}
    attention_ids = patient_attention.active_patient_ids(conn, ids)
    checklist = _checklist_state(conn, ids)
    notification_counts = _notification_counts(conn, ids)
    cards = [
        {"code": "total_patients", "label": "Всего доступных пациентов", "value": len(ids), "kind": "current", "detail_type": "patients", "definition": SUMMARY_DEFINITIONS["total_patients"]},
        {"code": "active_patients", "label": "Активные", "value": sum(1 for r in rows if r["stage"] not in TERMINAL_STAGES), "kind": "current", "detail_type": "patients", "definition": SUMMARY_DEFINITIONS["active_patients"]},
        {"code": "completed_patients", "label": "Завершённые", "value": sum(1 for r in rows if r["stage"] == "completed"), "kind": "current", "detail_type": "patients", "definition": SUMMARY_DEFINITIONS["completed_patients"]},
        {"code": "patients_need_attention", "label": "Явно требуют внимания", "value": len(attention_ids), "kind": "current", "detail_type": "attention_patients", "definition": SUMMARY_DEFINITIONS["patients_need_attention"]},
        {"code": "data_quality_issues", "label": "Проблемы качества данных", "value": len(critical) + len(warnings), "kind": "current", "detail_type": "quality_warning", "definition": SUMMARY_DEFINITIONS["data_quality_issues"]},
        {"code": "unassigned_patients", "label": "Пациенты без назначенного врача", "value": sum(1 for r in rows if not r["treating_doctor_user_id"]), "kind": "current", "detail_type": "unassigned_patients", "definition": SUMMARY_DEFINITIONS["unassigned_patients"]},
        {"code": "patients_with_overdue", "label": "Пациенты с просроченными событиями", "value": len({i["patient_id"] for i in overdue_issues}), "kind": "current", "detail_type": "overdue_events", "definition": SUMMARY_DEFINITIONS["patients_with_overdue"]},
        {"code": "overdue_events", "label": "Просроченные события", "value": len(overdue_issues), "kind": "current", "detail_type": "overdue_events", "definition": SUMMARY_DEFINITIONS["overdue_events"]},
        {"code": "critical_quality", "label": "Критические проблемы качества данных", "value": len(critical), "kind": "current", "detail_type": "quality_critical", "definition": SUMMARY_DEFINITIONS["critical_quality"]},
        {"code": "warning_quality", "label": "Предупреждения качества данных", "value": len(warnings), "kind": "current", "detail_type": "quality_warning", "definition": SUMMARY_DEFINITIONS["warning_quality"]},
        {"code": "incomplete_required_checklists", "label": "Незавершённые обязательные чек-листы", "value": checklist["incomplete_required"], "kind": "current", "detail_type": "incomplete_checklists", "definition": SUMMARY_DEFINITIONS["incomplete_required_checklists"]},
        {"code": "pending_notifications", "label": "Ожидающие уведомления", "value": notification_counts["pending"], "kind": "current", "detail_type": "notifications_failed" if False else "notifications_pending", "definition": SUMMARY_DEFINITIONS["pending_notifications"]},
        {"code": "failed_notifications", "label": "Ошибки уведомлений", "value": notification_counts["failed"], "kind": "current", "detail_type": "notifications_failed", "definition": SUMMARY_DEFINITIONS["failed_notifications"]},
    ]
    return {"meta": _computed_meta(user, filters, SUMMARY_DEFINITIONS), "cards": cards}


def _profile_rows(rows: list[sqlite3.Row]) -> dict:
    total = len(rows)
    counter = Counter()
    meta_by_key: dict[str, dict] = {}
    for row in rows:
        code = (row["nosology"] or "").strip()
        if not code:
            key = ""
            label = "Не указан"
            codes: list[str] = []
        else:
            codes = _analytics_nosology_codes(code)
            key = codes[0]
            label = _localization_label(code)
        counter[key] += 1
        meta_by_key[key] = {"label": label, "codes": codes}
    result = []
    for code, count in sorted(counter.items(), key=lambda x: (-x[1], x[0] or "zz")):
        meta = meta_by_key[code]
        result.append({
            "code": code or "missing",
            "label": meta["label"],
            "count": count,
            "percent": percent(count, total),
            "detail_type": "patients",
            "filter": {"nosology": code} if code else {},
            "meta": {"nosology": code, "nosology_codes": meta["codes"]},
        })
    return {"title": "Пациенты по профилю клиентского пути", "total": total, "rows": result}


def _route_state_rows(rows: list[sqlite3.Row], quality: dict, patient_ids: set[str]) -> dict:
    total = len(rows)
    quality_ids = _quality_issue_ids(quality) & patient_ids
    active = sum(1 for row in rows if row["stage"] not in TERMINAL_STAGES)
    completed = sum(1 for row in rows if row["stage"] == "completed")
    dispensary = sum(1 for row in rows if row["stage"] == "dispensary-observation")
    not_confirmed = sum(1 for row in rows if row["stage"] == "diagnosis-not-confirmed")
    attention = len(quality_ids)
    return {
        "title": "Состояние маршрутов",
        "total": total,
        "rows": [
            {"code": "active", "label": "Активные", "count": active, "percent": percent(active, total), "detail_type": "patients", "filter": {}, "meta": {"overlap": False}},
            {"code": "completed", "label": "Завершённые", "count": completed, "percent": percent(completed, total), "detail_type": "patients", "filter": {"stage": "completed"}, "meta": {"overlap": False}},
            {"code": "dispensary_observation", "label": "Диспансерное наблюдение", "count": dispensary, "percent": percent(dispensary, total), "detail_type": "patients", "filter": {"stage": "dispensary-observation"}, "meta": {"overlap": False}},
            {"code": "diagnosis_not_confirmed", "label": "Диагноз не подтверждён", "count": not_confirmed, "percent": percent(not_confirmed, total), "detail_type": "patients", "filter": {"stage": "diagnosis-not-confirmed"}, "meta": {"overlap": False}},
            {"code": "operational_signals", "label": "Операционные сигналы", "count": attention, "percent": percent(attention, total), "detail_type": "quality_warning", "filter": {}, "meta": {"overlap": True}},
        ],
    }


def _quality_code_rows(quality: dict, patient_ids: set[str]) -> dict:
    issues = [issue for issue in quality["issues"] if issue["patient_id"] in patient_ids]
    by_code = Counter(issue["code"] for issue in issues)
    rows = []
    for code, count in sorted(by_code.items(), key=lambda x: (-x[1], x[0])):
        rows.append({
            "code": code,
            "label": QUALITY_CODE_LABELS.get(code, code),
            "count": count,
            "percent": percent(count, len(issues)),
            "detail_type": _quality_detail_type_for_code(issues, code),
            "filter": {"code": code},
            "meta": {"rule": data_quality.QUALITY_RULES.get(code, "")},
        })
    return {"title": "Самые частые проблемы качества данных", "total": len(issues), "rows": rows}


QUALITY_CODE_LABELS = {
    "missing_treating_doctor": "Не назначен лечащий врач",
    "missing_required_field": "Не заполнено поле",
    "missing_policy_number": "Не указан номер полиса ОМС",
    "missing_diagnosis": "Не указан диагноз",
    "missing_stage": "Не указан текущий этап",
    "invalid_phone": "Некорректный телефон",
    "actual_date_in_future": "Фактическая дата в будущем",
    "stage_sequence_violation": "Нарушение маршрута",
    "overdue_event": "Просроченное событие",
    "incomplete_required_checklist": "Незавершённый чек-лист",
    "possible_duplicate": "Возможный дубль",
}


def _quality_detail_type_for_code(issues: list[dict], code: str) -> str:
    severities = {issue["severity"] for issue in issues if issue["code"] == code}
    return "quality_critical" if "critical" in severities else "quality_warning"


def _attention_rows(rows: list[sqlite3.Row], quality: dict, patient_ids: set[str], checklist: dict) -> dict:
    issue_ids = _quality_issue_ids(quality) & patient_ids
    overdue_ids = _quality_issue_ids(quality, code="overdue_event") & patient_ids
    unassigned = sum(1 for row in rows if not row["treating_doctor_user_id"])
    critical = len([issue for issue in quality["issues"] if issue["severity"] == "critical" and issue["patient_id"] in patient_ids])
    rows_out = [
        {"code": "quality", "label": "Пациенты с проблемами качества данных", "count": len(issue_ids), "detail_type": "quality_warning", "filter": {}, "meta": {}},
        {"code": "overdue", "label": "Пациенты с просроченными событиями", "count": len(overdue_ids), "detail_type": "overdue_events", "filter": {}, "meta": {}},
        {"code": "unassigned", "label": "Без назначенного лечащего врача", "count": unassigned, "detail_type": "unassigned_patients", "filter": {}, "meta": {}},
        {"code": "critical", "label": "Критические проблемы", "count": critical, "detail_type": "quality_critical", "filter": {}, "meta": {}},
        {"code": "checklists", "label": "Незавершённые обязательные чек-листы", "count": checklist["incomplete_required"], "detail_type": "incomplete_checklists", "filter": {}, "meta": {}},
    ]
    rows_out = sorted(rows_out, key=lambda x: (-x["count"], x["label"]))
    return {"title": "Операционные сигналы", "total": len(issue_ids), "rows": rows_out}


def _trend_rows(conn: sqlite3.Connection, patient_ids: set[str], filters: AnalyticsFilters) -> dict:
    start, end = filters.period_or_default()
    truncated = False
    if (end - start).days > 89:
        start = end - timedelta(days=89)
        truncated = True
    days = (end - start).days + 1
    labels = [(start + timedelta(days=idx)) for idx in range(days)]
    created = Counter()
    completed = Counter()
    if patient_ids:
        cond, params = _ids_clause(conn, patient_ids)
        rows = conn.execute(  # nosec B608 - patient scope fragment is generated as placeholders by _ids_clause.
            f"SELECT patients.arrival FROM patients WHERE {cond}", params  # nosec B608
        ).fetchall()
        for row in rows:
            day = _safe_date(row["arrival"])
            if day and start <= day <= end:
                created[day] += 1
        hrows = conn.execute(
            f"""SELECT h.entered_at
                FROM history_entries h
                JOIN patients ON patients.id = h.patient_id
                WHERE {cond} AND h.stage = 'completed'""",  # nosec B608
            params,
        ).fetchall()
        for row in hrows:
            day = _safe_date(row["entered_at"])
            if day and start <= day <= end:
                completed[day] += 1
    return {
        "title": "Динамика за период",
        "period_days": days,
        "truncated": truncated,
        "max_days": 90,
        "rows": [
            {
                "date": day.isoformat(),
                "label": day.strftime("%d.%m"),
                "new_patients": created[day],
                "completed_patients": completed[day],
            }
            for day in labels
        ],
    }


def dashboard(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    quality = _quality_context(conn, user)
    patient_ids = _filtered_patient_ids(conn, user, filters, quality)
    rows = _patient_rows(conn, patient_ids)
    ids = {row["id"] for row in rows}
    checklist = _checklist_state(conn, ids)
    return {
        "meta": _computed_meta(user, filters, {"dashboard": "Агрегированный scoped dashboard без PHI и внешних запросов."}),
        "summary": summary(conn, user, filters),
        "stages": stages(conn, user, filters),
        "profiles": _profile_rows(rows),
        "route_state": _route_state_rows(rows, quality, ids),
        "data_quality": _quality_code_rows(quality, ids),
        "trend": _trend_rows(conn, ids, filters),
        "workload": workload(conn, user, filters),
        "attention": patient_attention.active_reason_breakdown(conn, ids),
        "operations": _attention_rows(rows, quality, ids, checklist),
    }


def stages(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    quality = _quality_context(conn, user)
    patient_ids = _filtered_patient_ids(conn, user, filters, quality)
    rows = _patient_rows(conn, patient_ids)
    total = len(rows)
    overdue_ids = _quality_issue_ids(quality, code="overdue_event") & patient_ids
    quality_ids = _quality_issue_ids(quality) & patient_ids
    by_stage: dict[str, dict] = {}
    for row in rows:
        stage = row["stage"] or ""
        item = by_stage.setdefault(stage, {
            "stage": stage,
            "stage_label": stage_label(stage),
            "count": 0,
            "percent": 0.0,
            "overdue_patients": 0,
            "quality_patients": 0,
            "detail_type": "patients",
        })
        item["count"] += 1
        if row["id"] in overdue_ids:
            item["overdue_patients"] += 1
        if row["id"] in quality_ids:
            item["quality_patients"] += 1
    for item in by_stage.values():
        item["percent"] = percent(item["count"], total)
    return {"meta": _computed_meta(user, filters), "total": total, "rows": ordered_stage_rows(by_stage)}


def _overdue_state(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    quality = _quality_context(conn, user)
    patient_ids = _filtered_patient_ids(conn, user, filters, quality)
    patient_map = {r["id"]: _patient_ref(r) for r in _patient_rows(conn, patient_ids)}
    issue_rows = [i for i in quality["issues"] if i["code"] == "overdue_event" and i["patient_id"] in patient_map]
    by_bucket = Counter()
    by_doctor = Counter()
    by_department = Counter()
    items = []
    for issue in issue_rows:
        planned_date = (issue.get("details") or {}).get("planned_date") or ""
        planned_day = _safe_date(planned_date)
        if filters.date_from and (planned_day is None or planned_day < filters.date_from):
            continue
        if filters.date_to and (planned_day is None or planned_day > filters.date_to):
            continue
        patient = patient_map[issue["patient_id"]]
        days = int((issue.get("details") or {}).get("days_overdue") or 0)
        bucket, bucket_label = overdue_bucket(days)
        by_bucket[(bucket, bucket_label)] += 1
        by_doctor[patient["treating_doctor_name"]] += 1
        departments = patient["department_names"] or ["Отделение не указано"]
        for department in departments:
            by_department[department] += 1
        items.append({
            **patient,
            "event_type": "Плановое событие",
            "planned_date": planned_date,
            "days_overdue": days,
        })
    items.sort(key=lambda x: (-x["days_overdue"], x["patient_name"], x["patient_id"]))
    return {
        "items": items,
        "by_bucket": by_bucket,
        "by_doctor": by_doctor,
        "by_department": by_department,
    }


def overdue(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    state = _overdue_state(conn, user, filters)
    items = state["items"]
    return {
        "meta": _computed_meta(user, filters, {
            "overdue_event": data_quality.QUALITY_RULES["overdue_event"],
            "period": "За выбранный период по planned_date; без date_from/date_to возвращаются текущие просрочки.",
        }),
        "total": len(items),
        "buckets": [{"code": k[0], "label": k[1], "count": v} for k, v in sorted(state["by_bucket"].items())],
        "by_doctor": [{"doctor_name": k, "count": v} for k, v in sorted(state["by_doctor"].items())],
        "by_department": [{"department_name": k, "count": v} for k, v in sorted(state["by_department"].items())],
        "items": items[filters.offset:filters.offset + filters.limit],
    }


def stage_durations(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    patient_ids = _filtered_patient_ids(conn, user, filters)
    if not patient_ids:
        return {
            "meta": _computed_meta(user, filters),
            "available": True,
            "reason": None,
            "stats": [],
            "current_stage_age": [],
        }
    cond, params = _ids_clause(conn, patient_ids)
    history_rows = conn.execute(
        f"""SELECT patients.id AS patient_id, patients.name, patients.stage AS current_stage,
                   h.stage, h.entered_at, h.seq
            FROM patients JOIN history_entries h ON h.patient_id = patients.id
            WHERE {cond}
            ORDER BY patients.id, h.seq ASC""",  # nosec B608
        params,
    ).fetchall()
    if not history_rows:
        return {
            "meta": _computed_meta(user, filters),
            "available": False,
            "reason": "stage_history_unavailable",
            "stats": [],
            "current_stage_age": [],
        }
    period_start, period_end = filters.period_or_default()
    by_patient: dict[str, list[sqlite3.Row]] = defaultdict(list)
    for row in history_rows:
        by_patient[row["patient_id"]].append(row)
    completed: dict[str, list[int]] = defaultdict(list)
    current_age = []
    today = today_local()
    for patient_rows in by_patient.values():
        for left, right in zip(patient_rows, patient_rows[1:]):
            start = _safe_date(left["entered_at"])
            end = _safe_date(right["entered_at"])
            if not start or not end or end < start:
                continue
            if not (period_start <= end <= period_end):
                continue
            completed[left["stage"]].append((end - start).days)
        last = patient_rows[-1]
        entered = _safe_date(last["entered_at"])
        if entered and entered <= today:
            current_age.append({
                "patient_id": last["patient_id"],
                "patient_name": last["name"],
                "stage": last["current_stage"],
                "stage_label": stage_label(last["current_stage"]),
                "days_on_current_stage": (today - entered).days,
            })
    stats = []
    for stage in STAGES:
        values = completed.get(stage, [])
        if not values:
            continue
        stats.append({"stage": stage, "stage_label": stage_label(stage), **duration_stats(values)})
    current_age.sort(key=lambda x: (-x["days_on_current_stage"], x["patient_name"]))
    return {
        "meta": _computed_meta(user, filters, {"stage_duration": "Только завершённые интервалы между соседними записями истории этапов."}),
        "available": True,
        "reason": None,
        "stats": stats,
        "current_stage_age": current_age[:filters.limit],
    }


def _safe_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def workload(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    quality = _quality_context(conn, user)
    patient_ids = _filtered_patient_ids(conn, user, filters, quality)
    rows = _patient_rows(conn, patient_ids)
    overdue_ids = _quality_issue_ids(quality, code="overdue_event") & patient_ids
    critical_by_patient = Counter(i["patient_id"] for i in quality["issues"] if i["severity"] == "critical" and i["patient_id"] in patient_ids)
    checklist = _checklist_state(conn, patient_ids)
    incomplete_by_patient = {p["patient_id"]: p["incomplete_required"] for p in checklist["patients"]}
    notif = _notification_status_by_patient(conn, patient_ids)
    buckets: dict[str, dict] = {}
    for row in rows:
        doctor = row["treating_doctor_name"] or row["doctor"] or "Не назначен"
        bucket = buckets.setdefault(doctor, {
            "doctor_user_id": row["treating_doctor_user_id"],
            "doctor_name": doctor,
            "department_ids": [x for x in (row["department_ids"] or "").split(",") if x],
            "department_names": [x for x in (row["department_names"] or "").split(",") if x],
            "active_patients": 0,
            "overdue_patients": 0,
            "incomplete_required_checklists": 0,
            "critical_quality_issues": 0,
            "pending_notifications": 0,
            "failed_notifications": 0,
        })
        if row["stage"] not in TERMINAL_STAGES:
            bucket["active_patients"] += 1
        if row["id"] in overdue_ids:
            bucket["overdue_patients"] += 1
        bucket["incomplete_required_checklists"] += incomplete_by_patient.get(row["id"], 0)
        bucket["critical_quality_issues"] += critical_by_patient.get(row["id"], 0)
        bucket["pending_notifications"] += notif[row["id"]]["pending"]
        bucket["failed_notifications"] += notif[row["id"]]["failed"]
    order_key = filters.sort if filters.sort in {"count", "workload"} else "active_patients"
    rows_out = sorted(buckets.values(), key=lambda x: (-x[order_key] if order_key in x else -x["active_patients"], x["doctor_name"]))
    if filters.order == "asc":
        rows_out = sorted(buckets.values(), key=lambda x: (x[order_key] if order_key in x else x["active_patients"], x["doctor_name"]))
    return {"meta": _computed_meta(user, filters), "title": "Распределение рабочей нагрузки", "rows": rows_out[:filters.limit]}


def _notification_status_by_patient(conn: sqlite3.Connection, patient_ids: set[str]) -> dict[str, Counter]:
    result: dict[str, Counter] = defaultdict(Counter)
    if not patient_ids:
        return result
    cond, params = _ids_clause(conn, patient_ids)
    rows = conn.execute(
        f"""SELECT notifications.patient_id, notifications.status, COUNT(*) AS c
            FROM notifications JOIN patients ON patients.id = notifications.patient_id
            WHERE {cond}
            GROUP BY notifications.patient_id, notifications.status""",  # nosec B608
        params,
    ).fetchall()
    for row in rows:
        result[row["patient_id"]][row["status"]] = row["c"]
    return result


def data_quality_state(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    quality = _quality_context(conn, user)
    patient_ids = _filtered_patient_ids(conn, user, filters, quality)
    patient_map = {r["id"]: _patient_ref(r) for r in _patient_rows(conn, patient_ids)}
    issues = [i for i in quality["issues"] if i["patient_id"] in patient_map]
    by_severity = Counter(i["severity"] for i in issues)
    by_code = Counter(i["code"] for i in issues)
    by_doctor = Counter(patient_map[i["patient_id"]]["treating_doctor_name"] for i in issues)
    by_department = Counter()
    for issue in issues:
        for department in patient_map[issue["patient_id"]]["department_names"] or ["Отделение не указано"]:
            by_department[department] += 1
    return {
        "meta": _computed_meta(user, filters, {"history": "Центр качества данных не хранит историю проблем; показано текущее состояние."}),
        "title": "Текущее состояние качества данных",
        "current_state_only": True,
        "summary": {**quality["summary"], "total_patients": len(patient_ids), "total_issues": len(issues)},
        "by_severity": [{"severity": k, "count": by_severity[k]} for k in data_quality.SEVERITIES],
        "by_code": [{"code": k, "count": v} for k, v in sorted(by_code.items())],
        "by_doctor": [{"doctor_name": k, "count": v} for k, v in sorted(by_doctor.items())],
        "by_department": [{"department_name": k, "count": v} for k, v in sorted(by_department.items())],
    }


def checklists(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    patient_ids = _filtered_patient_ids(conn, user, filters)
    state = _checklist_state(conn, patient_ids)
    total = state["total_required"]
    completed = state["completed_required"]
    incomplete = state["incomplete_required"]
    completion = round(completed / total * 100, 1) if total else None
    def rows_from_counter(data: dict, name_key: str):
        rows = []
        for key, bucket in sorted(data.items()):
            rows.append({
                name_key: key,
                "total_required_items": bucket["total"],
                "completed_required_items": bucket["completed"],
                "incomplete_required_items": bucket["incomplete"],
                "completion_percent": round(bucket["completed"] / bucket["total"] * 100, 1) if bucket["total"] else None,
                **({"doctor_user_id": bucket.get("doctor_user_id")} if "doctor_user_id" in bucket else {}),
            })
        return rows
    by_stage = [
        {"stage": stage, "stage_label": stage_label(stage), "total_required_items": bucket["total"],
         "completed_required_items": bucket["completed"], "incomplete_required_items": bucket["incomplete"],
         "completion_percent": round(bucket["completed"] / bucket["total"] * 100, 1) if bucket["total"] else None}
        for stage, bucket in sorted(state["by_stage"].items())
    ]
    return {
        "meta": _computed_meta(user, filters),
        "formula": "completed_required_items / total_required_items * 100; необязательные пункты не включаются",
        "total_required_items": total,
        "completed_required_items": completed,
        "incomplete_required_items": incomplete,
        "completion_percent": completion,
        "status": "нет обязательных пунктов" if total == 0 else "computed",
        "by_stage": by_stage,
        "by_doctor": rows_from_counter(state["by_doctor"], "doctor_name"),
        "by_department": rows_from_counter(state["by_department"], "department_name"),
        "patients": state["patients"][:filters.limit],
    }


def notifications_state(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters) -> dict:
    patient_ids = _filtered_patient_ids(conn, user, filters)
    if not patient_ids:
        rows = []
    else:
        cond, params = _ids_clause(conn, patient_ids)
        rows = conn.execute(
            f"""SELECT notifications.status, notifications.template_code, notifications.source_type,
                       notifications.error_code, t.name AS template_name, COUNT(*) AS c
                FROM notifications
                JOIN patients ON patients.id = notifications.patient_id
                LEFT JOIN notification_templates t ON t.code = notifications.template_code
                WHERE {cond}
                GROUP BY notifications.status, notifications.template_code, notifications.source_type, notifications.error_code, t.name""",  # nosec B608
            params,
        ).fetchall()
    status_counts = {status: 0 for status in notifications.QUEUE_STATUSES}
    by_template: Counter = Counter()
    by_source: Counter = Counter()
    reasons: Counter = Counter()
    errors: Counter = Counter()
    for row in rows:
        status_counts[row["status"]] += row["c"]
        by_template[(row["template_code"], row["template_name"] or row["template_code"])] += row["c"]
        by_source[row["source_type"]] += row["c"]
        if row["error_code"]:
            reasons[row["error_code"]] += row["c"]
            if row["status"] == "failed":
                errors[row["error_code"]] += row["c"]
    no_consent, invalid_phone = _notification_patient_preconditions(conn, patient_ids)
    reasons["no_consent"] += no_consent
    reasons["invalid_phone"] += invalid_phone
    return {
        "meta": _computed_meta(user, filters, {"sent": "Статус sent означает обработку MockProvider, а не подтверждённую доставку пациенту."}),
        "provider": config.NOTIFICATION_PROVIDER,
        "status_counts": status_counts,
        "skip_reasons": dict(sorted(reasons.items())),
        "by_template": [{"template_code": k[0], "template_name": k[1], "count": v} for k, v in sorted(by_template.items())],
        "by_source": [{"source_type": k, "count": v} for k, v in sorted(by_source.items())],
        "technical_errors": [{"error_code": k, "count": v} for k, v in sorted(errors.items())],
    }


def _notification_patient_preconditions(conn: sqlite3.Connection, patient_ids: set[str]) -> tuple[int, int]:
    if not patient_ids:
        return 0, 0
    cond, params = _ids_clause(conn, patient_ids)
    rows = conn.execute(
        f"""SELECT patients.phone, COALESCE(pref.consent_status, 'not_recorded') AS consent_status,
                   COALESCE(pref.sms_enabled, 0) AS sms_enabled
            FROM patients
            LEFT JOIN patient_notification_preferences pref ON pref.patient_id = patients.id
            WHERE {cond}""",  # nosec B608
        params,
    ).fetchall()
    no_consent = 0
    invalid_phone = 0
    for row in rows:
        if row["consent_status"] != "granted" or not row["sms_enabled"]:
            no_consent += 1
        ok, reason = phone_sendable(row["phone"])
        if not ok and reason == "invalid_phone":
            invalid_phone += 1
    return no_consent, invalid_phone


DETAIL_TYPES = {
    "patients",
    "unassigned_patients",
    "overdue_events",
    "quality_critical",
    "quality_warning",
    "incomplete_checklists",
    "notifications_pending",
    "notifications_failed",
    "attention_patients",
    "pulse_active",
    "pulse_under_control",
    "pulse_needs_attention",
    "pulse_overdue",
    "pulse_no_next_action",
    "pulse_open_problems",
}


def _open_attention_details(conn: sqlite3.Connection, patient_ids: set[str]) -> list[dict[str, Any]]:
    if not patient_ids:
        return []
    cond, params = _ids_clause(conn, patient_ids)
    rows = conn.execute(
        f"""SELECT i.id AS issue_id, i.patient_id, i.reason_code, i.created_at,
                   patients.name AS patient_name, patients.stage,
                   u.full_name AS treating_doctor_name, patients.doctor,
                   GROUP_CONCAT(DISTINCT d.name) AS department_names
            FROM patient_attention_issues i
            JOIN patients ON patients.id = i.patient_id
            LEFT JOIN users u ON u.id = patients.treating_doctor_user_id
            LEFT JOIN user_departments ud ON ud.user_id = patients.treating_doctor_user_id
            LEFT JOIN departments d ON d.id = ud.department_id AND d.status = 'active'
            WHERE {cond} AND i.status = 'open'
            GROUP BY i.id
            ORDER BY i.created_at ASC, i.id ASC""",  # nosec B608 - generated patient-id placeholders only.
        params,
    ).fetchall()
    return [
        {
            "issue_id": row["issue_id"],
            "patient_id": row["patient_id"],
            "patient_name": row["patient_name"],
            "stage": row["stage"],
            "stage_label": stage_label(row["stage"]),
            "treating_doctor_name": row["treating_doctor_name"] or row["doctor"] or "Не назначен",
            "department_names": [x for x in (row["department_names"] or "").split(",") if x],
            "reason_code": row["reason_code"],
            "reason_label": patient_attention.reason_label(row["reason_code"]),
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def details(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters, detail_type: str) -> dict:
    if detail_type not in DETAIL_TYPES:
        raise ValueError("unknown detail type")
    items: list[dict[str, Any]]
    if detail_type.startswith("pulse_"):
        pulse_state = _pulse_state(conn, user, filters)
        detail_ids = {
            "pulse_active": pulse_state["active_ids"],
            "pulse_under_control": pulse_state["under_control_ids"],
            "pulse_needs_attention": pulse_state["needs_attention_ids"],
            "pulse_overdue": pulse_state["overdue_ids"],
            "pulse_no_next_action": pulse_state["no_next_action_ids"],
        }
        if detail_type == "pulse_open_problems":
            items = _open_attention_details(conn, pulse_state["active_ids"])
        else:
            items = [_patient_ref(r) for r in _patient_rows(conn, detail_ids[detail_type])]
    else:
        quality = _quality_context(conn, user)
        patient_ids = _filtered_patient_ids(conn, user, filters, quality)
        if detail_type == "patients":
            items = [_patient_ref(r) for r in _patient_rows(conn, patient_ids)]
        elif detail_type == "unassigned_patients":
            items = [_patient_ref(r) for r in _patient_rows(conn, patient_ids) if not r["treating_doctor_user_id"]]
        elif detail_type == "attention_patients":
            attention_ids = patient_attention.active_patient_ids(conn, patient_ids, filters.attention_reason)
            items = [_patient_ref(r) for r in _patient_rows(conn, attention_ids)]
        elif detail_type == "overdue_events":
            items = _overdue_state(conn, user, filters)["items"]
        elif detail_type in {"quality_critical", "quality_warning"}:
            sev = "critical" if detail_type.endswith("critical") else "warning"
            patient_map = {r["id"]: _patient_ref(r) for r in _patient_rows(conn, patient_ids)}
            items = [
                {"code": i["code"], "severity": i["severity"], "title": i["title"], **patient_map[i["patient_id"]]}
                for i in quality["issues"] if i["severity"] == sev and i["patient_id"] in patient_map
            ]
        elif detail_type == "incomplete_checklists":
            items = _checklist_state(conn, patient_ids)["patients"]
        elif detail_type in {"notifications_pending", "notifications_failed"}:
            status_value = "pending" if detail_type.endswith("pending") else "failed"
            items = _notification_details(conn, patient_ids, status_value, filters)
        else:
            items = []
    total = len(items)
    items = items[filters.offset:filters.offset + filters.limit]
    return {
        "meta": _computed_meta(user, filters),
        "detail_type": detail_type,
        "total": total,
        "limit": filters.limit,
        "offset": filters.offset,
        "items": items,
    }


def _notification_details(conn: sqlite3.Connection, patient_ids: set[str], status_value: str, filters: AnalyticsFilters) -> list[dict]:
    if not patient_ids:
        return []
    cond, params = _ids_clause(conn, patient_ids)
    rows = conn.execute(
        f"""SELECT notifications.id, notifications.patient_id, notifications.template_code,
                   notifications.source_type, notifications.scheduled_at, notifications.status,
                   notifications.error_code, notifications.error_message_safe,
                   patients.name AS patient_name, patients.stage,
                   u.full_name AS treating_doctor_name, patients.doctor
            FROM notifications
            JOIN patients ON patients.id = notifications.patient_id
            LEFT JOIN users u ON u.id = patients.treating_doctor_user_id
            WHERE {cond} AND notifications.status = ?
            ORDER BY notifications.scheduled_at ASC, notifications.id ASC""",  # nosec B608
        [*params, status_value],
    ).fetchall()
    return [
        {
            "notification_id": r["id"],
            "patient_id": r["patient_id"],
            "patient_name": r["patient_name"],
            "stage": r["stage"],
            "stage_label": stage_label(r["stage"]),
            "treating_doctor_name": r["treating_doctor_name"] or r["doctor"] or "Не назначен",
            "template_code": r["template_code"],
            "source_type": r["source_type"],
            "scheduled_at": r["scheduled_at"],
            "status": r["status"],
            "error_code": r["error_code"],
            "error_message_safe": r["error_message_safe"],
        }
        for r in rows
    ]


def export(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters, sections: list[str] | None = None) -> dict:
    allowed = {"summary", "stages", "workload", "data_quality", "checklists", "notifications"}
    selected = [s for s in (sections or ["summary", "stages", "workload"]) if s in allowed]
    rows: list[dict[str, Any]] = []
    if "summary" in selected:
        for card in summary(conn, user, filters)["cards"]:
            rows.append({"section": "summary", "metric": card["code"], "label": card["label"], "value": card["value"]})
    if "stages" in selected:
        for row in stages(conn, user, filters)["rows"]:
            rows.append({"section": "stages", "stage": row["stage"], "label": row["stage_label"], "count": row["count"], "percent": row["percent"]})
    if "workload" in selected:
        for row in workload(conn, user, filters)["rows"]:
            rows.append({"section": "workload", "doctor": row["doctor_name"], "active_patients": row["active_patients"], "overdue_patients": row["overdue_patients"]})
    if "data_quality" in selected:
        for row in data_quality_state(conn, user, filters)["by_severity"]:
            rows.append({"section": "data_quality", **row})
    if "checklists" in selected:
        data = checklists(conn, user, filters)
        rows.append({"section": "checklists", "metric": "completion_percent", "value": data["completion_percent"], "status": data["status"]})
    if "notifications" in selected:
        data = notifications_state(conn, user, filters)
        for status_value, count in data["status_counts"].items():
            rows.append({"section": "notifications", "status": status_value, "count": count})
    return {
        "meta": _computed_meta(user, filters, {"export": "Безопасный агрегированный JSON без телефонов, SMS body и медицинских полей."}),
        "format": "json",
        "sections": selected,
        "rows": rows,
    }


CSV_REPORT_TYPES = {"summary", "stages", "workload", "data_quality", "checklists", "notifications"}
CSV_DETAIL_LEVELS = {"aggregate", "details"}
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r", "\n")


def csv_safe_cell(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.lstrip(" \t\r\n\v\f")
    if stripped.startswith(CSV_FORMULA_PREFIXES):
        return "'" + value
    return value


def csv_filename(report_type: str, *, now: datetime | None = None) -> str:
    safe_type = report_type if report_type in CSV_REPORT_TYPES else "summary"
    stamp = (now or datetime.now(app_timezone())).strftime("%Y%m%d_%H%M%S")
    return f"analytics_{safe_type}_{stamp}.csv"


def export_csv(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters, *, report_type: str, detail_level: str) -> dict:
    if report_type not in CSV_REPORT_TYPES:
        raise ValueError("unknown report_type")
    if detail_level not in CSV_DETAIL_LEVELS:
        raise ValueError("unknown detail_level")
    rows = _csv_rows(conn, user, filters, report_type=report_type, detail_level=detail_level)
    output = io.StringIO()
    output.write("\ufeff")
    writer = csv.DictWriter(output, fieldnames=_csv_headers(report_type, detail_level), extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow({key: csv_safe_cell(value) for key, value in row.items()})
    return {
        "content": output.getvalue().encode("utf-8"),
        "filename": csv_filename(report_type),
        "row_count": len(rows),
        "content_type": "text/csv; charset=utf-8",
    }


def _csv_headers(report_type: str, detail_level: str) -> list[str]:
    if report_type == "summary":
        return ["metric", "label", "value", "kind", "definition"]
    if report_type == "stages":
        return ["stage", "stage_label", "count", "percent", "overdue_patients", "quality_patients"]
    if report_type == "workload":
        return ["doctor_name", "department_names", "active_patients", "overdue_patients", "incomplete_required_checklists", "critical_quality_issues", "pending_notifications", "failed_notifications"]
    if report_type == "data_quality":
        return ["severity", "code", "label", "count"]
    if report_type == "checklists":
        return ["scope", "label", "total_required_items", "completed_required_items", "incomplete_required_items", "completion_percent", "status"]
    if report_type == "notifications":
        return ["status", "label", "count"]
    return ["metric", "value"]


def _csv_rows(conn: sqlite3.Connection, user: policy.CurrentUser, filters: AnalyticsFilters, *, report_type: str, detail_level: str) -> list[dict]:
    if report_type == "summary":
        return [
            {"metric": card["code"], "label": card["label"], "value": card["value"], "kind": card["kind"], "definition": card["definition"]}
            for card in summary(conn, user, filters)["cards"]
        ]
    if report_type == "stages":
        return stages(conn, user, filters)["rows"]
    if report_type == "workload":
        return [
            {**row, "department_names": ", ".join(row.get("department_names") or [])}
            for row in workload(conn, user, filters)["rows"]
        ]
    if report_type == "data_quality":
        dq = data_quality_state(conn, user, filters)
        rows = [
            {"severity": row["severity"], "label": row["severity"], "count": row["count"]}
            for row in dq["by_severity"]
        ]
        if detail_level == "details":
            rows.extend({"code": row["code"], "label": row["code"], "count": row["count"]} for row in dq["by_code"])
        return rows
    if report_type == "checklists":
        data = checklists(conn, user, filters)
        rows = [{
            "scope": "total",
            "label": data["status"],
            "total_required_items": data["total_required_items"],
            "completed_required_items": data["completed_required_items"],
            "incomplete_required_items": data["incomplete_required_items"],
            "completion_percent": data["completion_percent"],
            "status": data["status"],
        }]
        if detail_level == "details":
            rows.extend({
                "scope": "stage",
                "label": row["stage_label"],
                "total_required_items": row["total_required_items"],
                "completed_required_items": row["completed_required_items"],
                "incomplete_required_items": row["incomplete_required_items"],
                "completion_percent": row["completion_percent"],
                "status": "computed" if row["total_required_items"] else "Нет обязательных пунктов",
            } for row in data["by_stage"])
        return rows
    if report_type == "notifications":
        data = notifications_state(conn, user, filters)
        labels = {
            "pending": "Ожидает отправки",
            "processing": "Отправляется",
            "sent": "Отправлено",
            "failed": "Ошибка отправки",
            "cancelled": "Отменено",
            "skipped": "Пропущено",
        }
        return [
            {"status": status, "label": labels.get(status, status), "count": count}
            for status, count in data["status_counts"].items()
        ]
    return []
