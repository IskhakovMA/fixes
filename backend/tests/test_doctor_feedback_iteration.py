import json
import re
import sqlite3
from pathlib import Path

from .conftest import DEV_USERNAME, get_conn, login, make_patient_payload


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _create_patient(auth_client, **overrides):
    response = auth_client.post(
        "/api/patients",
        json=make_patient_payload(**overrides),
        headers=auth_client.csrf,
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_schema_v6_to_v9_adds_feedback_fields_pgi_date_and_diagnosis_history(tmp_path):
    from backend.app import config, db, maintenance

    path = tmp_path / "clinic.db"
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    with conn:
        conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
        conn.execute("INSERT INTO schema_version (version) VALUES (6)")
        conn.execute(
            """CREATE TABLE patients (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                age INTEGER,
                priority TEXT NOT NULL,
                stage TEXT NOT NULL,
                phone TEXT,
                policy_number TEXT,
                complaint TEXT,
                diagnosis TEXT,
                nosology TEXT,
                disease_stage TEXT,
                arrival TEXT NOT NULL,
                doctor TEXT,
                head TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                treating_doctor_user_id TEXT
            )"""
        )
        conn.execute(
            """INSERT INTO patients
               (id, name, age, priority, stage, phone, policy_number, complaint, diagnosis,
                nosology, disease_stage, arrival, doctor, head, created_at, updated_at, treating_doctor_user_id)
               VALUES ('legacy_v6', 'Пациент V6', 50, 'normal', 'exam', '+7 900 000-00-00',
                       '7700000000000000', 'жалобы', 'D44.0', 'thyroidSuspected', 'II',
                       '2026-01-01T00:00:00+00:00', 'Врач V6', 'Заведующий V6',
                       '2026-01-01T00:00:00+00:00', NULL, NULL)"""
        )
    db.init_db(conn)

    assert conn.execute("SELECT version FROM schema_version").fetchone()[0] == 9
    patient_columns = {row["name"] for row in conn.execute("PRAGMA table_info(patients)").fetchall()}
    assert {"consilium_code", "pgi_code", "pgi_result_date"} <= patient_columns
    row = conn.execute("SELECT diagnosis, policy_number, pgi_result_date FROM patients WHERE id = 'legacy_v6'").fetchone()
    assert row["diagnosis"] == "D44.0"
    assert row["policy_number"] == "7700000000000000"
    assert row["pgi_result_date"] is None
    tables = {row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert "patient_diagnosis_history" in tables
    report = maintenance.check_database(path)
    assert report["ok"] is True, report["problems"]
    assert report["schema_version"] == config.SCHEMA_VERSION


def test_d37_d48_dictionary_and_search_ui_are_local_and_safe():
    app_js = (PROJECT_ROOT / "static" / "app.js").read_text(encoding="utf-8")
    index = (PROJECT_ROOT / "index.html").read_text(encoding="utf-8")

    expected = {
        "D37.0", "D37.1", "D37.2", "D37.3", "D37.4", "D37.5", "D37.6", "D37.7", "D37.9",
        "D38.0", "D38.1", "D38.2", "D38.3", "D38.4", "D38.5", "D38.6",
        "D39.0", "D39.1", "D39.2", "D39.7", "D39.9",
        "D40.0", "D40.1", "D40.7", "D40.9",
        "D41.0", "D41.1", "D41.2", "D41.3", "D41.4", "D41.7", "D41.9",
        "D42.0", "D42.1", "D42.9",
        "D43.0", "D43.1", "D43.2", "D43.3", "D43.4", "D43.7", "D43.9",
        "D44.0", "D44.1", "D44.2", "D44.3", "D44.4", "D44.5", "D44.6", "D44.7", "D44.8", "D44.9",
        "D45", "D46", "D47.0", "D47.1", "D47.2", "D47.3", "D47.7", "D47.9",
        "D48.0", "D48.1", "D48.2", "D48.3", "D48.4", "D48.5", "D48.6", "D48.7", "D48.9",
    }
    found = set(re.findall(r"code: '(D(?:3[7-9]|4[0-8])(?:\.\d)?)'", app_js))
    assert found == expected
    for code in ("D37.4", "D44.0", "D48.9"):
        assert f"code: '{code}'" in app_js
    assert "filterDiagnosisOptions" in app_js
    assert "diagnosisSearch" in index
    assert "innerHTML" not in app_js
    assert "onchange=" not in index.lower()


def test_localization_catalog_maps_suspicion_codes_without_global_d37_d48_wildcard():
    from backend.app.localization_catalog import (
        UNMAPPED_D37_D48_GAPS,
        client_path_for_diagnosis,
        diagnosis_allowed_for_localization,
    )

    expected = {
        ("breast", "D48.6", "breast"),
        ("thyroidSuspected", "D44.0", "thyroidSuspected"),
        ("prostate", "D40.0", "prostate"),
        ("colon", "D37.4", "colon"),
        ("kidney", "D41.0", "kidney"),
        ("upperUrinary", "D41.1", "upperUrinary"),
        ("bladder", "D41.4", "bladder"),
    }
    for localization, code, path in expected:
        assert diagnosis_allowed_for_localization(localization, code)
        assert client_path_for_diagnosis(code) == path

    assert not diagnosis_allowed_for_localization("breast", "D44.0")
    assert not diagnosis_allowed_for_localization("thyroidSuspected", "D48.6")
    assert "D37.7" in UNMAPPED_D37_D48_GAPS
    assert client_path_for_diagnosis("D37.7") == ""


def test_doctor_feedback_polish_frontend_contracts_are_present():
    index = (PROJECT_ROOT / "index.html").read_text(encoding="utf-8")
    app_js = (PROJECT_ROOT / "static" / "app.js").read_text(encoding="utf-8")
    css = (PROJECT_ROOT / "static" / "styles.css").read_text(encoding="utf-8")

    assert 'role="combobox"' in index
    assert 'id="diagnosisOptions" role="listbox"' in index
    assert 'type="hidden" id="diagnosis"' in index
    assert 'select class="select" id="diagnosis"' not in index
    assert "onDiagnosisSearchKeydown" in app_js
    assert "selectDiagnosisOption" in app_js
    assert "clientPathForLocalization($('diagnosisLocalization').value)" in app_js
    assert "suggestedNosologyForDiagnosis(diagnosis)" in app_js

    assert 'id="pgiResultDateError"' in index
    assert "showPgiResultDateError('Укажите дату результата ПГИ.')" in app_js
    assert "input--invalid" in app_js
    assert "clearPgiResultDateError" in app_js

    assert 'data-notifications-tab="inbox"' in index
    assert 'data-notifications-tab="outbound"' in index
    assert "renderNotificationsPage" in app_js
    assert "notificationsOutboundPanel" in app_js
    assert "notificationsInboxPanel" in app_js

    assert "Любая локализация/клиентский путь" not in app_js
    assert "Любая локализация" in app_js
    assert "patient-row__chevron" in app_js
    assert "event.key === 'Enter' || event.key === ' '" in app_js
    assert ".diagnosis-combobox__option" in css
    assert ".patient-row__chevron" in css


def test_active_patient_contract_has_no_disease_stage_or_future_plans_and_sets_path(auth_client):
    created = _create_patient(
        auth_client,
        diagnosis="D48.6",
        nosology="breast",
        pgiResult="confirmed",
        pgiResultDate="2026-08-20",
    )
    assert created["nosology"] == "breast"
    assert created["pgiResultDate"] == "2026-08-20"
    assert "diseaseStage" not in created
    assert "futurePlans" not in created

    exported = json.loads(auth_client.get("/api/export", headers=auth_client.csrf).text)
    patient = next(p for p in exported["patients"] if p["id"] == created["id"])
    assert "diseaseStage" not in patient
    assert "futurePlans" not in patient
    assert patient["pgiResultDate"] == "2026-08-20"

    wrong = auth_client.post(
        "/api/patients",
        json=make_patient_payload(diagnosis="D44.0", nosology="breast"),
        headers=auth_client.csrf,
    )
    assert wrong.status_code == 422


def test_in_situ_d00_d09_mapping_has_safe_profiles_and_known_unmapped_codes():
    app_js = (PROJECT_ROOT / "static" / "app.js").read_text(encoding="utf-8")
    codes = set(re.findall(r"code: '(D0[0-9](?:\.\d)?)'", app_js))
    mapped = {
        "D00.0": "headneckConfirmed",
        "D00.2": "stomach",
        "D01.0": "colon",
        "D01.1": "colon",
        "D01.2": "colon",
        "D01.5": "liver",
        "D02.0": "headneckConfirmed",
        "D02.2": "lung12",
        "D03.0": "melanoma",
        "D03.1": "melanoma",
        "D03.2": "melanoma",
        "D03.3": "melanoma",
        "D03.4": "melanoma",
        "D03.5": "melanoma",
        "D03.6": "melanoma",
        "D03.7": "melanoma",
        "D03.8": "melanoma",
        "D03.9": "melanoma",
        "D04.0": "skin",
        "D04.1": "skin",
        "D04.2": "skin",
        "D04.3": "skin",
        "D04.4": "skin",
        "D04.5": "skin",
        "D04.6": "skin",
        "D04.7": "skin",
        "D04.8": "skin",
        "D04.9": "skin",
        "D05.0": "breast",
        "D05.1": "breast",
        "D05.7": "breast",
        "D05.9": "breast",
        "D06.0": "cervixCytology",
        "D06.1": "cervixCytology",
        "D06.7": "cervixCytology",
        "D06.9": "cervixCytology",
        "D07.0": "uterus",
        "D07.5": "prostate",
        "D09.0": "bladder",
        "D09.1": "upperUrinary",
        "D09.3": "thyroidConfirmed",
    }
    unmapped = codes - set(mapped)
    assert unmapped == {
        "D00.1", "D01.3", "D01.4", "D01.7", "D01.9",
        "D02.1", "D02.3", "D02.4",
        "D07.1", "D07.2", "D07.3", "D07.4", "D07.6",
        "D09.2", "D09.7", "D09.9",
    }
    for code, profile in mapped.items():
        if code.startswith("D03."):
            assert "normalized.startsWith('D03.')" in app_js
        elif code.startswith("D04."):
            assert "normalized.startsWith('D04.')" in app_js
        elif code.startswith("D05."):
            assert "normalized.startsWith('D05.')" in app_js
        elif code.startswith("D06."):
            assert "normalized.startsWith('D06.')" in app_js
        else:
            assert f"'{code}': '{profile}'" in app_js


def test_histology_templates_are_targeted_and_checklist_marks_are_preserved(auth_client):
    from backend.app.services.data_quality import REQUIRED_CHECKLISTS

    app_js = (PROJECT_ROOT / "static" / "app.js").read_text(encoding="utf-8")
    assert "thyroidSuspected:" in app_js
    assert REQUIRED_CHECKLISTS["thyroidSuspected"]["exam"] == [
        "Пункция узла щитовидной железы и/или лимфоузла",
        "Цитологическое исследование",
        "Гистологическое исследование",
        "ЭГДС",
        "КТ ОГК с контрастом",
        "КТ ОБП/ОМТ с контрастом (или УЗИ)",
        "ЭКГ",
    ]
    assert "Гистологическое исследование" in REQUIRED_CHECKLISTS["lung34"]["exam"]
    assert "Гистологическое исследование" not in REQUIRED_CHECKLISTS["uterus"]["exam"]

    patient = _create_patient(auth_client, diagnosis="D44.0", nosology="thyroidSuspected", stage="exam")
    checked_item = "Пункция узла щитовидной железы и/или лимфоузла"
    marked = auth_client.patch(
        f"/api/patients/{patient['id']}/history/0/checklist",
        json={"item": checked_item, "checked": True},
        headers=auth_client.csrf,
    )
    assert marked.status_code == 200, marked.text
    assert marked.json()["history"][0]["checklist"][checked_item] is True

    quality = auth_client.get(f"/api/data-quality/patients/{patient['id']}").json()
    missing = next(issue for issue in quality["issues"] if issue["code"] == "incomplete_required_checklist")
    assert missing["details"]["total_required"] == len(REQUIRED_CHECKLISTS["thyroidSuspected"]["exam"])
    assert auth_client.get(f"/api/patients/{patient['id']}").json()["history"][0]["checklist"][checked_item] is True


def test_diagnosis_change_history_and_audit_without_phi(auth_client):
    created = _create_patient(auth_client, diagnosis="D44.0", nosology="thyroidSuspected")
    response = auth_client.patch(
        f"/api/patients/{created['id']}",
        json={"field": "diagnosis", "value": "C73"},
        headers=auth_client.csrf,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diagnosis"] == "C73"
    assert body["diagnosisHistory"][-1]["oldDiagnosis"] == "D44.0"
    assert body["diagnosisHistory"][-1]["newDiagnosis"] == "C73"

    audit = auth_client.get("/api/audit").json()["events"]
    diagnosis_events = [event for event in audit if event["event_type"] == "patient_diagnosis_changed"]
    assert diagnosis_events
    assert diagnosis_events[-1]["detail"] is None
    audit_text = json.dumps(audit, ensure_ascii=False)
    assert "D44.0" not in audit_text
    assert "C73" not in audit_text


def test_legacy_consilium_and_pgi_codes_are_preserved_but_not_active_fields(auth_client):
    created = _create_patient(auth_client, consiliumCode="OK-123", pgiCode="PGI-456")
    assert created["consiliumCode"] == "OK-123"
    assert created["pgiCode"] == "PGI-456"

    legacy_patch = auth_client.patch(
        f"/api/patients/{created['id']}",
        json={"field": "consiliumCode", "value": "OK-999"},
        headers=auth_client.csrf,
    )
    assert legacy_patch.status_code == 422
    legacy_patch = auth_client.patch(
        f"/api/patients/{created['id']}",
        json={"field": "pgiCode", "value": "PGI-999"},
        headers=auth_client.csrf,
    )
    assert legacy_patch.status_code == 422

    exported = json.loads(auth_client.get("/api/export", headers=auth_client.csrf).text)
    patient = exported["patients"][0]
    assert patient["consiliumCode"] == "OK-123"
    assert patient["pgiCode"] == "PGI-456"
    audit_text = json.dumps(auth_client.get("/api/audit").json()["events"], ensure_ascii=False)
    assert "consilium_code_changed" not in audit_text
    assert "pgi_code_changed" not in audit_text
    assert "OK-123" not in audit_text
    assert "PGI-456" not in audit_text

    too_long = "X" * 101
    assert auth_client.post(
        "/api/patients",
        json=make_patient_payload(consiliumCode=too_long),
        headers=auth_client.csrf,
    ).status_code == 422

    legacy_doc = {"schemaVersion": 6, "patients": [make_patient_payload(name="Legacy Codes")]}
    legacy_doc["patients"][0].pop("consiliumCode", None)
    legacy_doc["patients"][0].pop("pgiCode", None)
    raw = json.dumps(legacy_doc, ensure_ascii=False)
    preview = auth_client.post("/api/import/preview", json={"raw": raw})
    assert preview.status_code == 200, preview.text
    assert preview.json()["valid"] is True
    imported = auth_client.post("/api/import/commit", json={"raw": raw, "mode": "add"}, headers=auth_client.csrf)
    assert imported.status_code == 200, imported.text
    imported_patient = next(p for p in auth_client.get("/api/patients").json() if p["name"] == "Legacy Codes")
    assert imported_patient["consiliumCode"] == ""
    assert imported_patient["pgiCode"] == ""


def test_repeated_appointment_exam_cycles_are_preserved_and_quality_valid(auth_client):
    patient = _create_patient(
        auth_client,
        stage="primary-appointment",
        events=[],
    )
    pid = patient["id"]
    for stage in ("exam", "appointment", "exam", "appointment", "consult"):
        response = auth_client.post(
            f"/api/patients/{pid}/stage",
            json={"newStage": stage},
            headers=auth_client.csrf,
        )
        assert response.status_code == 200, response.text

    fetched = auth_client.get(f"/api/patients/{pid}").json()
    assert [entry["stage"] for entry in fetched["history"]] == [
        "primary-appointment",
        "exam",
        "appointment",
        "exam",
        "appointment",
        "consult",
    ]
    assert len(fetched["history"]) == 6
    assert [entry["stage"] for entry in sorted(fetched["history"], key=lambda item: item["enteredAt"])] == [
        "primary-appointment",
        "exam",
        "appointment",
        "exam",
        "appointment",
        "consult",
    ]
    quality = auth_client.get(f"/api/data-quality/patients/{pid}").json()
    assert "stage_sequence_violation" not in {issue["code"] for issue in quality["issues"]}


def test_consilium_outcomes_treatment_and_dispensary_are_distinct(auth_client):
    treatment = _create_patient(auth_client, stage="consult", events=[{"date": "2026-08-01"}])
    dispensary = _create_patient(auth_client, stage="consult", events=[{"date": "2026-08-01"}])

    normal = auth_client.post(
        f"/api/patients/{treatment['id']}/stage",
        json={"newStage": "treatment-prep", "lastEventUpdate": {"actualDate": "2026-08-02", "matchedPlan": False}},
        headers=auth_client.csrf,
    )
    terminal = auth_client.post(
        f"/api/patients/{dispensary['id']}/stage",
        json={"newStage": "dispensary-observation", "lastEventUpdate": {"actualDate": "2026-08-02", "matchedPlan": False}},
        headers=auth_client.csrf,
    )
    assert normal.status_code == 200, normal.text
    assert terminal.status_code == 200, terminal.text
    assert normal.json()["stage"] == "treatment-prep"
    assert terminal.json()["stage"] == "dispensary-observation"
    assert normal.json()["history"][-1]["stage"] == "treatment-prep"
    assert terminal.json()["history"][-1]["stage"] == "dispensary-observation"

    dashboard = auth_client.get("/api/analytics/dashboard").json()
    cards = {card["code"]: card["value"] for card in dashboard["summary"]["cards"]}
    route_rows = {row["code"]: row for row in dashboard["route_state"]["rows"]}
    assert cards["completed_patients"] == 0
    assert route_rows["dispensary_observation"]["count"] >= 1
    assert route_rows["completed"]["count"] == 0

    from backend.app.services import internal_notifications, notifications
    from backend.app import policy

    conn = get_conn()
    user = policy.load_current_user(conn, conn.execute("SELECT id FROM users WHERE username = ?", ("dev.tester",)).fetchone()["id"])
    operational = {"overdue", "today", "upcoming", "checklist"}
    inbox = internal_notifications.list_items(conn, user)
    assert all(
        item["patient_id"] != dispensary["id"] or item["type"] not in operational
        for item in inbox["items"]
    )
    notifications.generate_due_reminders(conn, user)
    assert conn.execute("SELECT COUNT(*) FROM notifications WHERE patient_id = ?", (dispensary["id"],)).fetchone()[0] == 0

    exported = json.loads(auth_client.get("/api/export", headers=auth_client.csrf).text)
    exported_dispensary = next(p for p in exported["patients"] if p["id"] == dispensary["id"])
    assert exported_dispensary["stage"] == "dispensary-observation"
    raw = json.dumps({"schemaVersion": exported["schemaVersion"], "patients": [exported_dispensary]}, ensure_ascii=False)
    assert auth_client.post("/api/import/preview", json={"raw": raw}).json()["valid"] is True


def test_diagnosis_not_confirmed_lifecycle_search_filter_attention_and_quality(auth_client):
    patient = _create_patient(
        auth_client,
        name="Не Подтверждён Тест",
        stage="exam",
        events=[],
    )
    issue = auth_client.post(
        f"/api/patients/{patient['id']}/attention",
        json={"reasonCode": "doctor_decision_required", "eventDate": None, "comment": "нужна проверка"},
        headers=auth_client.csrf,
    )
    assert issue.status_code == 201, issue.text
    closed = auth_client.post(
        f"/api/patients/{patient['id']}/stage",
        json={"newStage": "diagnosis-not-confirmed"},
        headers=auth_client.csrf,
    )
    assert closed.status_code == 200, closed.text
    assert auth_client.get(f"/api/patients/{patient['id']}").json()["attention"]["active"] is True

    quality = auth_client.get(f"/api/data-quality/patients/{patient['id']}").json()
    codes = {item["code"] for item in quality["issues"]}
    assert {"stage_sequence_violation", "overdue_event", "planned_date_in_past", "incomplete_required_checklist"}.isdisjoint(codes)

    app_js = (PROJECT_ROOT / "static" / "app.js").read_text(encoding="utf-8")
    assert "!this.stageFilter && !this.searchQuery" in app_js
    assert "filtered.filter(p => !this.terminalStages.includes(p.stage))" in app_js
    assert "'diagnosis-not-confirmed': 'Диагноз не подтверждён'" in app_js

    dashboard = auth_client.get("/api/analytics/dashboard").json()
    route_rows = {row["code"]: row for row in dashboard["route_state"]["rows"]}
    assert route_rows["diagnosis_not_confirmed"]["count"] >= 1


def test_terminal_diagnosis_not_confirmed_has_no_operational_notifications_or_overdue(auth_client):
    patient = _create_patient(
        auth_client,
        stage="diagnosis-not-confirmed",
        events=[{"date": "2000-01-01"}],
    )
    quality = auth_client.get(f"/api/data-quality/patients/{patient['id']}").json()
    codes = {issue["code"] for issue in quality["issues"]}
    assert "overdue_event" not in codes
    assert "planned_date_in_past" not in codes

    from backend.app import policy
    from backend.app.services import internal_notifications, notifications

    conn = get_conn()
    user_id = conn.execute("SELECT id FROM users WHERE username = ?", ("dev.tester",)).fetchone()["id"]
    user = policy.load_current_user(conn, user_id)
    inbox = internal_notifications.list_items(conn, user)
    operational = {"overdue", "today", "upcoming", "checklist"}
    assert all(
        item["patient_id"] != patient["id"] or item["type"] not in operational
        for item in inbox["items"]
    )

    notifications.generate_due_reminders(conn, user)
    rows = conn.execute("SELECT COUNT(*) FROM notifications WHERE patient_id = ?", (patient["id"],)).fetchone()[0]
    assert rows == 0


def test_frontend_transition_question_removed_single_prompt_and_first_visit_sort_present():
    app_js = (PROJECT_ROOT / "static" / "app.js").read_text(encoding="utf-8")
    assert "состоялся по плану" not in app_js
    assert "first-visit-oldest" in app_js
    assert "firstVisitTime" in app_js
    body = re.search(r"async changeStage\(id, newStage(?:, options = \{\})?\) \{(?P<body>.*?)\n    \},\n\n    refreshCurrent", app_js, re.S).group("body")
    assert body.count("ui.promptDateTime") == 1
    assert "lastEvent.date === todayValue" in body
    assert "matchedPlan = answer.date === lastEvent.date" in body
    assert "confirm({" not in body


def test_diagnosis_history_privacy_excludes_audit_notifications_and_ai(auth_client, monkeypatch):
    created = _create_patient(auth_client, diagnosis="D44.0", nosology="thyroidSuspected", policyNumber="7700000000007777")
    auth_client.patch(
        f"/api/patients/{created['id']}",
        json={"field": "diagnosis", "value": "C73"},
        headers=auth_client.csrf,
    )
    from backend.app import policy
    from backend.app.ai import tools
    from backend.app.services import internal_notifications

    conn = get_conn()
    user = policy.load_current_user(conn, auth_client.get("/api/auth/me").json()["user"]["id"])
    summary = tools.execute_tool("get_patient_summary", {"patientId": created["id"]}, conn, user)
    timeline = tools.execute_tool("get_patient_timeline", {"patientId": created["id"], "limit": 20}, conn, user)
    inbox = internal_notifications.list_items(conn, user)
    text = json.dumps(
        {
            "audit": auth_client.get("/api/audit?limit=200").json(),
            "summary": summary,
            "timeline": timeline,
            "inbox": inbox,
        },
        ensure_ascii=False,
    )
    for forbidden in ("D44.0", "C73", "7700000000007777"):
        assert forbidden not in text


def test_schema_v9_encrypted_backup_restore_preserves_doctor_feedback_fields(auth_client, tmp_path, monkeypatch):
    monkeypatch.setenv("CLINIC_BACKUP_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    monkeypatch.setenv("CLINIC_BACKUP_KEY_ID", "doctor-feedback-key")
    monkeypatch.delenv("CLINIC_BACKUP_KEY_FILE", raising=False)
    monkeypatch.delenv("CLINIC_BACKUP_DECRYPT_KEYS", raising=False)

    from backend.app import config, maintenance

    patient = _create_patient(
        auth_client,
        name="Backup Feedback",
        diagnosis="D44.0",
        nosology="thyroidSuspected",
        consiliumCode="OK-BACKUP",
        pgiCode="PGI-BACKUP",
        stage="dispensary-observation",
    )
    auth_client.patch(
        f"/api/patients/{patient['id']}",
        json={"field": "diagnosis", "value": "C73"},
        headers=auth_client.csrf,
    )
    db_path = Path(get_conn().execute("PRAGMA database_list").fetchone()["file"])
    backup = maintenance.backup_database(db_path, tmp_path / "doctor-feedback-v9.cbk")
    assert maintenance.inspect_backup(backup)["schema_version"] == 9
    assert maintenance.verify_backup(backup)["authenticated"] is True

    with get_conn():
        get_conn().execute("DELETE FROM patients WHERE id = ?", (patient["id"],))
    assert auth_client.get(f"/api/patients/{patient['id']}").status_code == 404
    restore = maintenance.restore_database(backup, db_path, confirm_offline=True)
    assert restore["schema_version"] == 9
    # Restore revokes every session from the snapshot; sign in again.
    assert login(auth_client, DEV_USERNAME).status_code == 200
    restored = auth_client.get(f"/api/patients/{patient['id']}").json()
    assert restored["stage"] == "dispensary-observation"
    assert restored["consiliumCode"] == "OK-BACKUP"
    assert restored["pgiCode"] == "PGI-BACKUP"
    assert restored["diagnosisHistory"][-1]["oldDiagnosis"] == "D44.0"
    report = maintenance.check_database(db_path)
    assert report["ok"] is True, report["problems"]
    assert report["schema_version"] == config.SCHEMA_VERSION
    assert report["foreign_key_violations"] == 0
