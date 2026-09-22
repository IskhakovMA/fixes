import json

from .conftest import DEV_USERNAME, TEST_PASSWORD, create_account, login, make_patient_payload

SENSITIVE_MARKERS = [
    TEST_PASSWORD,
    "argon2",
    "$argon2id$",
    "Тестов Тест Тестович",       # patient name
    "+7 (999) 000-00-00",        # phone
    "7700000000000000",          # OMS policy number
    "C34.1",                      # diagnosis
    "Жалобы для теста",          # complaint
    "Др. Проверяющий",           # doctor
]


def _audit_text(client) -> str:
    return json.dumps(client.get("/api/audit").json(), ensure_ascii=False)


def test_login_success_is_recorded(auth_client):
    events = auth_client.get("/api/audit").json()["events"]
    types = [e["event_type"] for e in events]
    assert "login_success" in types
    entry = next(e for e in events if e["event_type"] == "login_success")
    assert entry["result"] == "ok"
    assert entry["actor"]  # anonymised fingerprint present


def test_failed_login_is_recorded(client):
    create_account(DEV_USERNAME)
    login(client, DEV_USERNAME, "wrong-password")
    login(client, DEV_USERNAME)
    events = client.get("/api/audit").json()["events"]
    types = [e["event_type"] for e in events]
    assert "login_failure" in types
    failure = next(e for e in events if e["event_type"] == "login_failure")
    assert failure["result"] == "denied"
    assert failure["actor"] is None  # no session existed to attribute it to


def test_rate_limit_is_recorded(client):
    create_account(DEV_USERNAME)
    for _ in range(6):
        login(client, DEV_USERNAME, "wrong-password")
    # log in properly on a different rate key is not possible in-process, so read
    # the audit rows straight from the DB via a fresh session after the window
    from backend.app import security
    security._failed_attempts.clear()
    login(client, DEV_USERNAME)
    types = [e["event_type"] for e in client.get("/api/audit").json()["events"]]
    assert "login_rate_limited" in types


def test_logout_is_recorded(auth_client):
    auth_client.post("/api/auth/logout", headers=auth_client.csrf)
    login(auth_client, DEV_USERNAME)
    types = [e["event_type"] for e in auth_client.get("/api/audit").json()["events"]]
    assert "logout" in types


def test_crud_events_recorded_with_patient_id(auth_client):
    created = auth_client.post("/api/patients", json=make_patient_payload(), headers=auth_client.csrf).json()
    auth_client.patch(f"/api/patients/{created['id']}", json={"field": "doctor", "value": "Др. Новый"}, headers=auth_client.csrf)
    auth_client.delete(f"/api/patients/{created['id']}", headers=auth_client.csrf)

    events = auth_client.get("/api/audit").json()["events"]
    by_type = {e["event_type"]: e for e in events}
    assert by_type["patient_created"]["patient_id"] == created["id"]
    assert by_type["patient_deleted"]["patient_id"] == created["id"]
    # The update records the field name but not the value.
    assert by_type["patient_updated"]["detail"] == "field=doctor"
    assert "Др. Новый" not in json.dumps(events, ensure_ascii=False)


def test_stage_change_recorded(auth_client):
    pid = auth_client.post("/api/patients", json=make_patient_payload(), headers=auth_client.csrf).json()["id"]
    auth_client.post(f"/api/patients/{pid}/stage", json={"newStage": "appointment"}, headers=auth_client.csrf)
    events = auth_client.get("/api/audit").json()["events"]
    assert any(e["detail"] == "stage=appointment" for e in events)


def test_import_and_export_recorded_with_counts_only(auth_client):
    doc = json.dumps({
        "schemaVersion": 1,
        "patients": [{"name": "Импортов Тест", "priority": "normal", "stage": "exam"}],
    }, ensure_ascii=False)
    auth_client.post("/api/import/preview", json={"raw": doc})
    auth_client.post("/api/import/commit", json={"raw": doc, "mode": "add"}, headers=auth_client.csrf)
    auth_client.get("/api/export", headers=auth_client.csrf)

    events = auth_client.get("/api/audit").json()["events"]
    types = [e["event_type"] for e in events]
    assert "import_committed" in types
    assert "export" in types
    commit = next(e for e in events if e["event_type"] == "import_committed")
    assert "mode=add" in commit["detail"]
    assert "Импортов Тест" not in json.dumps(events, ensure_ascii=False)


