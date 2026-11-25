"""Run additional authorized F1 browser negative cases without product edits."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile

app = Path(sys.argv[1]).resolve()
base = app / "tools/tests/fast_track_f1"
out = Path(sys.argv[2]).resolve()
out.mkdir(mode=0o700)
here = Path(__file__).resolve().parent
os.umask(0o077)
spec = importlib.util.spec_from_file_location("f1_baseline_runner", base / "run.py")
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
test_js = out / "supplement.cjs"
browser = (base / "browser.cjs").read_text()
test_js.write_text(browser.rsplit("\nmain().catch(", 1)[0] + "\n" + (here / "supplement.js").read_text())
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
with tempfile.TemporaryDirectory(prefix="clinic-f1-") as temp:
    scratch = Path(temp).resolve()
    env = {"PATH": os.environ["PATH"], "HOME": str(scratch), "TMPDIR": str(scratch), "LANG": "C.UTF-8",
           "PYTHONDONTWRITEBYTECODE": "1"}
    fixture = scratch / "fixture.json"
    with (out / "server.local.log").open("wb") as server_log:
        worker = subprocess.Popen(
            [sys.executable, "-I", "-B", str(base / "server.py"), "--scratch", str(scratch),
             "--port", str(port)], cwd=scratch, env=env, stdout=server_log, stderr=subprocess.STDOUT,
        )
    try:
        common.wait_ready(worker, f"http://127.0.0.1:{port}", fixture)
        db = scratch / "db/clinic.db"
        before = common.clinical_digest(db)
        with (out / "browser.local.log").open("wb") as browser_log:
            driver = subprocess.run(
                ["node", str(test_js)], cwd=scratch, env={
                    **env,
                    **{k: os.environ[k] for k in ("PLAYWRIGHT_MODULE", "PLAYWRIGHT_BROWSERS_PATH")},
                    "F1_FIXTURE": str(fixture), "F1_RECEIPT": str(out / "checks.json"),
                }, stdout=browser_log, stderr=subprocess.STDOUT, timeout=150, check=False,
            )
        if driver.returncode:
            sys.exit(driver.returncode)
        assert before == common.clinical_digest(db)
        result = json.loads((out / "checks.json").read_bytes())
        result["candidateSha"] = subprocess.check_output(["git", "-C", str(app), "rev-parse", "HEAD"],
                                                          text=True).strip()
        result["clinicalFixturesUnchanged"] = True
    finally:
        worker.send_signal(signal.SIGINT)
        assert worker.wait(timeout=15) == 0
with socket.socket() as listener:
    listener.settimeout(0.5)
    closed = listener.connect_ex(("127.0.0.1", port)) != 0
result["cleanup"] = {"databaseRemoved": not scratch.exists(), "listenerClosed": closed}
assert all(result["cleanup"].values())
(out / "public.json").write_text(json.dumps(result, indent=2) + "\n")
print("F1 supplementary Chromium: PASS")
