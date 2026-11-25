"""Run an isolated Pilot P fixture on the exact product. No live-data option."""
import contextlib
from datetime import timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys

B1 = "3a0cb5db434032b3f7b6370c305c558a4b5d331c"
HOST = "127.0.0.1"


def read_module(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def seed():
    from backend.app import clock, db, operations_state, store, users
    from backend.app.models import PatientCreateIn

    operations_state.bootstrap_database(confirm_new=True)
    operations_state.verify_database(confirm_offline=True)
    conn = db.get_connection()
    password = secrets.token_urlsafe(32)
    accounts = []

    def account(key, role):
        username = f"pilot.p.{key}"
        user_id = users.create_user(
            conn, username=username, full_name=f"Синтетический Pilot P {key}",
            role_id=role, password=password, must_change_password=False,
        )
        return dict(username=username, roleId=role, password=password, actorId=user_id)

    try:
        for number in range(5):
            accounts.append(account(f"doctor{number+1}", "doctor"))
        accounts += [
            account("head", "department_head"),
            account("developer", "developer"),
            account("chair", "consilium_chair"),
        ]
        outside = account("outside", "doctor")
        dept = users.create_department(conn, "Синтетический Pilot P отделение")
        other = users.create_department(conn, "Синтетический Pilot P отдельный scope")
        users.set_department_head(conn, dept, accounts[5]["actorId"])
        for doctor in accounts[:5]:
            users.add_doctor_to_department(conn, doctor["actorId"], dept)
        users.add_doctor_to_department(conn, outside["actorId"], other)
        target, roster, identities = [], [], []
        first_event_date = clock.today_moscow() + timedelta(days=1)
        with conn:
            for index in range(1000):
                owner_index = index // 160 if index < 800 else 5
                owner = accounts[owner_index] if owner_index < 5 else outside
                name = f"Синтетика Pilot P {index:04d}"
                event_date = (first_event_date + timedelta(days=index % 3)).isoformat() if index < 800 and index % 160 < 24 else None
                patient = PatientCreateIn(
                    events=[{"date": event_date, "time": "10:00"}] if event_date else [],                    name=name, age=46, priority="normal", stage="exam",
                    policyNumber=str(9900000000010000 + index), diagnosis="C34.1",
                    nosology="lung34", head="Синтетический Pilot P head",
                )
                patient_id = store.insert_patient_rows(
                    conn, patient, owner["actorId"], created_by_user_id=accounts[6]["actorId"],
                    creation_source="form",
                )
                roster.append((index, owner_index, event_date is not None))
                identities.append(patient_id)
                if index % 160 == 0 and index < 800:
                    target.append((patient_id, name))
                if index == 999:
                    hidden = patient_id
        for index, user in enumerate(accounts):
            patient_id, name = target[index if index < 5 else 0]
            authorized = identities[index*160:(index+1)*160] if index < 5 else (
                identities[:800] if index == 5 else identities if index == 6 else []
            )
            user.update(patientId=patient_id, patientName=name, authorizedIds=authorized,
                        expectTotal=len(authorized))
        identifier = target[0][0]
        revision = conn.execute("SELECT version FROM schema_version").fetchone()[0]
        if revision != 33:
            raise RuntimeError("Expected Clinic Tracker schema v33")
        return dict(
            syntheticOnly=True, count=1000, users=accounts, hiddenPatientId=hidden,
            fixturePlanSha256=hashlib.sha256(json.dumps(roster).encode()).hexdigest(),
            schema=revision, sqlite=sqlite3.sqlite_version, pid=os.getpid(),
            mutation=dict(userIndex=0, path=f"/api/patients/{identifier}",
                          body=dict(field="age", value=46, expectedVersion=1), version=1),
        )
    finally:
        db.reset_singleton_for_tests()


def main(repo, port, scratch):
    from fastapi import FastAPI
    import uvicorn

    lab = read_module("pinned_b1_test_lab", repo / "tools/tests/wp_i_quality/lab.py")
    data = scratch / "db"
    data.mkdir(mode=0o700)
    lab.configure_environment(data, port)
    from backend.app import config
    if (config.DATA_DIR != data or config.DB_PATH.parent != data or config.APP_ENV != "test"
            or config.HOST != HOST or config.PORT != port or config.AI_MODE != "disabled"
            or config.AI_DATA_MODE != "disabled" or config.NOTIFICATION_PROVIDER != "mock"
            or config.TRUSTED_PROXY_IPS):
        raise RuntimeError("Invalid synthetic configuration")
    receipt = seed()
    receipt.update(baseURL=f"http://{HOST}:{port}", productSha=B1)

    def guard(event, args):
        if event in {"socket.connect", "socket.sendto", "socket.sendmsg", "socket.gethostbyname",
                     "socket.gethostbyaddr", "os.system", "os.fork", "os.posix_spawn", "subprocess.Popen"}:
            raise PermissionError("Synthetic server disallows outbound and child processes")
        if event == "socket.bind" and (args[0].family != 2 or args[1] != (HOST, port)):
            raise PermissionError("Synthetic server binds its own loopback port only")
        if event == "socket.getaddrinfo" and args[0] != HOST:
            raise PermissionError("Synthetic server disallows external DNS")

    sys.addaudithook(guard)
    from backend.app.main import app
    if not isinstance(app, FastAPI):
        raise RuntimeError("Expected the exact product application")
    path = scratch / "fixture.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(receipt, stream)
        uvicorn.run(app, host=HOST, port=port, workers=1, proxy_headers=False, access_log=False)
    finally:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


if __name__ == "__main__":
    app_root = Path(sys.argv[1]).resolve(strict=True)
    scratch_root = Path(sys.argv[3]).resolve(strict=True)
    if scratch_root.stat().st_mode & 0o077 or not scratch_root.name.startswith("clinic-pilot-p-"):
        raise RuntimeError("Only a fresh private process sandbox may hold pilot data")
    main(app_root, int(sys.argv[2]), scratch_root)
