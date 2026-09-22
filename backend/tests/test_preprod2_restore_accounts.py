"""Pre-production hardening, round 2: restore keeps current account security.

Regression tests for preprod-run-2 lead NV2-03: restoring an older snapshot
rolled back account blocks, deactivations, password resets and role or
department changes made after the snapshot.
"""
import pytest

from .conftest import TEST_PASSWORD, create_account, create_department, get_conn, login

KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
NEW_PW = "rotated-strong-passphrase"


@pytest.fixture(autouse=True)
def backup_key(monkeypatch):
    monkeypatch.setenv("CLINIC_BACKUP_KEY", KEY)
    monkeypatch.setenv("CLINIC_BACKUP_KEY_ID", "test-key")
    monkeypatch.delenv("CLINIC_BACKUP_KEY_FILE", raising=False)
    monkeypatch.delenv("CLINIC_BACKUP_DECRYPT_KEYS", raising=False)


def _restore(tmp_path, backup):
    from backend.app import db, maintenance
    db.reset_singleton_for_tests()
    return maintenance.restore_database(backup, tmp_path / "clinic.db", confirm_offline=True)


def test_block_and_password_reset_survive_restore(auth_client, tmp_path):
    from backend.app import maintenance, users
    uid = create_account("doc.x", "doctor")
    backup = maintenance.backup_database(tmp_path / "clinic.db", tmp_path / "snap.cbk")
    conn = get_conn()
    users.update_user_fields(conn, uid, status="blocked")
    users.reset_password(conn, uid, NEW_PW, must_change_password=True)

    _restore(tmp_path, backup)
    from backend.app import db
    row = db.get_connection().execute("SELECT status, must_change_password FROM users WHERE id = ?", (uid,)).fetchone()
    assert row["status"] == "blocked"
    auth_client.cookies.clear()
    assert login(auth_client, "doc.x", TEST_PASSWORD).status_code == 401


def test_password_reset_without_block_keeps_new_credential(auth_client, tmp_path):
    from backend.app import maintenance, users
    uid = create_account("doc.y", "doctor")
    backup = maintenance.backup_database(tmp_path / "clinic.db", tmp_path / "snap.cbk")
    users.reset_password(get_conn(), uid, NEW_PW, must_change_password=False)
    _restore(tmp_path, backup)
    auth_client.cookies.clear()
    assert login(auth_client, "doc.y", TEST_PASSWORD).status_code == 401
    from backend.app import security
    security._failed_attempts.clear()
    assert login(auth_client, "doc.y", NEW_PW).status_code == 200


def test_role_downgrade_and_department_change_survive_restore(auth_client, tmp_path):
    from backend.app import maintenance, users
    d1 = create_department("Отд-1")
    d2 = create_department("Отд-2")
    uid = create_account("head.z", "department_head", department_ids=[d1, d2])
    backup = maintenance.backup_database(tmp_path / "clinic.db", tmp_path / "snap.cbk")
    conn = get_conn()
    users.update_user_fields(conn, uid, role_id="doctor")
    with conn:
        conn.execute("DELETE FROM department_heads WHERE user_id = ?", (uid,))
    users.add_doctor_to_department(conn, uid, d1)

    _restore(tmp_path, backup)
    from backend.app import db
    c = db.get_connection()
    assert c.execute("SELECT role_id FROM users WHERE id = ?", (uid,)).fetchone()[0] == "doctor"
    assert c.execute("SELECT COUNT(*) FROM department_heads WHERE user_id = ?", (uid,)).fetchone()[0] == 0
    assert [r[0] for r in c.execute("SELECT department_id FROM user_departments WHERE user_id = ?", (uid,))] == [d1]


def test_snapshot_block_is_not_lifted_by_restore(auth_client, tmp_path):
    from backend.app import maintenance, users
    uid = create_account("doc.w", "doctor")
    users.update_user_fields(get_conn(), uid, status="blocked")
    backup = maintenance.backup_database(tmp_path / "clinic.db", tmp_path / "snap.cbk")
    users.update_user_fields(get_conn(), uid, status="active")
    _restore(tmp_path, backup)
    from backend.app import db
    assert db.get_connection().execute("SELECT status FROM users WHERE id = ?", (uid,)).fetchone()[0] == "blocked"


def test_department_archived_after_snapshot_stays_archived(auth_client, tmp_path):
    """preprod-run-3 department-status-not-reconciled: restore must not bring
    back an archived department and with it the head's patient scope."""
    from backend.app import maintenance, policy, users
    d1 = create_department("Отд-архив")
    uid = create_account("head.arch", "department_head", department_ids=[d1])
    backup = maintenance.backup_database(tmp_path / "clinic.db", tmp_path / "snap.cbk")
    users.update_department(get_conn(), d1, status="archived")

    _restore(tmp_path, backup)
    from backend.app import db
    c = db.get_connection()
    assert c.execute("SELECT status FROM departments WHERE id = ?", (d1,)).fetchone()[0] == "archived"
    assert list(policy.load_current_user(c, uid).department_ids) == []
