import ast
from datetime import datetime, timedelta, timezone
import json
import os
import random
import subprocess
import sys

sys.path.insert(0, os.path.abspath("backend"))
from app import clock, patient_pages

source = subprocess.check_output(
    ["git", "show", "HEAD^:backend/app/patient_pages.py"], text=True
)
names = {"_summary", "_page_fingerprint"}
nodes = [n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name in names]
assert len(nodes) == 2
reference = dict(vars(patient_pages))
exec(compile(ast.Module(body=nodes, type_ignores=[]), "<exact parent summary>", "exec"), reference)
rng = random.Random(45)
clock.now_moscow = lambda: datetime(2026, 11, 25, 0, 0, tzinfo=clock.institution_tz())
dates = [None, "", "bad", "2026-11-18", "2026-11-17T20:59:59Z", "2026-11-17T21:00:00Z",
         "2026-11-18T01:00:00+04:00", "2026-11-25T12:30:00Z"]
iterations = 0
for length in [0, 1, 8, 50, 1000, 10000]:
    for _ in range(20):
        rows = [{"id":str(i), "arrival":rng.choice(dates), "stage":rng.choice(tuple(sorted(patient_pages.STAGES))),
                 "treatingDoctorUserId":rng.choice([None, "", "synthetic-user"])} for i in range(length)]
        selected = rows[::2]
        summary = patient_pages._summary(rows)
        assert summary == reference["_summary"](rows)
        assert patient_pages._page_fingerprint(rows, selected, summary) == reference["_page_fingerprint"](rows, selected)
        iterations += 1
print(json.dumps({"synthetic_only":True,"sets":iterations,"max_scope":10000,"summary_equal":True,"fingerprints_equal":True}))
