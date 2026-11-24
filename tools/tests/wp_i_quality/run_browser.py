"""Run the browser suite against the localhost-only synthetic I-8A3 FastAPI lab."""
import argparse
from contextlib import ExitStack
from pathlib import Path
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
from urllib.request import urlopen


def loopback_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--suite', choices=('browser', 'browser_zoom', 'browser_perf'), default='browser')
    parser.add_argument('--count', default=240, type=int)
    args = parser.parse_args()
    output = args.out.resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    here = Path(__file__).resolve().parent
    with ExitStack() as temporary:
        scratch = Path(temporary.enter_context(tempfile.TemporaryDirectory(prefix='private-fixture-', dir=output)))
        browser_tmp = scratch
        if sys.platform == 'linux' and args.suite == 'browser_zoom':
            # Chromium's ProcessSingleton must fit its socket path into Linux sockaddr_un.
            browser_tmp = Path(temporary.enter_context(tempfile.TemporaryDirectory(prefix='qz.', dir='/tmp')))
        fixture = scratch / 'fixture.local.json'
        ready = threading.Event()
        port = loopback_port()
        with (output / 'server.local.log').open('wb') as server_log:
            server = subprocess.Popen(
                [sys.executable, str(here / 'lab.py'), '--port', str(port),
                 '--fixture-file', str(fixture), '--scratch-dir', str(scratch),
                 '--count', str(args.count)],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={
                    **os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
                },
            )

            def drain():
                for line in iter(server.stdout.readline, b''):
                    server_log.write(line)
                    server_log.flush()
                    if b'Uvicorn running on' in line:
                        ready.set()

            reader = threading.Thread(target=drain)
            reader.start()
            try:
                if not ready.wait(180) or not fixture.is_file():
                    raise RuntimeError('The synthetic server did not start.')
                with urlopen(f'http://127.0.0.1:{port}/healthz', timeout=10) as health:
                    if health.status != 200:
                        raise RuntimeError('The synthetic server is not ready.')
                env = {
                    **os.environ, 'WP_I_QUALITY_FIXTURE': str(fixture), 'WP_I_QUALITY_OUT': str(output),
                    'TMPDIR': str(browser_tmp),
                }
                with (output / 'browser.local.log').open('wb') as browser_log:
                    result = subprocess.run(
                        ['node', str(here / f'{args.suite}.cjs')], env=env,
                        stdout=browser_log, stderr=subprocess.STDOUT, check=False,
                    )
                return result.returncode
            finally:
                if server.poll() is None:
                    server.send_signal(signal.SIGINT)
                try:
                    server.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
                reader.join(timeout=10)
                server.stdout.close()


if __name__ == '__main__':
    raise SystemExit(main())
