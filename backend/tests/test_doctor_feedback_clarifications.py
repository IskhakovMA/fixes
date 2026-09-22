import json
import sqlite3
from pathlib import Path

from .conftest import DEV_USERNAME, create_account, create_department, get_conn, login, make_patient_payload


def _create_patient(client, **overrides):
    response = client.post("/api/patients", json=make_patient_payload(**overrides), headers=client.csrf)
    assert response.status_code == 201, response.text
    return response.json()


def test_consilium_decisions_persist_per_ok_event_and_do_not_leak_to_audit(auth_client):
    patient = _create_patient(
        auth_client,
        stage="consult",
        events=[{"date": "2026-08-20", "time": "10:00"}],
    )
    first = auth_client.post(
        f"/api/patients/{patient['id']}/stage",
        json={
            "newStage": "treatment-prep",
            "lastEventUpdate": {
                "actualDate": "2026-08-20",
                "actualTime": "10:00",
                "matchedPlan": True,
                "consiliumDecision": "treatment_strategy_defined",
            },
        },
        headers=auth_client.csrf,
    )
    assert first.status_code == 200, first.text
    assert first.json()["history"][0]["events"][0]["consiliumDecision"] == "treatment_strategy_defined"

    consult_again = auth_client.post(
        f"/api/patients/{patient['id']}/stage",
        json={"newStage": "consult", "lastEventUpdate": {"actualDate": "2026-08-21"}},
        headers=auth_client.csrf,
    )
    assert consult_again.status_code == 200, consult_again.text
    changed = auth_client.post(
        f"/api/patients/{patient['id']}/stage",
        json={
            "newStage": "treatment-prep",
            "lastEventUpdate": {
                "actualDate": "2026-08-22",
                "consiliumDecision": "treatment_strategy_changed",
            },
        },
        headers=auth_client.csrf,
    )
    assert changed.status_code == 200, changed.text
    decisions = [
        ev["consiliumDecision"]
        for occ in changed.json()["history"]
        for ev in occ["events"]
        if ev.get("consiliumDecision")
    ]
    assert decisions == ["treatment_strategy_defined", "treatment_strategy_changed"]

    terminal_patient = _create_patient(
        auth_client,
        name="ОК Диспансерный",
        stage="consult",
        events=[{"date": "2026-08-23"}],
    )
    terminal = auth_client.post(
        f"/api/patients/{terminal_patient['id']}/stage",
        json={
            "newStage": "dispensary-observation",
            "lastEventUpdate": {
                "actualDate": "2026-08-23",
                "consiliumDecision": "dispensary_observation",
            },
        },
        headers=auth_client.csrf,
    )
    assert terminal.status_code == 200, terminal.text
    assert terminal.json()["stage"] == "dispensary-observation"

    invalid = auth_client.post(
        f"/api/patients/{terminal_patient['id']}/stage",
        json={
            "newStage": "treatment-prep",
            "lastEventUpdate": {"actualDate": "2026-08-24", "consiliumDecision": "treatment_strategy_defined"},
        },
        headers=auth_client.csrf,
    )
    assert invalid.status_code in {409, 422}

    audit_text = json.dumps(auth_client.get("/api/audit?limit=200").json()["events"], ensure_ascii=False)
    assert "consilium_decision_recorded" in audit_text
    for forbidden in (
        "treatment_strategy_defined",
        "treatment_strategy_changed",
        "dispensary_observation",
        "Определение тактики лечения",
        "Изменение тактики лечения",
        "Диспансерное наблюдение",
    ):
        assert forbidden not in audit_text


