"""Verify a genuinely issue-free synthetic patient with existing v33 rules."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PRODUCT = "0fae327791b8f9379d8870f5afe76c5dbaa44338"


def main():
    app = Path(sys.argv[1]).resolve(strict=True)
    git = ["git", "--no-optional-locks", "-C", str(app)]
    assert subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip() == PRODUCT
    assert not subprocess.check_output([*git, "status", "--porcelain"], text=True).strip()
    assert not (app / ".env").exists() and not (app / ".env").is_symlink()
    sys.path.insert(0, str(app))
    os.umask(0o077)
    for key in list(os.environ):
        if key.startswith(("CLINIC_", "NOTIFICATION_", "INTERNAL_NOTIFICATION_")):
            del os.environ[key]
    with tempfile.TemporaryDirectory(prefix="clinic-f1-healthy-") as temp:
        os.environ.update(CLINIC_DATA_DIR=temp, CLINIC_ENV="test", CLINIC_DEBUG="false",
                          CLINIC_AI_MODE="disabled", CLINIC_AI_DATA_MODE="disabled",
                          NOTIFICATION_PROVIDER="mock")
        from backend.app import clock, config, db, policy, store
        from backend.app.services import data_quality

        assert config.DB_PATH.parent == Path(temp).resolve()
        spec = importlib.util.spec_from_file_location("frozen_f1", app / "tools/tests/fast_track_f1/server.py")
        fixture_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture_module)
        fixture = fixture_module.seed()
        try:
            conn = db.get_connection()
            patient = fixture["patients"]["scheduled"]["id"]
            owner = conn.execute("SELECT treating_doctor_user_id FROM patients WHERE id=?", (patient,)).fetchone()[0]
            user = policy.load_current_user(conn, owner)
            required = data_quality.REQUIRED_CHECKLISTS["lung34"]["exam"]
            assert required
            for item in required:
                assert store.update_checklist_item(conn, patient, 0, item, True, expected=False)
            issues = data_quality.evaluate(conn, user, today=clock.today_moscow())["issues"]
            own_issues = [issue for issue in issues if issue["patient_id"] == patient]
            assert not own_issues, sorted({issue["code"] for issue in own_issues})
            assert sum(issue["code"] == "overdue_event" for issue in issues) == 2
            receipt = dict(candidateSha=PRODUCT, syntheticOnly=True, sqliteSchema=fixture["schema"],
                           coverage="server quality evaluator against hydrated synthetic fixture",
                           requiredChecklistItemsCompleted=len(required), healthyPatientIssues=0,
                           overdueFindingsInDoctorScope=2)
        finally:
            db.reset_singleton_for_tests()
    assert not Path(temp).exists()
    receipt["temporaryDatabaseRemoved"] = True
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
