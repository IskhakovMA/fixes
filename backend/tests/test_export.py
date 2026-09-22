import json

from .conftest import make_patient_payload


def test_export_shape_and_content(auth_client):
    created = auth_client.post(
        "/api/patients",
        json=make_patient_payload(name="Кириллица Юникодовна", complaint="ёжик — тест"),
        headers=auth_client.csrf,
    ).json()

    r = auth_client.get("/api/export", headers=auth_client.csrf)
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    doc = json.loads(r.content.decode("utf-8"))
    assert doc["schemaVersion"] == 9
    assert "generatedAt" in doc
    assert len(doc["patients"]) == 1
    assert doc["patients"][0]["name"] == "Кириллица Юникодовна"
    assert doc["patients"][0]["policyNumber"] == "7700000000000000"
    assert doc["patients"][0]["complaint"] == "ёжик — тест"
    assert doc["patients"][0]["id"] == created["id"]


def test_export_filtered_by_ids(auth_client):
    p1 = auth_client.post("/api/patients", json=make_patient_payload(name="Первый"), headers=auth_client.csrf).json()
    auth_client.post("/api/patients", json=make_patient_payload(name="Второй"), headers=auth_client.csrf).json()

    r = auth_client.get(f"/api/export?ids={p1['id']}", headers=auth_client.csrf)
    doc = json.loads(r.content)
    assert [p["name"] for p in doc["patients"]] == ["Первый"]


def test_export_contains_no_secrets(auth_client):
    auth_client.post("/api/patients", json=make_patient_payload(), headers=auth_client.csrf)
    r = auth_client.get("/api/export", headers=auth_client.csrf)
    text = r.text.lower()
    for needle in ("password", "argon2", "session", "csrf", "token", "sqlite", "clinic.db"):
        assert needle not in text, f"export leaked: {needle}"
    session_cookie = auth_client.cookies.get("clinic_session")
    assert session_cookie not in r.text


def test_export_requires_auth(client):
    assert client.get("/api/export").status_code == 401


def test_export_roundtrips_through_import(auth_client):
    auth_client.post("/api/patients", json=make_patient_payload(name="Раундтрип Тест"), headers=auth_client.csrf)
    exported = auth_client.get("/api/export", headers=auth_client.csrf).text

    r = auth_client.post(
        "/api/import/commit", json={"raw": exported, "mode": "replace"}, headers=auth_client.csrf
    )
    assert r.status_code == 200, r.text
    patients = auth_client.get("/api/patients").json()
    assert len(patients) == 1
    assert patients[0]["name"] == "Раундтрип Тест"
