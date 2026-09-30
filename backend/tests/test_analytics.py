"""Management analytics API: scope, filters, aggregation and safe exports."""
from __future__ import annotations

import json
from datetime import timedelta

from .conftest import TEST_PASSWORD, create_account, create_department, get_conn, login, make_patient_payload


def _as_user(client, username: str):
    r = login(client, username, TEST_PASSWORD)
    assert r.status_code == 200, r.text


def _create_patient(doctor_id=None, **overrides):
    from backend.app import store
    from backend.app.models import PatientCreateIn

    return store.create_patient(get_conn(), PatientCreateIn(**make_patient_payload(**overrides)), doctor_id)


def _stand(client):
    dept_a = create_department("Аналитика А")
    dept_b = create_department("Аналитика Б")
    create_account("analytics.dev", "developer", "Разработчик Аналитики")
    create_account("analytics.read", "deputy_chief_oncology", "Глобальный Просмотр")
    create_account("analytics.caop", "caop_head", "ЦАОП Аналитики")
    head_a = create_account("analytics.head.a", "department_head", "Заведующий Аналитика А", department_ids=[dept_a])
    doc_a = create_account("analytics.doc.a", "doctor", "Врач Аналитика А", department_ids=[dept_a])
    doc_b = create_account("analytics.doc.b", "doctor", "Врач Аналитика Б", department_ids=[dept_b])
    p_a = _create_patient(
        doc_a,
        name="Аналитика Пациент А",
        phone="+7 (999) 101-10-10",
        diagnosis="C34.1 скрытый диагноз",
        nosology="lung34",
        events=[{"date": "2000-01-01"}],
    )
    p_b = _create_patient(
        doc_b,
        name="Аналитика Пациент Б",
        phone="+7 (999) 202-20-20",
        diagnosis="C50.1 скрытый диагноз",
        nosology="breast",
        events=[{"date": "2999-01-01"}],
    )
    p_unassigned = _create_patient(
        None,
        name="Аналитика Без Врача",
        phone="телефон неизвестен",
        diagnosis="C61 скрытый диагноз",
        nosology="prostate",
    )
    return {
        "dept_a": dept_a,
        "dept_b": dept_b,
        "head_a": head_a,
        "doc_a": doc_a,
        "doc_b": doc_b,
        "p_a": p_a,
        "p_b": p_b,
        "p_unassigned": p_unassigned,
    }


def _card(body, code):
    return next(card for card in body["cards"] if card["code"] == code)


def test_analytics_requires_authentication_and_validates_filters(client):
    assert client.get("/api/analytics/summary").status_code == 401
    _stand(client)
    _as_user(client, "analytics.dev")
    assert client.get("/api/analytics/summary?stage=unknown").status_code == 422
    assert client.get("/api/analytics/summary?date_from=2026-02-01&date_to=2026-01-01").status_code == 422
    assert client.get("/api/analytics/details?type=patients&limit=201").status_code == 422
    assert client.get("/api/analytics/details?type=unknown").status_code == 422
    assert client.post("/api/analytics/export", json={"reportType": "unknown"}, headers=client.csrf).status_code == 422


def test_registered_analytics_routes_inventory():
    from backend.app.main import app

    routes = set()
    for route in app.routes:
        router = getattr(route, "original_router", None)
        for child in getattr(router, "routes", []) if router else [route]:
            path = getattr(child, "path", "")
            if path.startswith("/api/analytics"):
                routes.add((tuple(sorted(child.methods)), path, child.name))
    assert routes >= {
        (("GET",), "/api/analytics/pulse", "pulse"),
        (("GET",), "/api/analytics/summary", "summary"),
        (("GET",), "/api/analytics/dashboard", "dashboard"),
        (("GET",), "/api/analytics/stages", "stages"),
        (("GET",), "/api/analytics/overdue", "overdue"),
        (("GET",), "/api/analytics/stage-durations", "stage_durations"),
        (("GET",), "/api/analytics/workload", "workload"),
        (("GET",), "/api/analytics/data-quality", "data_quality"),
        (("GET",), "/api/analytics/checklists", "checklists"),
        (("GET",), "/api/analytics/notifications", "notifications"),
        (("GET",), "/api/analytics/details", "details"),
        (("POST",), "/api/analytics/export", "export"),
    }


