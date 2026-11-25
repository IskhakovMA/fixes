"""Verify the disposable D8 stand on macOS, then stop it and check cleanup."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request

PORT = 18889
URL = f'http://127.0.0.1:{PORT}'
SHA = 'f849b2909c2d23923e0ce996f0aca4b670ca9c18'
launch = Path(__file__).with_name('launch-d8.sh').resolve()
repo = Path(sys.argv[1]).resolve(strict=True)
python = os.path.abspath(sys.executable)  # Keep the virtualenv entrypoint.
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
evidence = {}
with tempfile.TemporaryDirectory(prefix='d8-receipt-') as root:
    logpath = Path(root) / 'worker.log'
    with logpath.open('wb') as log:
        proc = subprocess.Popen(['bash', str(launch), str(repo), python, str(PORT)], stdout=log, stderr=log)
    fixture = None
    try:
        for _ in range(120):
            hooks = dict(line.split('=', 1) for line in logpath.read_text(errors='replace').splitlines()
                         if line.startswith('D8_') and '=' in line)
            if {'D8_FIXTURE_FILE', 'D8_SHA', 'D8_OUTBOUND', 'D8_URL'} <= hooks.keys():
                fixture = Path(hooks['D8_FIXTURE_FILE'])
                break
            if proc.poll() is not None:
                raise RuntimeError(f'D8 launcher exited before verification with status {proc.returncode}')
            time.sleep(0.5)
        assert fixture is not None, 'D8 launcher readiness deadline'
        scratch = fixture.parent.resolve(strict=True)
        assert scratch.parent == Path('/tmp').resolve() and scratch.name.startswith('clinic-d8-')
        assert hooks['D8_SHA'] == SHA and hooks['D8_URL'] == URL
        assert hooks['D8_OUTBOUND'] == 'python-socket-denied'
        fixture_stat = fixture.lstat()
        assert stat.S_ISREG(fixture_stat.st_mode) and fixture_stat.st_uid == os.getuid()
        assert stat.S_IMODE(fixture_stat.st_mode) == 0o600
        metadata = json.loads(fixture.read_text())
        assert metadata['count'] == 240 and metadata['syntheticOnly'] is True and metadata['baseURL'] == URL
        listen = subprocess.check_output(['lsof', '-nP', '-a', '-p', hooks['D8_PID'], '-iTCP', '-sTCP:LISTEN', '-Fn'], text=True)
        assert [x for x in listen.splitlines() if x.startswith('n')] == [f'n127.0.0.1:{PORT}']
        with client.open(URL + '/healthz', timeout=5) as response:
            status = response.status
            ready = json.load(response)['status']
            assert status == 200 and ready in {'ok', 'ready'}
        with client.open(URL + '/', timeout=5) as response:
            html = response.status == 200 and response.headers.get_content_type() == 'text/html'
            assert html
        db_exists = any(f.is_file() for f in scratch.glob('**/clinic.db'))
        assert db_exists, 'synthetic clinic.db was not created'
        evidence = dict(sha=SHA, python=sys.version.split()[0], listener=f'127.0.0.1:{PORT}', healthHttp=status,
                        healthStatus=ready, frontendHtml=html, syntheticPatients=240,
                        sqliteExisted=True, fixtureMode='0600', fixtureOwnedByOperator=True,
                        isolatedServerConfigCheckedByLauncher=True, externalSocketsBlockedByPythonAuditHook=True,
                        manualResultsRecorded=0)
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            proc.wait(timeout=20)

assert not scratch.exists(), 'temporary state survived stop'
evidence.update(scratchRemoved=True, fixtureRemoved=True, temporarySqliteFamilyRemoved=True)
print(json.dumps(evidence, ensure_ascii=False, indent=2))
