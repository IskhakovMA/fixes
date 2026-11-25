"""Produce disjoint cohort counts and independent-writer overlap from retained verified synthetic receipts."""
import argparse,json
from collections import Counter
from hashlib import sha256
from pathlib import Path

def checksum(data):
 return sha256(data).hexdigest()

def summary(root):
 index=[json.loads(line) for line in (root/'INDEX.jsonl').read_text().splitlines()]
 plan=json.loads((root/'PLAN.json').read_text())
 assert len(index)==len(plan["arms"])
 groups=[]
 for item,cell in zip(index,plan["arms"],strict=True):
  raw=(root/"raw"/(item['name']+'.json')).read_bytes()
  assert checksum(raw)==item["sha256"] and not item["exit"]
  assert cell["name"]==item["name"]
  source=json.loads(raw)
  assert (source["sha"],source["role"],source["count"])==(cell["sha"],cell["role"],cell["count"])
  data=source["open_loop"]; start=data["start_monotonic_ns"]
  assert data["read_audit_manifest_verified"] and data["clinical_version_age_audit_verified"] and not data["clinical_chain_uncertain"]
  elapsed=data["duration_seconds"]
  assert elapsed in (5,30)
  cohorts=Counter()
  for row in data['events']:
   c=str(row["scheduled_ns"]//10_000_000_000 + 1)
   result=row["status"]
   if isinstance(result,int):
    drain=row["completion_ns"]>elapsed*1_000_000_000
    result=f'{"drained" if drain else "inside"}_http_{result}'
   cohorts[row["method"],c,result]+=1
  payload={"receipt_sha256":item["sha256"],"cell":cell["cell"],"arm":cell["arm"],
           "non_inferential_offer_cohorts":[{"method":m,"ten_second_cohort":w,"status":s,"count":n} for (m,w,s),n in sorted(cohorts.items())]}
  if data.get("writer_commits_per_slot") is not None:
   writes=[x for x in data["events"] if x["method"]=="PATCH" and x["status"]==200]
   assert len(writes)==sum(data["writer_commits_per_slot"])
   spans=[(x["dispatch_ns"],x["completion_ns"],x["slot"],x["native"]) for x in writes]
   assert set(x[2] for x in spans)=={0,1}
   overlaps=[(a,b) for a in spans if a[2]==0 for b in spans if b[2]==1 and a[0]<b[1] and b[0]<a[1]]
   tx=[t for _,_,slot,local in spans for t in local if t["kind"]=="clinical_write" and t["end"]=="COMMIT"]
   assert len(tx)==len(writes)
   intervals=sorted((t["finished_ns"]-t["hold_ns"],t["finished_ns"]) for t in tx)
   payload |= {"writer_patch_request_overlaps":len(overlaps),"writer_slots":data["writer_commits_per_slot"],
               "native_observation_overlap_ns":[l[1]-r[0] for l,r in zip(intervals,intervals[1:]) if l[1]>r[0]]}
  groups.append(payload)
 return {"phase":"relative-to-offered-window; not additional statistical replicates","arms":groups}

if __name__=="__main__":
 p=argparse.ArgumentParser()
 p.add_argument("root",type=Path)
 print(json.dumps(summary(p.parse_args().root),ensure_ascii=False,indent=2))
