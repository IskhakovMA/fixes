"""Foreground technical launcher for operator-performed D8 on exact B1."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

B1 = "3a0cb5db434032b3f7b6370c305c558a4b5d331c"
HOST = "127.0.0.1"
COUNT = 240
STAND = Path(__file__).resolve().parent / "stand" / "d8_stand.py"
KEYS = {
    "D8_SHA", "D8_PID", "D8_URL", "D8_FIXTURE_FILE", "D8_HEALTH", "D8_OUTBOUND",
}


def stop_request(_signum, _frame):
    raise KeyboardInterrupt


def exact_checkout(repo):
    command = ["git", "--no-optional-locks", "-C", str(repo)]
    env = {"PATH": os.defpath, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    sha = subprocess.check_output([*command, "rev-parse", "HEAD"], env=env, text=True).strip()
    dirty = subprocess.check_output(
        [*command, "status", "--porcelain", "--untracked-files=all"], env=env, text=True,
    )
    if sha != B1 or dirty:
        raise RuntimeError("requires a clean detached checkout of exact B1")


def read_markers(log):
    markers = {}
    for line in log.read_text(errors="replace").splitlines():
        key, sep, value = line.partition("=")
        if sep and key in KEYS:
            markers[key] = value
    return markers


def wait_ready(child, log):
    until = time.monotonic() + 65
    while time.monotonic() < until:
        if child.poll() is not None:
            raise RuntimeError("launcher rejected its technical preflight or startup")
        markers = read_markers(log)
        if set(markers) == KEYS:
            return markers
        time.sleep(0.25)
    raise RuntimeError("launcher readiness deadline")


def ready_receipt(markers, url, port):
    fixture = Path(markers["D8_FIXTURE_FILE"])
    scratch = fixture.parent.resolve(strict=True)
    if scratch.parent != Path("/tmp").resolve() or not scratch.name.startswith("clinic-d8-"):
        raise RuntimeError("unexpected test scratch location")
    assert fixture.name == "fixture.json"
    assert markers["D8_SHA"] == B1 and markers["D8_URL"] == url
    assert markers["D8_OUTBOUND"] == "python-socket-denied"
    assert markers["D8_HEALTH"] in {"ok", "ready"}
    metadata = fixture.lstat()
    assert stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid()
    assert stat.S_IMODE(metadata.st_mode) == 0o600
    data = json.loads(fixture.read_bytes())
    assert data["baseURL"] == url and data["syntheticOnly"] is True and data["count"] == COUNT
    server_pid = int(markers["D8_PID"])
    listen = subprocess.check_output(
        ["/usr/sbin/lsof", "-nP", "-a", "-p", str(server_pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
        text=True, timeout=5,
    )
    assert [line for line in listen.splitlines() if line.startswith("n")] == [f"n{HOST}:{port}"]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url + "/healthz", timeout=5) as response:
        assert response.status == 200 and json.load(response)["status"] in {"ok", "ready"}
    with opener.open(url + "/", timeout=5) as response:
        assert response.status == 200 and response.headers.get_content_type() == "text/html"
    assert any(path.is_file() for path in scratch.glob("**/clinic.db"))
    receipt = {
        "exactProductSha": B1, "listener": f"{HOST}:{port}", "healthHttp": 200,
        "htmlHttp": 200, "syntheticPatients": COUNT, "privateFixture": "0600",
        "outboundSocketPolicy": "python-socket-denied", "manualResultsRecorded": 0,
    }
    return fixture, scratch, receipt


def stop(child):
    if child.poll() is None:
        child.terminate()
    try:
        return child.wait(timeout=20)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=5)
        raise RuntimeError("stand required forced stop; clean shutdown is unconfirmed") from None


def port_occupied(port):
    with socket.socket(socket.AF_INET) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex((HOST, port)) == 0


def run(repo, port, smoke):
    exact_checkout(repo)
    if port_occupied(port):
        raise RuntimeError("loopback port is already in use")
    url = f"http://{HOST}:{port}"
    with tempfile.TemporaryDirectory(prefix="clinic-d8-operator-") as temp:
        log = Path(temp) / "launcher.log"
        with log.open("wb") as output:
            child = subprocess.Popen(
                [sys.executable, "-I", "-B", str(STAND), str(repo), str(port)],
                stdout=output, stderr=output, start_new_session=True,
            )
        fixture = scratch = receipt = None
        try:
            markers = wait_ready(child, log)
            fixture, scratch, receipt = ready_receipt(markers, url, port)
            if not smoke:
                print(f"Стенд B1 готов. Safari: {url}/", flush=True)
                print(f"Фикстура только локально: {fixture}", flush=True)
                print("Завершение после квитанций — Ctrl+C в этом терминале.", flush=True)
                status = child.wait()
                raise RuntimeError(f"stand exited during operator session, status {status}")
        except KeyboardInterrupt:
            if receipt is None:
                raise RuntimeError("startup interrupted before verified readiness") from None
        finally:
            exit_code = stop(child)
            if scratch is not None and (scratch.exists() or fixture.exists() or port_occupied(port)):
                raise RuntimeError("stand stopped but temporary storage or listener remains")
        assert receipt is not None and exit_code == 0
        receipt.update(cleanExit=True, listenerClosed=True, scratchRemoved=True, fixtureRemoved=True)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="absolute path to the clean exact B1 checkout")
    parser.add_argument("--port", type=int, default=19089)
    parser.add_argument("--smoke", action="store_true", help="verify startup and immediately stop")
    parser.add_argument("--receipt", type=Path, help="write technical JSON to a new local file")
    args = parser.parse_args()
    if not __debug__:
        parser.error("run without Python optimization to preserve technical checks")
    os.umask(0o077)
    signal.signal(signal.SIGTERM, stop_request)
    if not args.app.is_absolute() or not 1024 <= args.port <= 65535:
        parser.error("use an absolute checkout path and an unprivileged port")
    if args.receipt and args.receipt.exists():
        parser.error("receipt path already exists")
    try:
        receipt = run(args.app.resolve(strict=True), args.port, args.smoke)
        encoded = json.dumps(receipt, ensure_ascii=False, indent=2) + "\n"
        if args.receipt:
            with args.receipt.open("x") as output:
                output.write(encoded)
        sys.stdout.write(encoded)
    except (RuntimeError, OSError, subprocess.SubprocessError, AssertionError, KeyError, ValueError) as error:
        if type(error) is RuntimeError:
            print("Technical D8 BLOCKED: " + str(error), file=sys.stderr)
        else:
            print("Technical D8 BLOCKED: machine verification did not complete", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
