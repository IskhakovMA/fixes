"""Synthetic controls for read serialization and post-commit response rendering.

Run with the accepted worktree on PYTHONPATH, its conftest loaded with -p,
and a fresh pytest basetemp. Writes only anonymous phase receipts.
"""
from pathlib import Path
import json
import os

from starlette.responses import JSONResponse

from backend.tests.conftest import get_conn, login
from backend.tests.test_wp_i_i8a1_quality import _count, lab  # noqa: F401
from backend.tests.test_wp24b_idempotency import EVENTS, _audit, _counts, _create, _key, _world


def emit(**record):
    with Path(os.environ["I9_SERIALIZATION_RECEIPT"]).open("a", encoding="utf-8") as output:
        output.write(json.dumps(record, ensure_ascii=False) + "\n")


def test_protected_read_serialization_failure_has_no_release(lab, monkeypatch):
    qp = lab["qp"]
    original = qp._canonical
    fault_count = 0

    def serialize(value):
        nonlocal fault_count
        if isinstance(value, dict) and value.get("mode") == qp.MODE and "scope_summary" in value:
            fault_count += 1
            raise ValueError("synthetic serialization fault")
        return original(value)

    def manifests():
        return get_conn().execute("SELECT count(*) FROM read_access_manifests").fetchone()[0]

    before = (_count(), manifests())
    monkeypatch.setattr(qp, "_canonical", serialize)
    response = lab["get"]()
    assert fault_count == 1
    assert response.status_code == 503 and response.json()["code"] == "QUALITY_READ_UNAVAILABLE"
    assert set(response.json()) == {"detail", "code"}
    assert (_count(), manifests()) == before
    emit(phase="protect_read_serialize_before_release", route="GET protected synthetic Quality",
         status=503, code="QUALITY_READ_UNAVAILABLE", injectedException="ValueError",
         medicalBodyReleased=False, committedAuditDelta=0, committedManifestDelta=0)


def test_create_rendering_failure_after_commit(client, monkeypatch):
    _world()
    doctor = get_conn().execute(
        "SELECT username FROM users WHERE role_id = ? ORDER BY username LIMIT 1", ("doctor",)
    ).fetchone()
    assert doctor is not None
    login(client, doctor["username"])
    before = (_counts()["patients"], len(_audit("patient_created")))
    original = JSONResponse.render
    fault_count = 0

    def render(self, value):
        nonlocal fault_count
        if self.status_code == 201 and not fault_count:
            fault_count += 1
            raise ValueError("synthetic post-commit JSON response fault")
        return original(self, value)

    monkeypatch.setattr(JSONResponse, "render", render)
    key = _key()
    failure = _create(client, key, events=EVENTS)
    assert fault_count == 1 and failure.status_code == 500
    assert (_counts()["patients"], len(_audit("patient_created"))) == (before[0] + 1, before[1] + 1)
    replay = _create(client, key, events=EVENTS)
    assert replay.status_code == 201 and replay.headers["Idempotent-Replayed"] == "true"
    assert (_counts()["patients"], len(_audit("patient_created"))) == (before[0] + 1, before[1] + 1)
    emit(phase="create_http_render_after_commit", route="POST /api/patients",
         status=500, code=None, injectedException="ValueError", committedPatientDelta=1,
         committedCreateAuditDelta=1, explicitSameKeyReplayStatus=201, duplicate=False)