def test_pgi_result_persistence_no_auto_route_change_rbac_and_audit(auth_client, client):
    department_id = create_department("Тестовое отделение ПГИ")
    doctor_a = create_account("doctor.pgi.a", "doctor", "Врач ПГИ А", department_ids=[department_id])
    doctor_b = create_account("doctor.pgi.b", "doctor", "Врач ПГИ Б", department_ids=[department_id])
    readonly_id = create_account("readonly.pgi", "deputy_chief_oncology", "Read Only PGI")

    own = _create_patient(auth_client, name="Пациент ПГИ", stage="consult", treatingDoctorUserId=doctor_a)
    foreign = _create_patient(auth_client, name="Чужой ПГИ", stage="consult", treatingDoctorUserId=doctor_b)

    confirmed = auth_client.patch(
        f"/api/patients/{own['id']}",
        json={"field": "pgiResult", "value": {"result": "confirmed", "date": "2026-08-20"}},
        headers=auth_client.csrf,
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["pgiResult"] == "confirmed"
    assert confirmed.json()["pgiResultDate"] == "2026-08-20"
    assert confirmed.json()["stage"] == "consult"
    not_confirmed = auth_client.patch(
        f"/api/patients/{own['id']}",
        json={"field": "pgiResult", "value": {"result": "not_confirmed", "date": "2026-08-21"}},
        headers=auth_client.csrf,
    )
    assert not_confirmed.status_code == 200, not_confirmed.text
    assert not_confirmed.json()["pgiResult"] == "not_confirmed"
    assert not_confirmed.json()["pgiResultDate"] == "2026-08-21"
    assert not_confirmed.json()["stage"] == "consult"

    audit_text = json.dumps(auth_client.get("/api/audit?limit=200").json()["events"], ensure_ascii=False)
    assert "pgi_result_changed" in audit_text
    assert "confirmed" not in audit_text
    assert "not_confirmed" not in audit_text
    assert "2026-08-20" not in audit_text
    assert "2026-08-21" not in audit_text

    assert login(client, "readonly.pgi").status_code == 200
    read_only = client.patch(
        f"/api/patients/{own['id']}",
        json={"field": "pgiResult", "value": {"result": "confirmed", "date": "2026-08-20"}},
        headers=client.csrf,
    )
    assert read_only.status_code == 403

    assert login(client, "doctor.pgi.a").status_code == 200
    hidden_foreign = client.patch(
        f"/api/patients/{foreign['id']}",
        json={"field": "pgiResult", "value": {"result": "confirmed", "date": "2026-08-20"}},
        headers=client.csrf,
    )
    assert hidden_foreign.status_code == 404
    assert readonly_id


def test_import_export_accepts_prev7_legacy_and_v8_structured_fields(auth_client):
    legacy_doc = {
        "schemaVersion": 7,
        "patients": [
            make_patient_payload(name="Legacy v7 Codes", consiliumCode="OK-LEGACY", pgiCode="PGI-LEGACY")
        ],
    }
    raw = json.dumps(legacy_doc, ensure_ascii=False)
    preview = auth_client.post("/api/import/preview", json={"raw": raw})
    assert preview.status_code == 200, preview.text
    assert preview.json()["valid"] is True
    assert auth_client.post("/api/import/commit", json={"raw": raw, "mode": "add"}, headers=auth_client.csrf).status_code == 200
    imported = next(p for p in auth_client.get("/api/patients").json() if p["name"] == "Legacy v7 Codes")
    assert imported["consiliumCode"] == "OK-LEGACY"
    assert imported["pgiCode"] == "PGI-LEGACY"
    assert imported["pgiResult"] == ""

    v8_doc = {
        "schemaVersion": 8,
        "patients": [
            make_patient_payload(
                name="Structured v8",
                pgiResult="confirmed",
                stage="consult",
                history=[
                    {
                        "stage": "consult",
                        "enteredAt": "2026-08-20T00:00:00+00:00",
                        "events": [
                            {
                                "date": "2026-08-20",
                                "actualDate": "2026-08-20",
                                "consiliumDecision": "treatment_strategy_defined",
                            }
                        ],
                        "checklist": {},
                        "note": "",
                    }
                ],
            )
        ],
    }
    raw = json.dumps(v8_doc, ensure_ascii=False)
    assert auth_client.post("/api/import/preview", json={"raw": raw}).json()["valid"] is True
    assert auth_client.post("/api/import/commit", json={"raw": raw, "mode": "add"}, headers=auth_client.csrf).status_code == 200
    exported = json.loads(auth_client.get("/api/export", headers=auth_client.csrf).text)
    structured = next(p for p in exported["patients"] if p["name"] == "Structured v8")
    assert exported["schemaVersion"] == 9
    assert structured["pgiResult"] == "confirmed"
    assert structured["pgiResultDate"] is None
    assert structured["history"][0]["events"][0]["consiliumDecision"] == "treatment_strategy_defined"


def test_schema_v7_to_v9_preserves_legacy_data_and_sets_safe_defaults(tmp_path):
    from backend.app import config, db, maintenance

    path = tmp_path / "clinic.db"
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    with conn:
        conn.execute("CREATE TABLE schema_version (version INTEGER NOT NULL)")
        conn.execute("INSERT INTO schema_version (version) VALUES (7)")
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
                consilium_code TEXT,
                pgi_code TEXT,
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
            """CREATE TABLE history_entries (
                id TEXT PRIMARY KEY,
                patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                stage TEXT NOT NULL,
                entered_at TEXT NOT NULL,
                checklist_json TEXT,
                note TEXT
            )"""
        )
        conn.execute(
            """CREATE TABLE events (
                id TEXT PRIMARY KEY,
                history_entry_id TEXT NOT NULL REFERENCES history_entries(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                date TEXT,
                time TEXT,
                treatment_type TEXT,
                actual_date TEXT,
                actual_time TEXT,
                matched_plan INTEGER,
                no_plan INTEGER NOT NULL DEFAULT 0,
                set_at TEXT
            )"""
        )
        conn.execute(
            """CREATE TABLE patient_diagnosis_history (
                id TEXT PRIMARY KEY,
                patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
                changed_at TEXT NOT NULL,
                actor_user_id TEXT,
                old_diagnosis TEXT,
                new_diagnosis TEXT
            )"""
        )
        conn.execute(
            """INSERT INTO patients
               (id, name, age, priority, stage, phone, policy_number, complaint, diagnosis,
                consilium_code, pgi_code, nosology, disease_stage, arrival, doctor, head,
                created_at, updated_at, treating_doctor_user_id)
               VALUES ('legacy_v7', 'Пациент V7', 51, 'normal', 'consult', '+7',
                       '7700000000000001', 'жалобы', 'D44.0', 'OK-OLD', 'PGI-OLD',
                       'thyroidSuspected', 'II', '2026-01-01T00:00:00+00:00', 'Врач',
                       'Заведующий', '2026-01-01T00:00:00+00:00', NULL, NULL)"""
        )
        conn.execute(
            "INSERT INTO history_entries (id, patient_id, seq, stage, entered_at, checklist_json, note) "
            "VALUES ('hist_v7', 'legacy_v7', 0, 'consult', '2026-01-01T00:00:00+00:00', NULL, '')"
        )
        conn.execute(
            "INSERT INTO events (id, history_entry_id, seq, date, time, treatment_type, actual_date, actual_time, matched_plan, no_plan, set_at) "
            "VALUES ('event_v7', 'hist_v7', 0, '2026-01-02', '', NULL, NULL, NULL, NULL, 0, NULL)"
        )
        conn.execute(
            "INSERT INTO patient_diagnosis_history (id, patient_id, changed_at, actor_user_id, old_diagnosis, new_diagnosis) "
            "VALUES ('diag_v7', 'legacy_v7', '2026-01-02T00:00:00+00:00', NULL, 'D44.0', 'C73')"
        )
    db.init_db(conn)

    assert conn.execute("SELECT version FROM schema_version").fetchone()[0] == config.SCHEMA_VERSION
    patient_columns = {row["name"] for row in conn.execute("PRAGMA table_info(patients)").fetchall()}
    event_columns = {row["name"] for row in conn.execute("PRAGMA table_info(events)").fetchall()}
    assert "pgi_malignancy_confirmed" in patient_columns
    assert "pgi_result_date" in patient_columns
    assert "consilium_decision" in event_columns
    row = conn.execute(
        "SELECT policy_number, consilium_code, pgi_code, pgi_malignancy_confirmed, pgi_result_date FROM patients WHERE id = 'legacy_v7'"
    ).fetchone()
    assert row["policy_number"] == "7700000000000001"
    assert row["consilium_code"] == "OK-OLD"
    assert row["pgi_code"] == "PGI-OLD"
    assert row["pgi_malignancy_confirmed"] is None
    assert row["pgi_result_date"] is None
    assert conn.execute("SELECT consilium_decision FROM events WHERE id = 'event_v7'").fetchone()[0] is None
    report = maintenance.check_database(path)
    assert report["ok"] is True, report["problems"]
    assert report["schema_version"] == config.SCHEMA_VERSION
    assert report["foreign_key_violations"] == 0


