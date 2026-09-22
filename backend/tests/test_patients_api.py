from .conftest import make_patient_payload


def _create(auth_client, **overrides):
    r = auth_client.post("/api/patients", json=make_patient_payload(**overrides), headers=auth_client.csrf)
    assert r.status_code == 201, r.text
    return r.json()


def test_crud_roundtrip(auth_client):
    created = _create(auth_client)
    pid = created["id"]
    assert len(pid) == 32  # server-generated uuid4 hex, not client-supplied

    r = auth_client.get(f"/api/patients/{pid}")
    assert r.status_code == 200
    assert r.json()["name"] == "Тестов Тест Тестович"
    assert r.json()["history"][0]["stage"] == "exam"

    r = auth_client.patch(f"/api/patients/{pid}", json={"field": "name", "value": "Новое Имя"}, headers=auth_client.csrf)
    assert r.status_code == 200
    assert r.json()["name"] == "Новое Имя"

    r = auth_client.delete(f"/api/patients/{pid}", headers=auth_client.csrf)
    assert r.status_code == 200
    assert auth_client.get(f"/api/patients/{pid}").status_code == 404


def test_client_cannot_choose_id(auth_client):
    payload = make_patient_payload()
    payload["id"] = "attacker-chosen-id"
    r = auth_client.post("/api/patients", json=payload, headers=auth_client.csrf)
    assert r.status_code == 422


def test_validation_rejects_bad_types_and_lengths(auth_client):
    cases = [
        {"age": "not-a-number"},
        {"priority": "hyper-urgent"},
        {"stage": "no-such-stage"},
        {"name": ""},
        {"name": "x" * 201},
        {"phone": "8" * 51},
        {"diagnosis": "C" * 501},
        {"complaint": "x" * 5001},
        {"pgiResult": "confirmed"},
    ]
    for overrides in cases:
        r = auth_client.post("/api/patients", json=make_patient_payload(**overrides), headers=auth_client.csrf)
        assert r.status_code == 422, f"expected 422 for {overrides}, got {r.status_code}"


def test_missing_required_field(auth_client):
    payload = make_patient_payload()
    del payload["name"]
    r = auth_client.post("/api/patients", json=payload, headers=auth_client.csrf)
    assert r.status_code == 422


def test_unknown_id_404(auth_client):
    assert auth_client.get("/api/patients/ffffffffffffffffffffffffffffffff").status_code == 404
    r = auth_client.patch(
        "/api/patients/ffffffffffffffffffffffffffffffff",
        json={"field": "name", "value": "x"},
        headers=auth_client.csrf,
    )
    assert r.status_code == 404


def test_mutations_require_csrf(auth_client):
    created = _create(auth_client)
    pid = created["id"]
    assert auth_client.post("/api/patients", json=make_patient_payload()).status_code == 403
    assert auth_client.patch(f"/api/patients/{pid}", json={"field": "name", "value": "x"}).status_code == 403
    assert auth_client.delete(f"/api/patients/{pid}").status_code == 403
    # wrong token also rejected
    assert (
        auth_client.delete(f"/api/patients/{pid}", headers={"X-CSRF-Token": "forged"}).status_code == 403
    )
    # patient still exists
    assert auth_client.get(f"/api/patients/{pid}").status_code == 200


def test_get_cannot_mutate(auth_client):
    _create(auth_client)
    before = auth_client.get("/api/patients").json()
    auth_client.get("/api/patients")
    auth_client.get("/api/export", headers=auth_client.csrf)
    after = auth_client.get("/api/patients").json()
    assert before == after


