"""Small closed-set H4/H7 artifacts from confirmed synthetic event traces."""
import argparse,json
from collections import Counter
from pathlib import Path
from hashlib import sha256
from statistics import median

def d(q):return sha256(q).hexdigest()
def fmt(n,s):return round((n-s)/1e6,3)
def sets(row, keys, start):
 out={}
 for k in keys:
  if k in row: out[k[:-3]+"_ms" if k.endswith("_ns") else k]=fmt(row[k],start) if k.endswith("_ns") else row[k]
 return out
def one(arm, category):
 data=Path(arm).read_bytes()
 j=json.loads(data)
 o=j["open_loop"];start=o["start_monotonic_ns"]
 xs=[r for r in o["events"] if r["method"]=="GET" and r["status"]==409
     and r.get("conflict_explanation",{}).get("category")==category]
 assert xs
 row=xs[0]
 cause=row["conflict_explanation"]
 snapkeys=('phase','enter_ns','first_read_start_ns','first_read_execute_done_ns','end_ns')
 r={"receipt_sha256":d(data),"sha":j["sha"],"count":j["count"],"role":j["role"],"request_ordinal":row["event"],
    "http":409,"code":row["conflict_code"],"cause":category,"cause_point":cause["point"],
    "same_connection_samples":[sets(x,("start_ns","end_ns","under_writer","connection_ordinal","value"),start) for x in row["release_versions"]],
    "snapshots":[sets(x,snapkeys,start) for x in row["read_snapshots"]],
    "potential_commits":[sets(x,("event","kind","start_ns","end_ns"),start) for x in cause["commits"]],
    "fingerprint_check":row["fingerprint_validation"],"read_release":[sets(x,("waiting_started_ns","finished_ns","end"),start)
                       for x in row["native"] if x["kind"]=="release_audit"],
    "read_release_emitted_payload_or_committed_manifest":not row["audit_manifest_or_no_payload"],
    "clinical_writer_target_off_page":row.get("writer_object_outside_page") if category=="medical" else None}
 assert r["code"]=="PATIENT_QUERY_CHANGED"
 return r
p=argparse.ArgumentParser(); p.add_argument('raw',type=Path); args=p.parse_args()
outputs={cat:one(args.raw/n,cat) for cat,n in (
 ("technical_read_audit","explore-00-A.json"),("medical","explore-04-B1.json"))}
print(json.dumps(outputs,indent=2))
