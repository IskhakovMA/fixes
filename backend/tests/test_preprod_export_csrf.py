"""Pre-production hardening: the PHI export cannot be triggered cross-site.

Regression test for audit lead NV-03: GET /api/export relied only on the
SameSite=Lax cookie, which browsers still send on cross-site top-level
navigations, so a link on another site could start the export.
"""


def test_export_without_csrf_header_is_rejected_and_not_audited(auth_client):
    from backend.app import db
    before = db.get_connection().execute(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = 'export'"
    ).fetchone()[0]
    r = auth_client.get("/api/export", headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    after = db.get_connection().execute(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = 'export'"
    ).fetchone()[0]
    assert after == before


def test_export_with_csrf_header_still_works(auth_client):
    r = auth_client.get("/api/export", headers=auth_client.csrf)
    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
