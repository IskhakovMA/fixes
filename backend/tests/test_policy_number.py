import json

from .conftest import make_patient_payload


def test_create_update_get_and_list_patient_policy_number(auth_client):
    payload = make_patient_payload(policyNumber=" 0770-0000 0000 0001 ")
    created = auth_client.post("/api/patients", json=payload, headers=auth_client.csrf)
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["policyNumber"] == "0770000000000001"

    pid = body["id"]
    fetched = auth_client.get(f"/api/patients/{pid}").json()
    listed = auth_client.get("/api/patients").json()
    assert fetched["policyNumber"] == "0770000000000001"
    assert listed[0]["policyNumber"] == "0770000000000001"

    updated = auth_client.patch(
        f"/api/patients/{pid}",
        json={"field": "policyNumber", "value": "7700 0000-0000 0002"},
        headers=auth_client.csrf,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["policyNumber"] == "7700000000000002"


def test_create_patient_without_policy_number_is_backwards_compatible(auth_client):
    payload = make_patient_payload()
    payload.pop("policyNumber")
    created = auth_client.post("/api/patients", json=payload, headers=auth_client.csrf)
    assert created.status_code == 201, created.text
    assert created.json()["policyNumber"] == ""


def test_invalid_policy_number_rejected(auth_client):
    cases = (
        "<script>alert(1)</script>",
        "7700\n0000",
        "7" * 33,
    )
    for policy_number in cases:
        response = auth_client.post(
            "/api/patients",
            json=make_patient_payload(policyNumber=policy_number),
            headers=auth_client.csrf,
        )
        assert response.status_code == 422, policy_number


def test_policy_number_import_export_and_legacy_import(auth_client):
    doc = {
        "schemaVersion": 7,
        "patients": [
            make_patient_payload(name="Полисов Импорт", policyNumber="7700-0000 0000 0003"),
            make_patient_payload(name="Безполисов Импорт"),
        ],
    }
    doc["patients"][1].pop("policyNumber")
    raw = json.dumps(doc, ensure_ascii=False)

    preview = auth_client.post("/api/import/preview", json={"raw": raw})
    assert preview.status_code == 200, preview.text
    assert preview.json()["valid"] is True

    committed = auth_client.post("/api/import/commit", json={"raw": raw, "mode": "add"}, headers=auth_client.csrf)
    assert committed.status_code == 200, committed.text
    patients = sorted(auth_client.get("/api/patients").json(), key=lambda p: p["name"])
    assert patients[0]["policyNumber"] == ""
    assert patients[1]["policyNumber"] == "7700000000000003"

    exported = json.loads(auth_client.get("/api/export", headers=auth_client.csrf).text)
    by_name = {p["name"]: p for p in exported["patients"]}
    assert exported["schemaVersion"] == 9
    assert by_name["Полисов Импорт"]["policyNumber"] == "7700000000000003"
    assert by_name["Безполисов Импорт"]["policyNumber"] == ""


def test_policy_number_not_written_to_audit(auth_client):
    created = auth_client.post(
        "/api/patients",
        json=make_patient_payload(policyNumber="7700000000000099"),
        headers=auth_client.csrf,
    ).json()
    auth_client.patch(
        f"/api/patients/{created['id']}",
        json={"field": "policyNumber", "value": "7700000000000100"},
        headers=auth_client.csrf,
    )

    text = json.dumps(auth_client.get("/api/audit").json(), ensure_ascii=False)
    assert "7700000000000099" not in text
    assert "7700000000000100" not in text
    assert "field=policyNumber" in text


def test_policy_number_quality_recommendation(auth_client):
    auth_client.post(
        "/api/patients",
        json=make_patient_payload(policyNumber=""),
        headers=auth_client.csrf,
    )
    body = auth_client.get("/api/data-quality/issues?code=missing_policy_number").json()
    assert body["total"] == 1
    assert body["issues"][0]["title"] == "Не указан номер полиса ОМС"
    assert body["issues"][0]["severity"] == "info"
