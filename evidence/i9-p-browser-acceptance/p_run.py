"""Supervise one exact-B1, loopback-only browser shakedown and reconcile SQLite."""
import argparse
import contextlib
from collections import Counter
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

B1 = "3a0cb5db434032b3f7b6370c305c558a4b5d331c"
HERE = Path(__file__).resolve().parent
HOST = "127.0.0.1"


def git(repo, *args):
    return subprocess.check_output(
        ["git", "--no-optional-locks", "-C", str(repo), *args], text=True,
        env={"PATH": os.defpath, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
    ).strip()


def preflight(repo):
    if git(repo, "rev-parse", "HEAD") != B1 or git(repo, "status", "--porcelain", "--untracked-files=all"):
        raise RuntimeError("Requires clean exact B1 checkout")
    if git(repo, "status", "--porcelain", "--ignored", "--", "backend", "static", "tools/tests/wp_i_quality"):
        raise RuntimeError("Ignored artifacts in runtime paths")
    if (repo / ".env").exists() or (repo / ".env").is_symlink():
        raise RuntimeError("Unexpected dotenv in B1 checkout")
    if sys.version_info[:2] != (3, 13) or sys.prefix == sys.base_prefix:
        raise RuntimeError("Requires Python 3.13 lock-matched venv")
    locks = {}
    for name in ("requirements.txt", "requirements-dev.txt"):
        immutable = (repo / "backend" / name).read_bytes()
        pins = re.findall(r"^([\w.-]+)==([^\s\\]+)", immutable.decode(), re.M)
        if not pins or any(importlib.metadata.version(key) != pin for key, pin in pins):
            raise RuntimeError("Dependency versions differ from the B1 locks")
        locks[name] = {"pins": len(pins), "sha256": hashlib.sha256(immutable).hexdigest()}
    return dict(productSha=B1, productTree=git(repo, "rev-parse", "HEAD^{tree}"),
                clean=True, python=sys.version.split()[0], sqlite=sqlite3.sqlite_version,
                checkedDependencyLocks=locks)


def wait_ready(child, url, scratch):
    until = time.monotonic() + 65
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    path = scratch / "fixture.json"
    while time.monotonic() < until:
        if child.poll() is not None:
            raise RuntimeError("Synthetic server exited during startup; see private server.log")
        if path.is_file():
            try:
                with client.open(url + "/api/ready", timeout=1) as response:
                    assert response.status == 200 and json.load(response)["status"] in {"ok", "ready"}
                fixture = json.loads(path.read_text())
            except (ValueError, urllib.error.URLError, TimeoutError):
                pass
            else:
                assert path.stat().st_mode & 0o777 == 0o600
                assert fixture["count"] == 1000 and fixture["syntheticOnly"]
                assert fixture["baseURL"] == url and fixture["pid"] == child.pid
                listener = subprocess.check_output(
                    ["/usr/sbin/lsof", "-nP", "-a", "-p", str(child.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
                    text=True, timeout=5,
                )
                assert [line for line in listener.splitlines() if line.startswith("n")] == [f"n{url[7:]}"]
                return fixture
        time.sleep(0.25)
    raise RuntimeError("Synthetic service readiness timed out")


def verify(db_path, fixture, driver):
    patient = fixture["mutation"]["path"].rsplit("/", 1)[-1]
    with contextlib.closing(sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True)) as conn:
        assert conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        version, age = conn.execute("SELECT version, age FROM patients WHERE id=?", (patient,)).fetchone()
        writes = conn.execute(
            "SELECT patient_id, actor_user_id, detail FROM audit_events "
            "WHERE event_type='patient_updated' AND result='ok' ORDER BY id"
        ).fetchall()
        expected = fixture["users"][fixture["mutation"]["userIndex"]]["actorId"]
        assert all(row == (patient, expected, "field=age") for row in writes)
        assert version == 1 + len(writes)
        release = Counter(conn.execute(
            "SELECT m.snapshot_sha256, a.actor_user_id FROM read_access_manifests m "
            "JOIN audit_events a ON a.id=m.audit_event_id WHERE a.event_type='medical_read_release'"
        ))
        release_count, manifest_count = conn.execute(
            "SELECT count(*), count(m.audit_event_id) FROM audit_events a "
            "LEFT JOIN read_access_manifests m ON a.id=m.audit_event_id "
            "WHERE a.event_type='medical_read_release'"
        ).fetchone()
        assert release_count == manifest_count
        wrong_count = sum(
            len(json.loads(objects)) != count for objects, count in conn.execute(
                "SELECT objects_json, object_count FROM read_access_manifests")
        )
        assert wrong_count == 0
        sha_pairs = Counter(
            (event["sha256"], fixture["users"][event["userIndex"]]["actorId"])
            for event in driver.get("releaseDigests", [])
        )
        missing = sum((sha_pairs - release).values())
        committed = driver.get("successfulWrites")
        assert committed is None or committed == len(writes), "Browser writes and audit disagree"
        assert sha_pairs, "No exact protected read digest was captured"
        assert not missing, "Successful observed response has no actor-matched exact manifest"
        assert len(writes) == 0 or age == (46 if len(writes) % 2 == 0 else 47)
        return dict(
            versionsMatch=True, successfulClinicalCommits=len(writes), mandatoryWriteAudits=len(writes),
            medicalReadReleaseEvents=release_count, pairedReadManifests=manifest_count,
            observedResponseDigestsMatched=sum(sha_pairs.values()), manifestCountsMatch=True,
            observedResponsePairing="actor plus SHA-256 body", dbQuickCheck="ok",
        )


def stop(worker):
    if worker.poll() is None:
        worker.send_signal(signal.SIGINT)
    try:
        return worker.wait(timeout=15) == 0
    except subprocess.TimeoutExpired:
        worker.kill()
        worker.wait(timeout=5)
        return False


def main(args):
    proof = preflight(args.repo)
    args.out.mkdir(mode=0o700, parents=False, exist_ok=False)
    with socket.socket() as probe:
        probe.bind((HOST, 0))
        port = probe.getsockname()[1]
    url = f"http://{HOST}:{port}"
    with tempfile.TemporaryDirectory(prefix="clinic-pilot-p-", dir="/tmp") as owned:
        scratch = Path(owned).resolve()
        env = {"PATH": os.defpath, "HOME": str(scratch), "TMPDIR": str(scratch), "LANG": "C.UTF-8"}
        with (args.out / "server.log").open("wb") as output:
            worker = subprocess.Popen(
                [sys.executable, "-I", "-B", str(HERE / "p_server.py"), str(args.repo), str(port), str(scratch)],
                cwd=scratch, env=env, stdout=output, stderr=output,
            )
        clean_exit = False
        try:
            fixture = wait_ready(worker, url, scratch)
            proof.update(dict(schema=33, patients=1000, loopbackOnly=True, processCount=1,
                              outboundSocketsBlocked=True, externalAi="disabled", notifications="mock",
                              fixturePlanSha256=fixture["fixturePlanSha256"]))
            if args.preflight_only:
                result = {"preflight": proof}
            else:
                private = args.out / "driver.json"
                # Browser subprocess inherits only explicit dependencies and its own private profile.
                browser_env = dict(
                    env, PATH=str(args.node.parent) + os.pathsep + os.defpath,
                    PLAYWRIGHT_BROWSERS_PATH=str(args.browsers), PLAYWRIGHT_MODULE=str(args.playwright),
                )
                if args.chromium:
                    browser_env["BROWSER_EXECUTABLE"] = str(args.chromium)
                proof["node"] = subprocess.check_output([str(args.node), "--version"], text=True).strip()
                proof["browserExplicitExecutable"] = bool(args.chromium)
                with (args.out / "browser.log").open("wb") as output:
                    cmd = [str(args.node), str(HERE / "browser_p.cjs"), str(scratch / "fixture.json"),
                           str(private), str(args.mode), str(args.seconds), str(args.warmup)]
                    run = subprocess.run(cmd, cwd=scratch, env=browser_env, stdout=output, stderr=output,
                                         timeout=240)
                if not private.is_file():
                    raise RuntimeError(f"Browser driver did not produce results (exit {run.returncode})")
                driver = json.loads(private.read_text())
                result = {"preflight": proof, "driverExit": run.returncode,
                          "medical": verify(scratch / "db" / "clinic.db", fixture, driver),
                          "browser": driver["public"]}
        finally:
            clean_exit = stop(worker)
    with socket.socket() as sock:
        sock.settimeout(0.5)
        closed = sock.connect_ex((HOST, port)) != 0
    result["cleanup"] = dict(cleanServerExit=clean_exit, listenerClosed=closed,
                             syntheticFilesRemoved=not scratch.exists())
    (args.out / "public.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    if not all(result["cleanup"].values()) or result.get("driverExit", 0):
        return 1
    return 0


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--node", type=Path, default=Path("/usr/local/bin/node"))
    parser.add_argument("--playwright", type=Path)
    parser.add_argument("--browsers", type=Path)
    parser.add_argument("--chromium", type=Path)
    parser.add_argument("--mode", type=int, choices=(4, 8), default=4)
    parser.add_argument("--seconds", type=int, choices=range(8, 31), default=20)
    parser.add_argument("--warmup", type=int, choices=range(2, 11), default=4)
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()
    args.repo, args.out = args.repo.resolve(strict=True), args.out.resolve()
    if not args.preflight_only:
        if not args.playwright or not args.browsers:
            parser.error("browser runs require local Playwright and installed Chromium paths")
        args.node = args.node.resolve(strict=True)
        args.playwright = args.playwright.resolve(strict=True)
        args.browsers = args.browsers.resolve(strict=True)
        if args.chromium:
            args.chromium = args.chromium.resolve(strict=True)
    sys.exit(main(args))