def test_executive_pulse_metrics_drilldown_and_role_scope(client):
    ids = _stand(client)
    _as_user(client, "analytics.dev")
    created = client.post(
        f"/api/patients/{ids['p_a']}/attention",
        json={"reasonCode": "critical_overdue", "comment": "Синтетический контрольный пример"},
        headers=client.csrf,
    )
    assert created.status_code == 201, created.text

    pulse = client.get("/api/analytics/pulse").json()
    metrics = {metric["code"]: metric for metric in pulse["metrics"]}
    assert pulse["workspace"]["code"] == "admin"
    assert metrics["active_patients"]["value"] == 3
    assert metrics["routes_under_control"]["value"] == 33.3
    assert metrics["routes_under_control"]["numerator"] == 1
    assert metrics["routes_under_control"]["denominator"] == 3
    assert metrics["needs_attention"]["value"] == 2
    assert metrics["overdue_routes"]["value"] == 1
    assert metrics["no_next_action"]["value"] == 2
    assert metrics["open_problems"]["value"] == 1
    assert metrics["needs_attention"]["label"] == "Пациенты с сигналами риска"
    assert metrics["needs_attention"]["unit_label"] == "уникальные пациенты"
    assert metrics["overdue_routes"]["label"] == "Пациенты с просрочкой"
    assert metrics["open_problems"]["unit_label"] == "проблемы"
    assert pulse["meta"]["definitions"]["routes_under_control"]

    overdue = client.get("/api/analytics/details?type=pulse_overdue").json()
    assert overdue["total"] == 1
    assert overdue["items"][0]["patient_id"] == ids["p_a"]
    problems = client.get("/api/analytics/details?type=pulse_open_problems").json()
    assert problems["total"] == 1
    assert problems["items"][0]["reason_code"] == "critical_overdue"

    _as_user(client, "analytics.read")
    assert client.get("/api/analytics/pulse").json()["workspace"]["code"] == "clinic_pulse"

    _as_user(client, "analytics.head.a")
    head_pulse = client.get("/api/analytics/pulse").json()
    assert head_pulse["workspace"]["code"] == "department_contour"
    assert {m["code"]: m["value"] for m in head_pulse["metrics"]}["active_patients"] == 1

    _as_user(client, "analytics.doc.a")
    doctor_pulse = client.get("/api/analytics/pulse").json()
    assert doctor_pulse["workspace"]["code"] == "my_day"
    assert {m["code"]: m["value"] for m in doctor_pulse["metrics"]}["active_patients"] == 1
    scoped = client.get("/api/analytics/details?type=pulse_needs_attention").json()
    assert [item["patient_id"] for item in scoped["items"]] == [ids["p_a"]]


def test_executive_pulse_empty_scope_does_not_invent_control_rate(client):
    create_account("analytics.pulse.empty", "deputy_chief_oncology", "Пустой Руководитель")
    _as_user(client, "analytics.pulse.empty")
    pulse = client.get("/api/analytics/pulse").json()
    metrics = {metric["code"]: metric for metric in pulse["metrics"]}
    assert metrics["active_patients"]["value"] == 0
    assert metrics["routes_under_control"]["value"] is None
    assert metrics["routes_under_control"]["denominator"] == 0


def test_dashboard_empty_database_contract(client):
    create_account("analytics.empty.dev", "developer", "Разработчик Empty")
    _as_user(client, "analytics.empty.dev")
    body = client.get("/api/analytics/dashboard").json()
    cards = {card["code"]: card["value"] for card in body["summary"]["cards"]}
    assert cards["total_patients"] == 0
    assert cards["active_patients"] == 0
    assert cards["completed_patients"] == 0
    assert body["stages"]["rows"] == []
    assert body["profiles"]["rows"] == []
    route_rows = {row["code"]: row for row in body["route_state"]["rows"]}
    assert {"active", "completed", "dispensary_observation", "diagnosis_not_confirmed", "operational_signals"} <= set(route_rows)
    assert route_rows["operational_signals"]["meta"]["overlap"] is True
    assert body["attention"]["title"] == "Причины внимания"
    assert len(body["trend"]["rows"]) == 30
    capped = client.get("/api/analytics/dashboard?date_from=1900-01-01&date_to=2999-12-31").json()
    assert capped["trend"]["period_days"] == 90
    assert capped["trend"]["truncated"] is True


