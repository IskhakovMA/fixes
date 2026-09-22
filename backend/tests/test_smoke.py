"""Full integration smoke: the entire operator workflow in one scenario."""
import json

from .conftest import DEV_USERNAME, TEST_PASSWORD, create_account, login, make_patient_payload


def test_full_scenario(client):
    # 1. Backend is up: login page served
    r = client.get("/")
    assert r.status_code == 200
    assert "loginScreen" in r.text
    # frontend must not contain the old hardcoded credential check
    js = client.get("/clinic-v2.js").text
    assert "=== 'password'" not in js
    assert "normalizedPassword" not in js
    assert "admin:" not in js  # the old hardcoded users object

    # 2. Login (персональная учётная запись Разработчика)
    create_account(DEV_USERNAME)
    r = login(client, DEV_USERNAME)
    assert r.status_code == 200
    csrf = {"X-CSRF-Token": client.cookies.get("clinic_csrf")}

    # 3. Create
    created = client.post("/api/patients", json=make_patient_payload(), headers=csrf).json()
    pid = created["id"]

    # 4. Read
    assert client.get(f"/api/patients/{pid}").json()["name"] == created["name"]

    # 5. Update
    r = client.patch(f"/api/patients/{pid}", json={"field": "doctor", "value": "Др. Смоуков"}, headers=csrf)
    assert r.json()["doctor"] == "Др. Смоуков"

    # 6. Add event
    r = client.post(f"/api/patients/{pid}/history/0/events", headers=csrf)
    assert len(r.json()["history"][0]["events"]) == 1

    # 7. Export
    exported = client.get("/api/export", headers=csrf)
    assert exported.status_code == 200
    doc = json.loads(exported.text)
    assert doc["patients"][0]["id"] == pid

    # 8. Delete
    assert client.delete(f"/api/patients/{pid}", headers=csrf).status_code == 200
    assert client.get("/api/patients").json() == []

    # 9. Import the export back
    r = client.post("/api/import/commit", json={"raw": exported.text, "mode": "add"}, headers=csrf)
    assert r.json()["added"] == 1

    # 10. Logout
    assert client.post("/api/auth/logout", headers=csrf).status_code == 200

    # 11. API is closed after logout
    assert client.get("/api/patients").status_code == 401
    assert client.get("/api/export").status_code == 401
    assert client.post("/api/patients", json=make_patient_payload(), headers=csrf).status_code == 401
