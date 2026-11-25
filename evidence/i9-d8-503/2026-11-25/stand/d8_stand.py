"""Launch the existing I-9 synthetic lab without inherited credentials or outbound connections."""

import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

EXPECTED_SHA = 'f849b2909c2d23923e0ce996f0aca4b670ca9c18'
HOST = '127.0.0.1'
PATIENT_COUNT = 240
LAB_PATH = 'tools/tests/wp_i_quality/lab.py'
SYSTEM_PATH = os.defpath
PIN = re.compile(r'^([\w.-]+)==([^\s\\]+)', re.MULTILINE)


def refuse(description):
    raise RuntimeError(description)


def preflight(repo, port):
    if sys.version_info[:2] != (3, 13) or sys.prefix == sys.base_prefix:
        refuse('use the locked Python 3.13 virtualenv')
    args = ['git', '--no-optional-locks', '-C', str(repo)]
    git_env = {'PATH': SYSTEM_PATH, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
    sha = subprocess.check_output([*args, 'rev-parse', 'HEAD'], env=git_env, text=True).strip()
    if sha != EXPECTED_SHA:
        refuse('Git HEAD differs from accepted integration: ' + sha)
    status = subprocess.check_output(
        [*args, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored', '--',
         'index.html', 'static', 'backend', 'tools/tests/wp_i_quality'],
        env=git_env, text=True,
    )
    if status:
        refuse('worktree contains changes or ignored files in runtime paths')
    if (repo / '.env').exists() or (repo / '.env').is_symlink():
        refuse('worktree has a local .env file')
    for filename in ('requirements.txt', 'requirements-dev.txt'):
        pins = tuple(PIN.finditer((repo / 'backend' / filename).read_text()))
        if not pins:
            refuse('lock file has no readable dependency pins: ' + filename)
        for pin in pins:
            verify_pin(pin)
    with socket.socket(socket.AF_INET) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((HOST, port))


def verify_pin(pin):
    name, expected = pin.groups()
    if importlib.metadata.version(name) != expected:
        refuse('locked package version differs for ' + name)


def child(repo, port, scratch):
    def network_guard(event, args):
        if event in {'socket.connect', 'socket.sendto', 'socket.sendmsg'}:
            raise PermissionError('D8 stand blocks outbound socket traffic')
        if event == 'socket.bind':
            sock, address = args
            if sock.family != socket.AF_INET or address != (HOST, port):
                raise PermissionError('D8 stand binds only its selected loopback port')
        if event == 'socket.getaddrinfo' and args[0] != HOST:
            raise PermissionError('D8 stand does not resolve external hosts')
        if event in {'socket.gethostbyname', 'socket.gethostbyaddr', 'socket.getnameinfo',
                     'os.system', 'os.posix_spawn', 'os.fork', 'os.forkpty', 'subprocess.Popen'}:
            raise PermissionError('D8 stand blocks external name lookup and child commands')

    sys.addaudithook(network_guard)
    spec = importlib.util.spec_from_file_location('locked_d8_lab', repo / LAB_PATH)
    lab = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lab)
    configure_lab = lab.configure_environment

    def assert_config(data, lab_port):
        configure_lab(data, lab_port)
        from backend.app import config
        if (data.resolve().parent != scratch or config.DATA_DIR != data.resolve()
                or config.DB_PATH.parent != data.resolve() or config.APP_ENV != 'test'
                or config.HOST != HOST or config.PORT != port or config.AI_MODE != 'disabled'
                or config.AI_DATA_MODE != 'disabled' or config.NOTIFICATION_PROVIDER != 'mock'
                or config.TRUSTED_PROXY_IPS):
            refuse('test data or integration configuration failed isolation check')

    lab.configure_environment = assert_config
    lab.run(port, PATIENT_COUNT, scratch / 'fixture.json', scratch)


def health_probe(base_url):
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with client.open(base_url + '/healthz', timeout=1) as response:
        readiness = json.load(response)
    if readiness.get('status') not in {'ok', 'ready'}:
        refuse('loopback readiness endpoint did not confirm start-up')
    with client.open(base_url + '/', timeout=1) as response:
        if response.status != 200 or response.headers.get_content_type() != 'text/html':
            refuse('loopback frontend did not serve the application')
    return readiness['status']


def supervise(repo, port):
    os.umask(0o077)
    preflight(repo, port)
    base_url = f'http://{HOST}:{port}'
    with tempfile.TemporaryDirectory(prefix='clinic-d8-', dir='/tmp') as temp:
        scratch = Path(temp).resolve(strict=True)
        fixture = scratch / 'fixture.json'
        clean_env = {'PATH': SYSTEM_PATH, 'HOME': str(scratch), 'TMPDIR': str(scratch), 'LANG': 'C.UTF-8'}
        worker = subprocess.Popen(
            [sys.executable, '-I', '-B', str(Path(__file__).resolve()),
             '--serve', str(repo), str(port), str(scratch)],
            cwd=scratch,
            env=clean_env,
        )
        try:
            for _ in range(120):
                if worker.poll() is not None:
                    refuse(f'lab process exited before readiness with code {worker.returncode}')
                if fixture.is_file():
                    try:
                        ready = health_probe(base_url)
                    except (urllib.error.URLError, TimeoutError):
                        pass
                    else:
                        break
                time.sleep(0.5)
            else:
                refuse('loopback readiness did not arrive within 60 seconds')
            private = fixture.stat()
            metadata = json.loads(fixture.read_text())
            if (not stat.S_ISREG(private.st_mode) or private.st_uid != os.getuid()
                    or stat.S_IMODE(private.st_mode) != 0o600 or metadata.get('baseURL') != base_url
                    or metadata.get('syntheticOnly') is not True or metadata.get('count') != PATIENT_COUNT):
                refuse('generated fixture failed ownership or synthetic metadata checks')
            print(f'D8_SHA={EXPECTED_SHA}\nD8_PID={worker.pid}\nD8_URL={base_url}', flush=True)
            print(f'D8_FIXTURE_FILE={fixture}\nD8_HEALTH={ready}\nD8_OUTBOUND=python-socket-denied', flush=True)
            return worker.wait()
        finally:
            if worker.poll() is None:
                worker.terminate()
                try:
                    worker.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    worker.kill()
                    worker.wait()


if __name__ == '__main__':
    try:
        if len(sys.argv) == 5 and sys.argv[1] == '--serve':
            child(Path(sys.argv[2]), int(sys.argv[3]), Path(sys.argv[4]))
        elif len(sys.argv) == 3:
            signal.signal(signal.SIGTERM, lambda _signal, _frame: sys.exit(0))
            port = int(sys.argv[2])
            if not 1024 <= port <= 65535:
                refuse('use an unprivileged port from 1024 through 65535')
            sys.exit(supervise(Path(sys.argv[1]).resolve(strict=True), port))
        else:
            refuse('invalid launcher arguments')
    except KeyboardInterrupt:
        sys.exit(130)
