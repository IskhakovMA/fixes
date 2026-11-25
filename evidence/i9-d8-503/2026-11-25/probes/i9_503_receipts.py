import json, os, sqlite3, time
from pathlib import Path
from starlette.testclient import TestClient
from pytest import MonkeyPatch

def pytest_configure(config):
    patch = MonkeyPatch()
    original = TestClient.request
    def observed(self, method, url, *args, **kwargs):
        started = time.monotonic()
        response = original(self, method, url, *args, **kwargs)
        if response.status_code in {401, 403, 404, 409, 410, 500, 503}:
            try:
                body = response.json()
            except ValueError:
                body = None
            code = body.get('code') if isinstance(body, dict) else None
            with Path(os.environ['I9_RECEIPTS']).open('a') as out:
                print(json.dumps(dict(case=os.environ.get('PYTEST_CURRENT_TEST','').split(' (')[0],
                    method=method, status=response.status_code, code=code,
                    responseKeys=sorted(body) if isinstance(body,dict) else None,
                    elapsedMs=round((time.monotonic()-started)*1000,2))),file=out)
        return response
    patch.setattr(TestClient, 'request', observed)
    config.add_cleanup(patch.undo)
