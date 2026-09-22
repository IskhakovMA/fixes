"""Pre-production hardening: credential and restore events end old sessions.

Regression tests for audit leads NV-01 (self-service password change kept
other sessions alive, including sessions opened with the temporary
password) and NV-02 (restore brought back sessions revoked after the
snapshot was taken).
"""
from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD, create_account, login

NEW_PASSWORD = "brand-new-strong-passphrase"


def _second_client(client):
    from backend.app.main import app
    return TestClient(app, base_url="http://127.0.0.1", raise_server_exceptions=False)


def test_password_change_revokes_other_sessions(client):
    create_account("doc.one", "doctor")
    assert login(client, "doc.one").status_code == 200
    other = _second_client(client)
    assert login(other, "doc.one").status_code == 200
    assert other.get("/api/auth/me").json()["authenticated"] is True

    r = client.post(
        "/api/auth/change-password",
        json={"currentPassword": TEST_PASSWORD, "newPassword": NEW_PASSWORD},
        headers=client.csrf,
    )
    assert r.status_code == 200

    # The other session is gone; the caller keeps working on a fresh session.
    assert other.get("/api/auth/me").json() == {"authenticated": False}
    assert other.get("/api/patients").status_code == 401
    me = client.get("/api/auth/me").json()
    assert me["authenticated"] is True
    fresh_csrf = {"X-CSRF-Token": client.cookies.get("clinic_csrf")}
    assert fresh_csrf["X-CSRF-Token"] != client.csrf["X-CSRF-Token"]
    assert client.post("/api/auth/logout", headers=fresh_csrf).status_code == 200


def test_temporary_password_session_is_not_upgraded_by_owner_change(client):
    create_account("doc.temp", "doctor", must_change_password=True)
    squatter = _second_client(client)
    assert login(squatter, "doc.temp").status_code == 200
    assert squatter.get("/api/patients").status_code == 403

    assert login(client, "doc.temp").status_code == 200
    r = client.post(
        "/api/auth/change-password",
        json={"currentPassword": TEST_PASSWORD, "newPassword": NEW_PASSWORD},
        headers=client.csrf,
    )
    assert r.status_code == 200

    assert squatter.get("/api/patients").status_code == 401
    assert client.get("/api/patients").status_code == 200


def test_failed_password_change_keeps_sessions(client):
    create_account("doc.keep", "doctor")
    assert login(client, "doc.keep").status_code == 200
    other = _second_client(client)
    assert login(other, "doc.keep").status_code == 200

    r = client.post(
        "/api/auth/change-password",
        json={"currentPassword": "wrong-password-value", "newPassword": NEW_PASSWORD},
        headers=client.csrf,
    )
    assert r.status_code == 401
    assert other.get("/api/auth/me").json()["authenticated"] is True


def test_restore_invalidates_sessions_revoked_after_snapshot(auth_client, tmp_path, monkeypatch):
    from backend.app import db, maintenance
    monkeypatch.setenv("CLINIC_BACKUP_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    monkeypatch.setenv("CLINIC_BACKUP_KEY_ID", "test-key")
    monkeypatch.delenv("CLINIC_BACKUP_KEY_FILE", raising=False)
    monkeypatch.delenv("CLINIC_BACKUP_DECRYPT_KEYS", raising=False)

    db_path = tmp_path / "clinic.db"
    session_cookie = auth_client.cookies.get("clinic_session")
    backup = maintenance.backup_database(db_path, tmp_path / "snapshot.cbk")

    assert auth_client.post("/api/auth/logout", headers=auth_client.csrf).status_code == 200

    db.reset_singleton_for_tests()
    maintenance.restore_database(backup, db_path, confirm_offline=True)

    auth_client.cookies.set("clinic_session", session_cookie)
    assert auth_client.get("/api/patients").status_code == 401
    assert auth_client.get("/api/auth/me").json() == {"authenticated": False}
