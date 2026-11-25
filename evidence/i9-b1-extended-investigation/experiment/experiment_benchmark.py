"""Matched synthetic B1/experiment probe. Run with an isolated locked Python."""
from collections import Counter
from hashlib import sha256
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys

out, originals, experiment, harness = map(Path, sys.argv[1:5])
out.mkdir()
worker = harness / "instrumented_worker.py"
fixture = originals / "tools/tests/wp_h/server.py"
arms = {"B1": originals, "E1": experiment}
expected = {"B1": "3a0cb5db434032b3f7b6370c305c558a4b5d331c",
            "E1": "8ed79d7d2b9c342796c3f778c0a8ab92919ecdd9"}
assert all(subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"],text=True).strip()==expected[key] for key,path in arms.items())
orders = (("B1","E1"),("E1","B1"),("B1","E1"),("E1","B1"))
def digest(p):
    return sha256(p.read_bytes()).hexdigest()
plan = {"purpose":"exploratory experimental-summary paired comparison","git_shas":expected,
        "count":10000,"role":"developer","sessions":4,"get_per_session_hz":"1.5",
        "patch_hz":"1","seconds":8,"order_by_pair":orders,
        "offered_outcomes":"all planned slots; post-window HTTP reported separately",
        "invalid_arm":"nonzero worker exit, receipt/method slots mismatch or invariant failure; stop and preserve",
        "success":"GET 200 with committed exact release audit/manifest; no changed protocol",
        "harness_sha256":{p.name:digest(p) for p in [Path(__file__),fixture,*sorted(harness.glob("*.py"))]}}
plan_path = out/"PLAN.json"
plan_path.write_text(json.dumps(plan,indent=2)+"\n")
summary=[]
slot_signature=None
for pair,order in enumerate(orders,1):
    for arm in order:
        name=f"{pair}-{arm}"
        receipt=out/f"{name}.json"
        log=out/f"{name}.private.log"
        cmd=[sys.executable,"-I","-B",str(worker),"worker","--worktree",str(arms[arm]),"--sha",expected[arm],
             "--fixture",str(fixture),"--count","10000","--role","developer","--sessions","4","--warmup","1","--waves","0",
             "--clinical-writer","--open-seconds","8","--get-hz","1.5","--patch-hz","1","--out",str(receipt)]
        with log.open("xb") as f:
            result=subprocess.run(cmd,env={"PATH":os.defpath,"CLINIC_I9_CHILD":"1"},stdout=f,stderr=subprocess.STDOUT)
        if result.returncode:
            raise SystemExit(f"invalid arm {name}, exit {result.returncode}")
        d=json.loads(receipt.read_text())
        o=d["open_loop"]
        assert o["read_audit_manifest_verified"] and o["clinical_version_age_audit_verified"]
        e=o["events"]
        slots=[[x["scheduled_ns"],x["method"],x["slot"],x["method_index"]] for x in e]
        sig=sha256(json.dumps(slots,separators=(",",":")).encode()).hexdigest()
        if slot_signature is None:
            slot_signature=sig
        assert sig==slot_signature and Counter(x["method"] for x in e)=={"GET":48,"PATCH":8}
        def stats(values):
            if not values:
                return None
            return [round(statistics.median(values),3),round(sorted(values)[math.ceil(len(values)*.95)-1],3)]
        metrics={}
        for method in ("GET","PATCH"):
            rows=[x for x in e if x["method"]==method]
            started=[x for x in rows if isinstance(x["status"],int)]
            ok=[x for x in started if x["status"]==200]
            metrics[method]={"outcomes":dict(Counter(str(x["status"]) for x in rows)),
                             "http_after_window":sum(x["completion_ns"]>8e9 for x in started),
                             "http_p50_p95_ms":stats([(x["completion_ns"]-x["dispatch_ns"])/1e6 for x in started]),
                             "ok_p50_p95_ms":stats([(x["completion_ns"]-x["dispatch_ns"])/1e6 for x in ok])}
        summary.append({"pair":pair,"arm":arm,"metrics":metrics,"raw_sha256":digest(receipt),"slots_sha256":sig})
        print(name,metrics,flush=True)
(out/"EXPERIMENT_COMPARISON.json").write_text(json.dumps({"plan_sha256":digest(plan_path),"arms":summary},indent=2)+"\n")