def test_stage_change_flow(auth_client):
    pid = _create(auth_client)["id"]
    r = auth_client.post(
        f"/api/patients/{pid}/stage",
        json={"newStage": "appointment", "lastEventUpdate": {"actualDate": "2026-07-01", "actualTime": "10:00", "matchedPlan": False}},
        headers=auth_client.csrf,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["stage"] == "appointment"
    assert len(body["history"]) == 2
    # same stage again -> 409
    r = auth_client.post(
        f"/api/patients/{pid}/stage", json={"newStage": "appointment"}, headers=auth_client.csrf
    )
    assert r.status_code == 409


def test_consult_can_return_to_exam_for_additional_assessment(auth_client):
    pid = _create(auth_client, stage="consult", events=[{"date": "2026-07-02", "time": "11:00"}])["id"]
    r = auth_client.post(
        f"/api/patients/{pid}/stage",
        json={
            "newStage": "exam",
            "lastEventUpdate": {"actualDate": "2026-07-02", "actualTime": "11:00", "matchedPlan": True},
        },
        headers=auth_client.csrf,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["stage"] == "exam"
    assert body["history"][-1]["stage"] == "exam"
    assert body["history"][0]["events"][0].get("consiliumDecision") is None


def test_hormone_treatment_type_roundtrips(auth_client):
    pid = _create(
        auth_client,
        stage="treatment",
        events=[{"date": "2026-08-01", "time": "09:00", "treatmentType": "hormone"}],
    )["id"]
    body = auth_client.get(f"/api/patients/{pid}").json()
    assert body["history"][0]["events"][0]["treatmentType"] == "hormone"

    r = auth_client.patch(
        f"/api/patients/{pid}/history/0/events/0",
        json={"field": "treatmentType", "value": "hormone"},
        headers=auth_client.csrf,
    )
    assert r.status_code == 200, r.text
    assert r.json()["history"][0]["events"][0]["treatmentType"] == "hormone"


def test_events_lifecycle(auth_client):
    pid = _create(auth_client)["id"]
    r = auth_client.post(f"/api/patients/{pid}/history/0/events", headers=auth_client.csrf)
    assert r.status_code == 200
    assert len(r.json()["history"][0]["events"]) == 1

    r = auth_client.patch(
        f"/api/patients/{pid}/history/0/events/0",
        json={"field": "date", "value": "2026-08-01"},
        headers=auth_client.csrf,
    )
    assert r.json()["history"][0]["events"][0]["date"] == "2026-08-01"

    # actual date matching plan -> matchedPlan True
    r = auth_client.patch(
        f"/api/patients/{pid}/history/0/events/0",
        json={"field": "actualDate", "value": "2026-08-01"},
        headers=auth_client.csrf,
    )
    assert r.json()["history"][0]["events"][0]["matchedPlan"] is True

    r = auth_client.delete(f"/api/patients/{pid}/history/0/events/0", headers=auth_client.csrf)
    assert r.status_code == 200
    assert r.json()["history"][0]["events"] == []


def test_event_field_whitelist(auth_client):
    pid = _create(auth_client)["id"]
    auth_client.post(f"/api/patients/{pid}/history/0/events", headers=auth_client.csrf)
    r = auth_client.patch(
        f"/api/patients/{pid}/history/0/events/0",
        json={"field": "noPlan", "value": "true"},
        headers=auth_client.csrf,
    )
    assert r.status_code == 422


def test_note_and_checklist(auth_client):
    pid = _create(auth_client)["id"]
    r = auth_client.patch(
        f"/api/patients/{pid}/history/0/note", json={"note": "Заметка по этапу"}, headers=auth_client.csrf
    )
    assert r.json()["history"][0]["note"] == "Заметка по этапу"

    r = auth_client.patch(
        f"/api/patients/{pid}/history/0/checklist",
        json={"item": "Общий анализ крови", "checked": True},
        headers=auth_client.csrf,
    )
    assert r.json()["history"][0]["checklist"] == {"Общий анализ крови": True}


def test_future_plans_endpoint_is_retired(auth_client):
    pid = _create(auth_client)["id"]
    r = auth_client.put(
        f"/api/patients/{pid}/future-plans/5",
        json={"field": "date", "value": "2026-09-01"},
        headers=auth_client.csrf,
    )
    assert r.status_code == 404


def test_pgi_result_requires_date_and_saves_atomically(auth_client):
    pid = _create(auth_client)["id"]
    missing = auth_client.patch(
        f"/api/patients/{pid}",
        json={"field": "pgiResult", "value": "confirmed"},
        headers=auth_client.csrf,
    )
    assert missing.status_code == 422

    saved = auth_client.patch(
        f"/api/patients/{pid}",
        json={"field": "pgiResult", "value": {"result": "confirmed", "date": "2026-08-10"}},
        headers=auth_client.csrf,
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["pgiResult"] == "confirmed"
    assert saved.json()["pgiResultDate"] == "2026-08-10"

    cleared = auth_client.patch(
        f"/api/patients/{pid}",
        json={"field": "pgiResult", "value": {"result": "", "date": ""}},
        headers=auth_client.csrf,
    )
    assert cleared.status_code == 200
    assert cleared.json()["pgiResult"] == ""
    assert cleared.json()["pgiResultDate"] is None
