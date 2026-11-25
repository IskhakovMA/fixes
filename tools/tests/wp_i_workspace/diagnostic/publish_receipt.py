"""Fail closed on unexpected data before emitting a hosted timeline."""
from pathlib import Path
import json
import stat
import sys

ROUTES = set("login touch identity calendar activity ai notice registry heads resolve doctors".split())
UI_NAMES = set("resume rebuild show render identity expire reconcile calendar-json read-current read-begin wait-start wait-end wait-error".split())
BOOL_KEYS = set("expired reconciling appReady calendarView ready busy retry sameActor result".split())
CODES = set("PATIENT_QUERY_CHANGED CURSOR_EXPIRED ACCESS_CONTEXT_CHANGED SESSION_IDENTITY_CHANGED READ_ADMISSION_UNAVAILABLE AUDIT_UNAVAILABLE other no-json".split())


def bounded(value):
    return type(value) is int and 0 <= value <= 10_000_000


def service(fields):
    if fields["type"] not in ROUTES or not bounded(fields["id"]):
        raise ValueError


def read(path, browser):
    if not path.exists() and not path.is_symlink():
        return []
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_size > 1_000_000:
        raise ValueError
    events = []
    for line in path.read_text().splitlines():
        d = json.loads(line)
        event = d["event"]
        if not bounded(d["seq"]) or not bounded(d["at_ms"]):
            raise ValueError
        keys = {"seq", "at_ms", "event"}
        if browser and event in {"request", "response", "finish", "request-failed"}:
            keys |= {"id", "type", "method"}
            service(d)
            if d["method"] not in {"GET", "POST"}:
                raise ValueError
            if event == "response":
                keys |= {"status", "serverId"}
                if not bounded(d["status"]) or not 100 <= d["status"] <= 599 or not bounded(d["serverId"]):
                    raise ValueError
        elif browser and event == "ui":
            keys |= {"name", "phase", "flags"}
            if d["name"] not in UI_NAMES or d["phase"] not in {"start", "return", "done", "error", "sample"}:
                raise ValueError
            if not all((k in BOOL_KEYS and type(v) is bool)
                       or (k in {"epoch", "readVersion"} and bounded(v))
                       for k, v in d["flags"].items()):
                raise ValueError
        elif browser and event == "calendar-code":
            keys |= {"id", "code"}
            if not bounded(d["id"]) or d["code"] not in CODES:
                raise ValueError
        elif browser and event == "summary":
            keys.add("pending")
            if not all(map(bounded, d["pending"])):
                raise ValueError
        elif browser and event == "page-error":
            pass
        elif not browser:
            keys |= {"type", "id"}
            service(d)
            if event == "server_response":
                keys.add("status")
                if not bounded(d["status"]) or not 100 <= d["status"] <= 599:
                    raise ValueError
            elif event in {"release_start", "release_committed"}:
                keys.add("denied")
                if type(d["denied"]) is not bool:
                    raise ValueError
            elif event == "release_query_changed":
                keys.add("cause")
                if d["cause"] not in {"snapshot", "data_version", "unknown"}:
                    raise ValueError
            elif event == "release_error":
                keys.add("reason")
                if d["reason"] not in {"query_changed", "access_changed", "release_refused"}:
                    raise ValueError
            elif event not in {"server_request","snapshot_start","begin","audit","manifest","commit","rollback","recheck"}:
                raise ValueError
        else:
            raise ValueError
        if set(d) != keys:
            raise ValueError
        events.append(d)
    return events


if __name__ == "__main__":
    try:
        browser, server = read(Path(sys.argv[1]), True), read(Path(sys.argv[2]), False)
        seen = {row["serverId"] for row in browser if row.get("serverId", 0)}
        if seen:
            server = [row for row in server if min(seen) - 8 <= row["id"] <= max(seen) + 8]
        else:
            server = server[-100:]
        for label, rows in [("browser", browser), ("server", server)]:
            for event in rows[-380:]:
                print("I9_WS_TIMELINE " + label + " " + json.dumps(event, separators=(",", ":")))
    except Exception:
        raise SystemExit("Workspace diagnostic receipt rejected")