def test_dashboard_visual_aggregates_filters_and_scope(client):
    ids = _stand(client)
    completed = _create_patient(
        ids["doc_a"],
        name="Аналитика Завершён",
        phone="+7 (999) 303-30-30",
        diagnosis="C34.2 скрытый диагноз",
        nosology="lung34",
        stage="completed",
        events=[],
    )
    conn = get_conn()
    with conn:
        conn.execute("UPDATE patients SET arrival = '2026-08-02T10:00:00+00:00' WHERE id = ?", (completed,))
        conn.execute(
            """INSERT INTO history_entries (id, patient_id, seq, stage, entered_at, checklist_json, note)
               VALUES ('analytics_dashboard_completed', ?, 1, 'completed', '2026-08-03T00:00:00+00:00', NULL, '')""",
            (completed,),
        )
    _as_user(client, "analytics.dev")
    body = client.get("/api/analytics/dashboard?date_from=2026-08-01&date_to=2026-08-30").json()
    cards = {card["code"]: card["value"] for card in body["summary"]["cards"]}
    assert cards["total_patients"] == 4
    assert cards["active_patients"] == 3
    assert cards["completed_patients"] == 1
    assert cards["unassigned_patients"] == 1
    assert cards["data_quality_issues"] >= 1
    stages = {row["stage"]: row for row in body["stages"]["rows"]}
    assert stages["completed"]["count"] == 1
    assert round(sum(row["percent"] for row in body["profiles"]["rows"]), 1) in (99.9, 100.0, 100.1)
    profile_rows = {row["meta"]["nosology"]: row for row in body["profiles"]["rows"]}
    assert profile_rows["lung12"]["count"] == 2
    assert profile_rows["lung12"]["meta"]["nosology_codes"] == ["lung12", "lung34"]
    route_rows = {row["code"]: row for row in body["route_state"]["rows"]}
    assert route_rows["operational_signals"]["meta"]["overlap"] is True
    assert route_rows["dispensary_observation"]["count"] == 0
    assert route_rows["diagnosis_not_confirmed"]["count"] == 0
    assert body["data_quality"]["rows"] == sorted(body["data_quality"]["rows"], key=lambda row: (-row["count"], row["code"]))
    assert sum(row["new_patients"] for row in body["trend"]["rows"]) >= 1
    assert sum(row["completed_patients"] for row in body["trend"]["rows"]) >= 1
    assert body["attention"]["rows"] == sorted(body["attention"]["rows"], key=lambda row: (-row["count"], row["label"]))

    filtered = client.get("/api/analytics/dashboard?nosology=lung34").json()
    assert filtered["summary"]["cards"][0]["value"] == 2

    _as_user(client, "analytics.doc.a")
    scoped = client.get(f"/api/analytics/dashboard?doctor_user_id={ids['doc_b']}").json()
    assert scoped["summary"]["cards"][0]["value"] == 0
    assert scoped["workload"]["rows"] == []


def test_analytics_localization_filter_groups_duplicate_profile_labels(client):
    ids = _stand(client)
    _create_patient(
        ids["doc_a"],
        name="Аналитика Пациент Лёгкое 12",
        phone="+7 (999) 404-40-40",
        diagnosis="C34.3 скрытый диагноз",
        nosology="lung12",
        events=[],
    )

    _as_user(client, "analytics.dev")
    body = client.get("/api/analytics/dashboard").json()
    lung_rows = [row for row in body["profiles"]["rows"] if row["label"] == "Лёгкое"]
    assert len(lung_rows) == 1
    assert lung_rows[0]["count"] == 2
    assert lung_rows[0]["meta"]["nosology"] == "lung12"
    assert lung_rows[0]["meta"]["nosology_codes"] == ["lung12", "lung34"]

    filtered_by_lung12 = client.get("/api/analytics/dashboard?nosology=lung12").json()
    filtered_by_lung34 = client.get("/api/analytics/dashboard?nosology=lung34").json()
    assert filtered_by_lung12["summary"]["cards"][0]["value"] == 2
    assert filtered_by_lung34["summary"]["cards"][0]["value"] == 2

    _as_user(client, "analytics.doc.a")
    outside_scope = client.get(f"/api/analytics/dashboard?nosology=lung12&doctor_user_id={ids['doc_b']}").json()
    assert outside_scope["summary"]["cards"][0]["value"] == 0


