"""XSS payloads must round-trip through the API as inert text.

The browser-side guarantee (payload renders as text, no DOM element, no
execution) was verified manually in the running app; these tests pin the
API half of the contract: payloads are stored verbatim (not mangled into
something executable), served back as JSON strings, and never rejected in
a way that would tempt someone to strip escaping client-side.
"""
import json

from .conftest import make_patient_payload

PAYLOADS = [
    '<img src=x onerror="window.__xss_test=1">',
    '<svg onload="window.__xss_test=1"></svg>',
    '<script>window.__xss_test=1</script>',
    "'\"><b>break</b>",
]

TEXT_FIELDS = ["name", "phone", "doctor", "complaint"]


def test_payloads_roundtrip_as_text(auth_client):
    for field in TEXT_FIELDS:
        for payload in PAYLOADS:
            body = make_patient_payload(**{field: payload})
            r = auth_client.post("/api/patients", json=body, headers=auth_client.csrf)
            assert r.status_code == 201, f"{field}: {r.text}"
            stored = r.json()[field]
            assert stored == payload  # verbatim text, not sanitized into something else
            auth_client.delete(f"/api/patients/{r.json()['id']}", headers=auth_client.csrf)


def test_payload_in_note_and_checklist(auth_client):
    pid = auth_client.post("/api/patients", json=make_patient_payload(), headers=auth_client.csrf).json()["id"]
    payload = PAYLOADS[0]

    r = auth_client.patch(
        f"/api/patients/{pid}/history/0/note", json={"note": payload}, headers=auth_client.csrf
    )
    assert r.json()["history"][0]["note"] == payload

    r = auth_client.patch(
        f"/api/patients/{pid}/history/0/checklist",
        json={"item": payload[:200], "checked": True},
        headers=auth_client.csrf,
    )
    assert payload[:200] in r.json()["history"][0]["checklist"]


def test_payload_survives_export_import(auth_client):
    payload = PAYLOADS[2]
    auth_client.post("/api/patients", json=make_patient_payload(name=payload), headers=auth_client.csrf)
    exported = auth_client.get("/api/export", headers=auth_client.csrf).text
    r = auth_client.post(
        "/api/import/commit", json={"raw": exported, "mode": "replace"}, headers=auth_client.csrf
    )
    assert r.status_code == 200
    assert auth_client.get("/api/patients").json()[0]["name"] == payload


def test_api_responses_are_json_not_html(auth_client):
    auth_client.post(
        "/api/patients", json=make_patient_payload(name=PAYLOADS[0]), headers=auth_client.csrf
    )
    r = auth_client.get("/api/patients")
    assert r.headers["content-type"].startswith("application/json")
    json.loads(r.text)  # parses cleanly