def test_schema_v9_encrypted_backup_restore_preserves_structured_feedback_and_attention(
    auth_client, tmp_path, monkeypatch
):
    monkeypatch.setenv("CLINIC_BACKUP_KEY", "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
    monkeypatch.setenv("CLINIC_BACKUP_KEY_ID", "doctor-clarifications-key")
    monkeypatch.delenv("CLINIC_BACKUP_KEY_FILE", raising=False)
    monkeypatch.delenv("CLINIC_BACKUP_DECRYPT_KEYS", raising=False)

    from backend.app import config, maintenance

    patient = _create_patient(
        auth_client,
        name="Backup Clarifications",
        diagnosis="D44.0",
        nosology="thyroidSuspected",
        stage="consult",
        consiliumCode="OK-LEGACY-BACKUP",
        pgiCode="PGI-LEGACY-BACKUP",
        pgiResult="confirmed",
        pgiResultDate="2026-08-20",
        events=[{"date": "2026-08-20"}],
    )
    auth_client.patch(
        f"/api/patients/{patient['id']}",
        json={"field": "diagnosis", "value": "C73"},
        headers=auth_client.csrf,
    )
    auth_client.post(
        f"/api/patients/{patient['id']}/attention",
        json={"reasonCode": "doctor_decision_required", "comment": "synthetic attention", "eventDate": "2026-08-20"},
        headers=auth_client.csrf,
    )
    auth_client.post(
        f"/api/patients/{patient['id']}/stage",
        json={
            "newStage": "treatment-prep",
            "lastEventUpdate": {
                "actualDate": "2026-08-20",
                "consiliumDecision": "treatment_strategy_defined",
            },
        },
        headers=auth_client.csrf,
    )

    db_path = Path(get_conn().execute("PRAGMA database_list").fetchone()["file"])
    backup = maintenance.backup_database(db_path, tmp_path / "doctor-clarifications-v9.cbk")
    assert maintenance.inspect_backup(backup)["schema_version"] == config.SCHEMA_VERSION
    assert maintenance.verify_backup(backup)["authenticated"] is True

    with get_conn():
        get_conn().execute("DELETE FROM patients WHERE id = ?", (patient["id"],))
    assert auth_client.get(f"/api/patients/{patient['id']}").status_code == 404

    restore = maintenance.restore_database(backup, db_path, confirm_offline=True)
    assert restore["schema_version"] == config.SCHEMA_VERSION
    # Restore revokes every session from the snapshot; sign in again.
    assert login(auth_client, DEV_USERNAME).status_code == 200
    restored = auth_client.get(f"/api/patients/{patient['id']}").json()
    assert restored["consiliumCode"] == "OK-LEGACY-BACKUP"
    assert restored["pgiCode"] == "PGI-LEGACY-BACKUP"
    assert restored["pgiResult"] == "confirmed"
    assert restored["pgiResultDate"] == "2026-08-20"
    assert restored["diagnosisHistory"][-1]["oldDiagnosis"] == "D44.0"
    assert restored["history"][0]["events"][0]["consiliumDecision"] == "treatment_strategy_defined"
    assert restored["attention"]["active"] is True
    report = maintenance.check_database(db_path)
    assert report["ok"] is True, report["problems"]
    assert report["schema_version"] == config.SCHEMA_VERSION
    assert report["foreign_key_violations"] == 0