def test_summary_stages_overdue_and_details_respect_patient_scope(client):
    ids = _stand(client)

    _as_user(client, "analytics.dev")
    summary = client.get("/api/analytics/summary").json()
    assert _card(summary, "total_patients")["value"] == 3
    assert _card(summary, "unassigned_patients")["value"] == 1
    assert _card(summary, "patients_with_overdue")["value"] == 1
    assert _card(summary, "total_patients")["kind"] == "current"
    assert "локализации/клиентскому пути" in json.dumps(summary, ensure_ascii=False)
    assert client.get("/api/analytics/summary?date_from=2999-01-01&date_to=2999-01-31").json()["cards"][0]["value"] == 3

    stages = client.get("/api/analytics/stages").json()
    assert stages["total"] == 3
    assert sum(row["count"] for row in stages["rows"]) == 3
    assert all("percent" in row for row in stages["rows"])

    overdue = client.get("/api/analytics/overdue").json()
    assert overdue["total"] == 1
    assert overdue["items"][0]["patient_id"] == ids["p_a"]
    assert overdue["items"][0]["planned_date"] == "2000-01-01"
    assert overdue["items"][0]["days_overdue"] > 0
    assert client.get("/api/analytics/overdue?date_from=2000-01-01&date_to=2000-01-01").json()["total"] == 1
    assert client.get("/api/analytics/overdue?date_from=2000-01-02&date_to=2000-01-02").json()["total"] == 0

    details = client.get("/api/analytics/details?type=patients&limit=2&offset=1").json()
    assert details["limit"] == 2
    assert details["offset"] == 1
    assert details["total"] == 3
    assert len(details["items"]) == 2

    _as_user(client, "analytics.doc.a")
    doctor_summary = client.get("/api/analytics/summary").json()
    assert _card(doctor_summary, "total_patients")["value"] == 1
    assert client.get(f"/api/analytics/summary?doctor_user_id={ids['doc_b']}").json()["cards"][0]["value"] == 0
    assert client.get(f"/api/analytics/details?type=patients&department_id={ids['dept_b']}").json()["items"] == []


def test_analytics_user_facing_definitions_do_not_use_internal_english_terms(client):
    _stand(client)
    _as_user(client, "analytics.dev")
    body = client.get("/api/analytics/dashboard").json()
    visible = json.dumps({
        "summary": body["summary"]["cards"],
        "data_quality": body["data_quality"],
        "attention": body["attention"],
    }, ensure_ascii=False)
    for forbidden in ("critical findings", "warning findings", "planned events", "статусе failed", "статусе pending"):
        assert forbidden not in visible
    assert "Критические проблемы" in visible
    assert "Уведомления с ошибкой отправки" in visible


def test_analytics_readonly_roles_can_read_but_not_write(client):
    ids = _stand(client)
    for username in ("analytics.read", "analytics.caop"):
        _as_user(client, username)
        assert client.get("/api/analytics/data-quality").status_code == 200
        assert client.get("/api/analytics/checklists").status_code == 200
        assert client.post("/api/analytics/export", json={"reportType": "summary"}, headers=client.csrf).status_code == 200
        assert client.post("/api/notifications/process-due", headers=client.csrf).status_code == 403
        assert client.get(f"/api/patients/{ids['p_a']}").status_code == 200


def test_checklists_workload_notifications_and_export_do_not_expose_phi(client):
    ids = _stand(client)
    _as_user(client, "analytics.dev")
    conn = get_conn()
    from backend.app.services import notifications

    with conn:
        conn.execute(
            """INSERT OR REPLACE INTO patient_notification_preferences
               (patient_id, sms_enabled, consent_status, consent_recorded_at,
                consent_recorded_by_user_id, consent_revoked_at, updated_at)
               VALUES (?, 1, 'granted', '2026-08-04T00:00:00+00:00', NULL, NULL, '2026-08-04T00:00:00+00:00')""",
            (ids["p_a"],),
        )
    scheduled = (notifications.utcnow() + timedelta(days=1)).isoformat()
    notification, reason = notifications.create_notification(
        conn,
        patient_id=ids["p_a"],
        template_code="appointment_reminder",
        scheduled_at=scheduled,
        source_type="manual",
        source_id=notifications.MANUAL_SOURCE_ID,
        created_by_user_id=None,
    )
    assert notification and reason is None

    checklist = client.get("/api/analytics/checklists").json()
    assert checklist["formula"] == "completed_required_items / total_required_items * 100; необязательные пункты не включаются"
    assert checklist["total_required_items"] >= checklist["incomplete_required_items"]

    workload = client.get("/api/analytics/workload").json()
    assert workload["title"] == "Распределение рабочей нагрузки"
    assert "рейтинг" not in json.dumps(workload, ensure_ascii=False).lower()
    assert "эффектив" not in json.dumps(workload, ensure_ascii=False).lower()

    notification_stats = client.get("/api/analytics/notifications").json()
    assert notification_stats["provider"] == "mock"
    assert notification_stats["status_counts"]["pending"] == 1
    assert "Обработано тестовым провайдером" not in json.dumps(notification_stats, ensure_ascii=False)

    exported = client.post(
        "/api/analytics/export",
        json={"reportType": "notifications", "detailLevel": "aggregate"},
        headers=client.csrf,
    )
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("text/csv")
    assert "attachment; filename=\"analytics_notifications_" in exported.headers["content-disposition"]
    assert exported.content.startswith("\ufeff".encode("utf-8"))
    text = exported.content.decode("utf-8-sig")
    for forbidden in (
        "+7 (999) 101-10-10",
        "9991011010",
        "C34.1 скрытый диагноз",
        "Напоминаем о запланированном",
    ):
        assert forbidden not in text
    audit_text = json.dumps(client.get("/api/audit?limit=20").json(), ensure_ascii=False)
    assert "analytics_report_exported" in audit_text
    assert "Аналитика Пациент А" not in audit_text
    assert "C34.1 скрытый диагноз" not in audit_text


