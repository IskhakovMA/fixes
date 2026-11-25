"""Runtime observer only for the existing disposable Workspace harness."""
import itertools
import inspect
import os
from pathlib import Path
import sys
import threading
import time
import json

_ROUTES = {
    "/api/auth/login": "login", "/api/auth/activity": "touch", "/api/auth/me": "identity",
    "/api/patients/workspace/events": "calendar", "/api/audit": "activity",
    "/api/ai/status": "ai", "/api/internal-notifications/summary": "notice",
}
_API = {
    "GET /api/patients/workspace/{kind}": "calendar",
    "GET /api/audit": "activity",
    "GET /api/internal-notifications/summary": "notice",
}


def serve(original_run, app, target, *args, **kwargs):
    from backend.app import read_access, patient_pages, session_context
    persist = read_access.persist
    if target.__name__ == "timed_persist" and Path(target.__code__.co_filename).as_posix().endswith("/tools/tests/wp_h/server.py"):
        target = inspect.getclosurevars(target).globals["original_persist"]
    if target.__name__ != "_persist" or Path(target.__code__.co_filename).resolve() != Path(read_access.__file__).resolve():
        raise RuntimeError("Workspace observer release anchor mismatch")
    target = target.__code__
    lines = Path(target.co_filename).read_text().splitlines()
    sites = {}
    for label, needle in [
        ("snapshot_start", "version = conn.execute('PRAGMA data_version')"),
        ("begin", "conn.execute('BEGIN IMMEDIATE')"),
        ("audit", "audit.record_required_or_fail(conn, result="),
        ("manifest", "manifest_insert = conn.execute("),
        ("commit", "conn.commit()"),
        ("rollback", "conn.rollback()"),
        ("recheck", "if validation_changed or conn.execute('PRAGMA data_version')"),
    ]:
        sites[label] = next(i for i, text in enumerate(lines, 1)
                            if i >= target.co_firstlineno and needle in text)
    lock, ids, seq = threading.Lock(), itertools.count(1), itertools.count(1)
    start = time.monotonic_ns()
    path = Path(os.environ["WS_BACKEND_TIMELINE"])
    armed = Path(os.environ["WS_BACKEND_ARM"])

    def write(event, kind, n, **fields):
        with lock:
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(dict(seq=next(seq), at_ms=(time.monotonic_ns()-start)//1_000_000,
                                        event=event, type=kind, id=n, **fields)) + "\n")

    from contextvars import ContextVar
    slot = ContextVar("ws_probe", default=None)

    def tracked(state, route, raw, params, denied):
        entry = slot.get()
        if not entry:
            return persist(state, route, raw, params, denied)
        kind, n = entry
        expected = _API.get(route)
        if expected != kind or (kind == "calendar" and params.get("kind") != "events"):
            return persist(state, route, raw, params, denied)
        write("release_start", kind, n, denied=bool(denied))

        def trace(frame, event, arg):
            if event == "call":
                return trace if frame.f_code is target else None
            if event == "line":
                for label, lineno in sites.items():
                    if frame.f_lineno == lineno:
                        write(label, kind, n)
                        break
            if event == "exception" and frame.f_lineno == sites["recheck"] + 1:
                exc = arg[1]
                if isinstance(exc, patient_pages.QueryChanged):
                    value = ("snapshot" if frame.f_locals.get("validation_changed") is True
                             else "data_version" if frame.f_locals.get("validation_changed") is False
                             else "unknown")
                    write("release_query_changed", kind, n, cause=value)
            return trace

        previous = sys.gettrace()
        if kind == "calendar":
            sys.settrace(trace)
        try:
            result = persist(state, route, raw, params, denied)
        except Exception as err:
            reason = ("query_changed" if isinstance(err, patient_pages.QueryChanged)
                      else "access_changed" if isinstance(err, session_context.ContextChanged)
                      else "release_refused")
            write("release_error", kind, n, reason=reason)
            raise
        finally:
            if kind == "calendar":
                sys.settrace(previous)
        write("release_committed", kind, n, denied=bool(denied))
        return result

    read_access.persist = tracked

    if kwargs.get("host") != "127.0.0.1":
        raise RuntimeError("Workspace observer requires loopback")

    async def monitored(scope, receive, send):
        kind = _ROUTES.get(scope.get("path")) if scope["type"] == "http" else None
        if not kind or not armed.is_file():
            return await app(scope, receive, send)
        n = next(ids)
        token = slot.set((kind, n))
        write("server_request", kind, n)

        async def observed(message):
            if message["type"] == "http.response.start":
                write("server_response", kind, n, status=message["status"])
                # Synthetic provenance marker, never used by the application.
                message = {**message, "headers": [*message["headers"],
                           (b"x-i9-observer-order", str(n).encode("ascii"))]}
            await send(message)

        try:
            await app(scope, receive, observed)
        finally:
            slot.reset(token)
    return original_run(monitored, *args, **kwargs)
