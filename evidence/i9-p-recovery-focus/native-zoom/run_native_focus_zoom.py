#!/usr/bin/env python3
"""Run the test-only timing probe against the exact clean B1 synthetic server."""
import argparse
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

B1 = '3a0cb5db434032b3f7b6370c305c558a4b5d331c'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('b1_checkout', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--candidate', action='store_true')
    args = parser.parse_args()
    app = args.b1_checkout.resolve(strict=True)
    git = ['git', '--no-optional-locks', '-C', str(app)]
    dirty = subprocess.check_output([*git, 'status', '--porcelain'], text=True).splitlines()
    if subprocess.check_output([*git, 'rev-parse', 'HEAD'], text=True).strip() != B1 or dirty != ([' M static/app.js'] if args.candidate else []):
        raise SystemExit('requires exact B1, with only the candidate diff when explicitly selected')
    out = args.output.resolve()
    if app in out.parents or app == out:
        raise SystemExit('output must be outside the checkout')
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    server = app / 'tools/tests/wp_h/server.py'
    probe = Path(__file__).with_name('focus_native_zoom.cjs')
    source = server.read_text(encoding='utf-8')
    # Reuse only the embedded credentials of the signed-off synthetic fixture.
    # The values are inherited by the one local probe and never serialized.
    local_credential = re.search(r"password='([^']+)'", source).group(1)
    local_identity = re.search(r"dev=account\('([^']+)'", source).group(1)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    with ((out / 'timing-server.local.log').open('wb') as server_log,
          tempfile.TemporaryDirectory(dir=out, prefix='synthetic-') as scratch):
        env = {
            'PATH': os.environ['PATH'], 'HOME': os.environ['HOME'],
            'TMPDIR': scratch, 'PYTHONDONTWRITEBYTECODE': '1',
        }
        server_process = subprocess.Popen(
            [sys.executable, '-B', str(server), '--count', '1000', '--port', str(port)],
            env=env, stdout=server_log, stderr=subprocess.STDOUT)
        try:
            http = build_opener(ProxyHandler({}))
            until = time.monotonic() + 35
            while server_process.poll() is None:
                try:
                    with http.open(origin + '/', timeout=1) as response:
                        if response.status == 200 and response.headers.get_content_type() == 'text/html':
                            break
                except OSError:
                    pass
                if time.monotonic() > until:
                    raise RuntimeError('synthetic server readiness deadline')
                time.sleep(0.1)
            else:
                raise RuntimeError('synthetic server exited before readiness')
            for name in ('PLAYWRIGHT_MODULE', 'BROWSER_EXECUTABLE', 'AXE_SOURCE', 'FOCUS_CASES', 'WP_H_FULL_CHROMIUM'):
                if name in os.environ:
                    env[name] = os.environ[name]
            env.update(WP_H_ORIGIN=origin, P_FAULT_SYNTHETIC_USER=local_identity,
                       P_FAULT_SYNTHETIC_PASSWORD=local_credential,
                       EXPECT_FOCUS='1' if args.candidate else '0')
            with ((out / 'I9_NATIVE_FOCUS_ZOOM.json').open('wb') as result_stream,
                  (out / 'timing-stderr.local.log').open('wb') as error_stream):
                result = subprocess.run(['node', str(probe)], env=env, stdout=result_stream,
                                        stderr=error_stream, timeout=150)
        finally:
            if server_process.poll() is None:
                server_process.send_signal(signal.SIGINT)
            try:
                stopped = server_process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                server_process.kill()
                server_process.wait()
                raise RuntimeError('synthetic server required forced stop') from None
            if stopped != 0 or list(Path(scratch).glob('**/clinic.db')):
                raise RuntimeError('synthetic server shutdown or SQLite cleanup failed')
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
