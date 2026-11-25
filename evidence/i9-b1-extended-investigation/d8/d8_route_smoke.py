"""Check route availability on a fresh D8 B1 fixture. Emit only aggregate outcomes."""
import argparse
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

# -I excludes the script directory, so use only this explicitly trusted sibling.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from d8_operator import (B1, HOST, STAND, exact_checkout, port_occupied, ready_receipt,
                         stop, wait_ready)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def client():
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(CookieJar()),
        NoRedirect(),
    )


def route_check(fixtures, url):
    metadata = json.loads(fixtures.read_bytes())
    cases = []

    def request(transport, label, route, expected, payload=None, json_predicate=None):
        if not route.startswith("/") or route.startswith("//"):
            raise AssertionError("route escaped the local origin")
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json", "Origin": url} if data is not None else {}
        query = urllib.request.Request(url + route, data=data, headers=headers)
        try:
            response = transport.open(query, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            if response.status != expected:
                raise RuntimeError(f"{label}: expected {expected}, observed {response.status}")
            if json_predicate is not None and not json_predicate(json.load(response)):
                raise RuntimeError(f"{label}: expected response shape was not verified")
            cases.append({"check": label, "status": response.status})

    def log_in(transport, role):
        request(transport, f"{role}_login", "/api/auth/login", 200, {
            "username": metadata["accounts"][role], "password": metadata["password"],
        }, lambda data: data.get("authenticated") is True)
        request(transport, f"{role}_session", "/api/auth/me", 200,
                json_predicate=lambda data: data.get("authenticated") is True)

    anon, doctor, developer = client(), client(), client()
    request(anon, "app_shell", "/", 200)
    request(anon, "app_script", "/static/app.js", 200)
    request(anon, "anonymous_registry_denied", "/api/patients?view=page&limit=10", 401)
    log_in(doctor, "doctor")
    owner = metadata["ownerPatientId"]
    hidden = metadata["hiddenPatientId"]
    request(doctor, "visible_registry", "/api/patients?view=page&limit=10", 200)
    request(doctor, "visible_card", f"/api/patients/{owner}", 200,
            json_predicate=lambda data: data.get("id") == owner)
    request(doctor, "out_of_scope_card", f"/api/patients/{hidden}", 404)
    request(doctor, "calendar_workspace", "/api/patients/workspace/events?limit=10", 200)
    request(doctor, "checklist_workspace", "/api/patients/workspace/checklists?limit=10", 200)
    request(doctor, "patient_notifications", f"/api/notifications/patients/{owner}", 200)
    request(doctor, "consilium_metadata", "/api/consilium/meta", 200)
    request(doctor, "consilium_schedule", "/api/consilium/schedule", 200,
            json_predicate=lambda data: isinstance(data.get("slots"), list))
    log_in(developer, "developer")
    request(developer, "analytics_summary", "/api/analytics/summary", 200)
    quality_path = metadata["qualityPath"]
    if quality_path != "/api/_i8a3_lab":
        raise RuntimeError("unexpected lab Quality route")
    request(developer, "lab_quality_missing_mode_denied", quality_path + "?view=page", 422)
    request(developer, "lab_quality_page", quality_path + "?mode=quality-v1&view=page", 200,
            json_predicate=lambda data: data.get("view") == "page")
    return cases


def run(app, port):
    exact_checkout(app)
    if port_occupied(port):
        raise RuntimeError("loopback port is already in use")
    url = f"http://{HOST}:{port}"
    with tempfile.TemporaryDirectory(prefix="clinic-d8-route-") as temp:
        log = Path(temp) / "launcher.log"
        with log.open("wb") as output:
            worker = subprocess.Popen(
                [sys.executable, "-I", "-B", str(STAND), str(app), str(port)],
                stdout=output, stderr=output, start_new_session=True,
            )
        fixture = scratch = None
        try:
            fixture, scratch, receipt = ready_receipt(wait_ready(worker, log), url, port)
            cases = route_check(fixture, url)
        finally:
            exit_code = stop(worker)
            if scratch is not None and (scratch.exists() or fixture.exists() or port_occupied(port)):
                raise RuntimeError("stand stopped but temporary material remains")
    if exit_code:
        raise RuntimeError("stand exited uncleanly")
    return {
        "productSha": B1, "syntheticOnly": True, "fixturePatients": receipt["syntheticPatients"],
        "readinessHttp": receipt["healthHttp"], "localOnly": True, "cleanStop": True,
        "routeChecks": cases, "medicalWritesIssued": 0, "authLoginsIssued": 2,
        "manualChecksPerformed": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--port", type=int, default=19089)
    args = parser.parse_args()
    if not __debug__ or not args.app.is_absolute() or not 1024 <= args.port <= 65535:
        parser.error("requires an absolute exact checkout path, unprivileged port and no Python optimization")
    os.umask(0o077)
    try:
        result = run(args.app.resolve(strict=True), args.port)
    except (RuntimeError, OSError, subprocess.SubprocessError, AssertionError, KeyError, ValueError) as error:
        # The only displayed details come from constant check labels and HTTP status.
        if type(error) is RuntimeError:
            print("D8 route smoke failed: " + str(error), file=sys.stderr)
        else:
            print("D8 route smoke failed: local technical verification did not complete", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