def test_stage_durations_are_based_on_completed_history_intervals(client):
    ids = _stand(client)
    conn = get_conn()
    with conn:
        conn.execute(
            """INSERT INTO history_entries (id, patient_id, seq, stage, entered_at, checklist_json, note)
               VALUES ('analytics_duration_next', ?, 1, 'consult', '2026-08-04T00:00:00+00:00', NULL, '')""",
            (ids["p_a"],),
        )
    _as_user(client, "analytics.dev")
    body = client.get("/api/analytics/stage-durations?date_from=2026-08-01&date_to=2026-08-31").json()
    assert body["available"] is True
    assert all(row["observations"] > 0 for row in body["stats"])
    assert "current_stage_age" in body


def test_csv_formula_injection_protection_and_allowlisted_export(client):
    from backend.app.analytics import service

    for dangerous in ("=1+1", "+SUM(A1:A2)", "-2+3", "@cmd", "\t=1+1", "\r=1+1", "\n=1+1", "  =1+1"):
        assert service.csv_safe_cell(dangerous).startswith("'")

    dept = create_department("=1+1")
    create_account("analytics.formula.dev", "developer", "Разработчик CSV")
    doc = create_account("analytics.formula.doc", "doctor", "+SUM(A1:A2)", department_ids=[dept])
    _create_patient(doc, name="CSV Пациент", events=[])
    _as_user(client, "analytics.formula.dev")
    response = client.post(
        "/api/analytics/export",
        json={"reportType": "workload", "detailLevel": "details"},
        headers=client.csrf,
    )
    assert response.status_code == 200
    text = response.content.decode("utf-8-sig")
    assert "'+SUM(A1:A2)" in text
    assert "'=1+1" in text
    assert "\n+SUM(A1:A2)" not in text
    assert "\n=1+1" not in text


def test_all_analytics_endpoints_apply_role_scope_and_details_pagination(client):
    ids = _stand(client)
    endpoints = [
        "/api/analytics/summary",
        "/api/analytics/dashboard",
        "/api/analytics/stages",
        "/api/analytics/overdue",
        "/api/analytics/stage-durations",
        "/api/analytics/workload",
        "/api/analytics/data-quality",
        "/api/analytics/checklists",
        "/api/analytics/notifications",
        "/api/analytics/details?type=patients&limit=1&offset=0",
    ]
    _as_user(client, "analytics.head.a")
    for endpoint in endpoints:
        assert client.get(endpoint).status_code == 200, endpoint
    assert client.get(f"/api/analytics/details?type=patients&doctor_user_id={ids['doc_b']}").json()["items"] == []
    assert client.post(
        f"/api/analytics/export?doctor_user_id={ids['doc_b']}",
        json={"reportType": "summary"},
        headers=client.csrf,
    ).content.decode("utf-8-sig").count("\n") >= 1

    _as_user(client, "analytics.doc.a")
    workload = client.get("/api/analytics/workload").json()
    assert [row["doctor_user_id"] for row in workload["rows"]] == [ids["doc_a"]]
    details = client.get("/api/analytics/details?type=patients&limit=1&offset=0").json()
    assert details["total"] == 1
    assert len(details["items"]) == 1
    assert details["items"][0]["patient_id"] == ids["p_a"]


