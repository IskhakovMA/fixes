"""Reproducible exact A/B1 ASGI load profiles, without modifying the product."""
from collections import Counter
from fractions import Fraction
from hashlib import sha256
from pathlib import Path
import argparse
import json
import os
import subprocess
import sys
import time

os.umask(0o077)
base = Path(__file__).resolve().parent
sys.path.insert(0,str(base / "harness"))
from schedule_open import timeline

A="f849b2909c2d23923e0ce996f0aca4b670ca9c18"
B1="3a0cb5db434032b3f7b6370c305c558a4b5d331c"
worker=base/"harness/instrumented_worker.py"
write_recipe="two developer writer sessions change age 46/47 on two distinct synthetic cards at the end of the reader scope; both sessions are offered simultaneous pairs of writes"
def digest(data):
 return sha256(data).hexdigest()

def rows_for(cell, index):
 readers, seconds, get_total, patch_rate, count, role = [cell[k] for k in ('readers','seconds','get_total_hz','patch_hz','count','role')]
 get_per_session=Fraction(get_total)/readers
 events=timeline(seconds, readers, get_per_session, Fraction(patch_rate))
 schedule_hash=digest((json.dumps(events,separators=(",",":"))+"\n").encode())
 slots=dict(Counter(e[1] for e in events))
 order=("A","B1") if index%2==0 else ("B1","A")
 for arm in order:
  tree,sha=arms[arm]
  yield cell|dict(arm=arm,sha=sha,order="–".join(order),repo=str(tree),name=f'{cell["cell"]}-{arm}',
                  get_hz_per_session=str(get_per_session),offered=slots,slots_sha256=schedule_hash)

def exploration(mode):
 cells=[]
 if mode=="explore":
  profiles=[("6","6.1")]
  for get,patch in profiles:
   for role in ("developer","head"):
    cells.append((10000,role,4,5,get,patch))
 elif mode=="adaptive":
  profiles=[("3","1"),("3","3"),("3","6.1")]
  for get,patch in profiles:
   for role in ("developer","head"):
    cells.append((10000,role,4,5,get,patch))
 elif mode=="phase":
  for count in (100,1000):
   for role in ("developer","head","doctor"):
    cells.append((count,role,1,2,"3","0"))
 return [dict(cell=f"{mode}-{i:02}",count=c,role=r,readers=n,seconds=s,get_total_hz=g,patch_hz=p)
         for i,(c,r,n,s,g,p) in enumerate(cells)]

def make_plan(args):
 cells=exploration(args.mode) if args.mode!="confirm" else json.loads(args.selected.read_text())["cells"]
 active={"mode":args.mode,"execution":"serial in-process ASGI, fresh synthetic v33 per arm, one offered slot per session; no automatic retry",
         "write_recipe":write_recipe,"stop":"stop on source/schedule/receipt/audit/scope/medical commit or response mismatch",
         "invalid_block":"exclude entire pair only for provenance, schedule, instrumentation/integrity or environmental timeout outside measured outcomes; preserve rejected receipts",
         "source_hashes":{p.name:digest(p.read_bytes()) for p in (Path(__file__),fixture,*sorted((base/'harness').glob("*.py")))},
         "arms":[a for i,cell in enumerate(cells) for a in rows_for(cell,i)]}
 if args.mode=="confirm":
  active["selection_receipt"]=json.loads(args.selected.read_text())
  active["selection_receipt_sha256"]=digest(args.selected.read_bytes())
 return active

def run(args):
 global arms, fixture
 arms={"A":(args.base.resolve(),A),"B1":(args.candidate.resolve(),B1)}
 fixture=arms["A"][0]/"tools/tests/wp_h/server.py"
 out=args.out
 out.mkdir(exist_ok=False)
 plan=make_plan(args)
 plan_path=out/'PLAN.json'; plan_path.write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n')
 (out/'PLAN.sha256').write_text(digest(plan_path.read_bytes())+'\n')
 print("plan", args.mode, digest(plan_path.read_bytes()),len(plan['arms']),flush=True)
 raw=out/'raw';raw.mkdir()
 private=out/'private';private.mkdir()
 index=out/'INDEX.jsonl'
 with index.open('x') as stream:
  for action in plan['arms']:
   name=action['name']
   receipt=raw/f'{name}.json'
   cmd=[sys.executable,'-I','-B',str(worker),'worker','--worktree',action['repo'],'--sha',action['sha'],
        '--fixture',str(fixture),'--count',str(action['count']),'--role',action['role'],'--sessions',str(action['readers']),
        '--warmup','2','--waves','0','--clinical-writer','--open-seconds',str(action['seconds']),
        '--get-hz',action['get_hz_per_session'],'--patch-hz',action['patch_hz'],'--out',str(receipt)]
   start=time.monotonic_ns()
   with (private/(name+'.log')).open('x') as log:
    process=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT,env={"PATH":os.defpath,"CLINIC_I9_CHILD":"1"},timeout=240)
   result={"name":name,"exit":process.returncode,"elapsed_ns":time.monotonic_ns()-start}
   try:
    assert process.returncode==0
    data=receipt.read_bytes(); run=json.loads(data); result['sha256']=digest(data)
    body=run['open_loop']
    assert run['sha']==action['sha'] and run['synthetic_only'] and run['role']==action['role'] and run['count']==action['count']
    assert body['read_audit_manifest_verified'] and body['clinical_version_age_audit_verified'] and not body['clinical_chain_uncertain']
    events=body['events']
    slots=[(e['scheduled_ns'],e['method'],e['slot'],e['method_index']) for e in events]
    assert digest((json.dumps(slots,separators=(",",":"))+"\n").encode())==action['slots_sha256']
    result['outcomes']={m:dict(Counter(str(e['status']) for e in events if e['method']==m)) for m in ('GET','PATCH')}
   except (AssertionError,OSError,KeyError,ValueError):
    result['verification_failure']=True
    stream.write(json.dumps(result)+'\n')
    print(json.dumps(result),flush=True)
    raise
   stream.write(json.dumps(result)+'\n');stream.flush()
   print(json.dumps(result),flush=True)

if __name__=='__main__':
 p=argparse.ArgumentParser()
 p.add_argument('mode',choices=('explore','adaptive','phase','confirm'))
 p.add_argument('out',type=Path)
 p.add_argument('--base',type=Path,required=True)
 p.add_argument('--candidate',type=Path,required=True)
 p.add_argument('--selected',type=Path)
 run(p.parse_args())