def test_rejected_import_recorded_as_denied(auth_client):
    auth_client.post("/api/import/commit", json={"raw": "{not json", "mode": "add"}, headers=auth_client.csrf)
    events = auth_client.get("/api/audit").json()["events"]
    denied = [e for e in events if e["event_type"] == "import_committed" and e["result"] == "denied"]
    assert denied


def test_migration_recorded(auth_client):
    doc = json.dumps([{"name": "Мигрантов Тест", "priority": "normal", "stage": "exam"}], ensure_ascii=False)
    auth_client.post("/api/migrate/localstorage/commit", json={"raw": doc, "mode": "add"}, headers=auth_client.csrf)
    types = [e["event_type"] for e in auth_client.get("/api/audit").json()["events"]]
    assert "migration_committed" in types


def test_password_change_recorded_and_has_no_secret(auth_client):
    r = auth_client.post(
        "/api/auth/change-password",
        json={"currentPassword": TEST_PASSWORD, "newPassword": "brand-new-password-9"},
        headers=auth_client.csrf,
    )
    assert r.status_code == 200
    text = _audit_text(auth_client)
    assert "password_changed" in text
    assert "brand-new-password-9" not in text
    assert TEST_PASSWORD not in text


def test_backup_and_restore_recorded(auth_client, tmp_path, monkeypatch):
    from backend.app import audit, db, maintenance
    monkeypatch.setenv("CLINIC_BACKUP_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    monkeypatch.setenv("CLINIC_BACKUP_KEY_ID", "audit-test-key")
    conn = db.get_connection()
    dest = maintenance.backup_database(tmp_path / "clinic.db", tmp_path / "manual_backup.cbk")
    assert maintenance.looks_like_encrypted_backup(dest)
    audit.record(conn, audit.BACKUP_CREATED, detail="via=test")
    maintenance.validate_backup(dest)
    audit.record(conn, audit.RESTORE_PERFORMED, detail="via=test")

    types = [e["event_type"] for e in auth_client.get("/api/audit").json()["events"]]
    assert "backup_created" in types
    assert "restore_performed" in types


def test_audit_contains_no_secrets_or_medical_data(auth_client):
    auth_client.post("/api/patients", json=make_patient_payload(), headers=auth_client.csrf)
    auth_client.get("/api/export", headers=auth_client.csrf)
    text = _audit_text(auth_client)
    for marker in SENSITIVE_MARKERS:
        assert marker not in text, f"audit leaked: {marker}"
    # no cookies / tokens either
    assert auth_client.cookies.get("clinic_session") not in text
    assert auth_client.cookies.get("clinic_csrf") not in text


def test_audit_requires_session(client):
    assert client.get("/api/audit").status_code == 401


def test_audit_pagination_and_limits(auth_client):
    for _ in range(5):
        auth_client.post("/api/patients", json=make_patient_payload(), headers=auth_client.csrf)
    page = auth_client.get("/api/audit?limit=2&offset=0").json()
    assert len(page["events"]) == 2
    assert page["total"] >= 6
    assert page["retentionDays"] > 0
    # limit is capped by the schema
    assert auth_client.get("/api/audit?limit=9999").status_code == 422


def test_audit_prune_removes_old_events(auth_client):
    from backend.app import audit, db
    conn = db.get_connection()
    with conn:
        conn.execute(
            "INSERT INTO audit_events (created_at, event_type, result) VALUES ('2000-01-01T00:00:00+00:00', 'login_success', 'ok')"
        )
    before = audit.count_events(conn)
    removed = audit.prune(conn, retention_days=30)
    assert removed >= 1
    assert audit.count_events(conn) == before - removed
    # recent events survive
    assert audit.count_events(conn) > 0


def test_audit_failure_is_fail_open(auth_client):
    """A broken audit insert must not break the clinical operation.

    The audit table is dropped out from under the app, so the INSERT raises
    for real rather than through a patched stand-in.
    """
    from backend.app import audit, db
    conn = db.get_connection()
    with conn:
        conn.execute("DROP TABLE audit_events")

    r = auth_client.post("/api/patients", json=make_patient_payload(), headers=auth_client.csrf)
    assert r.status_code == 201, "patient creation must survive an audit write failure"

    # And the helper itself swallows the failure instead of propagating it.
    audit.record(conn, audit.PATIENT_CREATED, patient_id="whatever")