def test_stage_duration_median_even_odd_and_negative_intervals_excluded(client):
    create_account("analytics.duration.dev", "developer", "Разработчик Длительности")
    conn = get_conn()
    for idx, days in enumerate((1, 3, 5, 7)):
        pid = _create_patient(name=f"Duration Even {idx}", events=[])
        with conn:
            conn.execute("UPDATE history_entries SET entered_at = '2026-01-01T00:00:00+00:00' WHERE patient_id = ?", (pid,))
            conn.execute(
                "INSERT INTO history_entries (id, patient_id, seq, stage, entered_at, checklist_json, note) VALUES (?, ?, 1, 'consult', ?, NULL, '')",
                (f"duration_even_{idx}", pid, f"2026-01-{1 + days:02d}T00:00:00+00:00"),
            )
    bad = _create_patient(name="Duration Negative", events=[])
    with conn:
        conn.execute("UPDATE history_entries SET entered_at = '2026-01-10T00:00:00+00:00' WHERE patient_id = ?", (bad,))
        conn.execute(
            "INSERT INTO history_entries (id, patient_id, seq, stage, entered_at, checklist_json, note) VALUES ('duration_bad', ?, 1, 'consult', '2026-01-01T00:00:00+00:00', NULL, '')",
            (bad,),
        )
    _as_user(client, "analytics.duration.dev")
    body = client.get("/api/analytics/stage-durations?date_from=2026-01-01&date_to=2026-01-31").json()
    exam = next(row for row in body["stats"] if row["stage"] == "exam")
    assert exam["observations"] == 4
    assert exam["median_days"] == 4.0
    assert exam["min_days"] == 1
    assert exam["max_days"] == 7


def test_checklist_aggregation_not_multiplied_by_events_or_notifications(client):
    ids = _stand(client)
    conn = get_conn()
    from backend.app.services import notifications

    latest = conn.execute("SELECT id FROM history_entries WHERE patient_id = ? ORDER BY seq DESC LIMIT 1", (ids["p_a"],)).fetchone()["id"]
    with conn:
        conn.execute("UPDATE history_entries SET checklist_json = ? WHERE id = ?", (json.dumps({"Направление на бронхоскопию": True}, ensure_ascii=False), latest))
        for seq in range(10, 13):
            conn.execute("INSERT INTO events (id, history_entry_id, seq, date, no_plan) VALUES (?, ?, ?, '2999-01-01', 0)", (f"check_join_event_{seq}", latest, seq))
        conn.execute(
            """INSERT OR REPLACE INTO patient_notification_preferences
               (patient_id, sms_enabled, consent_status, consent_recorded_at, consent_recorded_by_user_id, consent_revoked_at, updated_at)
               VALUES (?, 1, 'granted', '2026-08-04T00:00:00+00:00', NULL, NULL, '2026-08-04T00:00:00+00:00')""",
            (ids["p_a"],),
        )
    for idx in range(3):
        notifications.create_notification(
            conn,
            patient_id=ids["p_a"],
            template_code="appointment_reminder",
            scheduled_at=f"2026-08-0{idx + 5}T09:00:00+00:00",
            source_type="manual",
            source_id=f"manual-{idx}",
            created_by_user_id=None,
        )
    _as_user(client, "analytics.dev")
    body = client.get(f"/api/analytics/checklists?doctor_user_id={ids['doc_a']}").json()
    patient = next(row for row in body["patients"] if row["patient_id"] == ids["p_a"])
    assert patient["total_required"] == len(__import__("backend.app.services.data_quality", fromlist=["REQUIRED_CHECKLISTS"]).REQUIRED_CHECKLISTS["lung34"]["exam"])
    assert patient["completed_required"] == 1


def test_data_quality_bulk_evaluation_query_count_is_not_per_patient(client, monkeypatch):
    create_account("analytics.bulk.dev", "developer", "Разработчик Bulk")
    for idx in range(120):
        _create_patient(name=f"Bulk Analytics {idx}", phone=f"+7 900 000-{idx:04d}", events=[])
    _as_user(client, "analytics.bulk.dev")
    conn = get_conn()
    statements = []
    conn.set_trace_callback(lambda sql: statements.append(sql) if sql.lstrip().upper().startswith("SELECT") else None)
    try:
        assert client.get("/api/analytics/data-quality").status_code == 200
    finally:
        conn.set_trace_callback(None)
    assert len(statements) < 40
