"""Verify and aggregate safe synthetic benchmark receipts without raw paths or data."""
from collections import Counter, defaultdict
from hashlib import sha256
from math import ceil
from pathlib import Path
from statistics import mean,median
import argparse
import json

def digest(v):
 return sha256(v).hexdigest()

def measure(values):
 s=sorted(k/1e6 for k in values if k is not None and k>=0)
 return None if not len(s) else {"n":len(s),"p50_ms":round(median(s),3),"p95_ms":round(s[ceil(.95*len(s))-1],3)}

def intervals(events,key,begin,end,cond=lambda _:True):
 return measure([p[end]-p[begin] for e in events for p in e.get(key,[]) if cond(p) and begin in p and end in p])

def selected_events(events,status):
 return [e for e in events if e["status"]==status]

def classify_method(events, start, cutoff):
 delivered=[e for e in events if e["dispatch_ns"] is not None]
 count=Counter()
 disjoint=Counter()
 codes=Counter()
 during, drain, native_order_errors=0,0,0
 for e in events:
  s=e["status"]
  if isinstance(s,int):
   if s==200:
    outcome='http_200'
   elif s==409:
    outcome='http_409'
    codes[e.get("conflict_code","possibly_clinical_or_unknown")]+=1
   elif 500<=s<600: outcome='http_5xx'
   elif 400<=s<500: outcome='http_4xx_other'
   else: outcome='other_http'
   during+=e["completion_ns"]<=cutoff
   drain+=e["completion_ns"]>cutoff
  else:
   outcome=s
  count[outcome]+=1
  if isinstance(s,int):
   lifecycle="after_cutoff" if e["completion_ns"]>cutoff else "inside_window"
   disjoint[lifecycle+"_"+outcome]+=1
  else:
   disjoint[outcome]+=1
  if s==200:
   typ="clinical_write" if e["method"]=="PATCH" else "release_audit"
   committed=[n for n in e["native"] if n["kind"]==typ and n["end"]=="COMMIT"]
   if len(committed)!=1 or committed[0]["finished_ns"]>e["asgi_response_start_ns"]:
    native_order_errors+=1
 assert not native_order_errors
 assert sum(count.values())==sum(disjoint.values())==len(events)
 clinical_commits=[n for e in selected_events(events,200) for n in e.get("native",[]) if n["kind"]=="clinical_write" and n["end"]=="COMMIT"]
 phases={
  "dispatch_drift":measure([e["dispatch_ns"]-e["scheduled_ns"] for e in delivered]),
  "dispatch_to_completion":measure([e["completion_ns"]-e["dispatch_ns"] for e in delivered]),
  "true_200_dispatch_to_completion":measure([e["completion_ns"]-e["dispatch_ns"] for e in selected_events(events,200)]),
  "sampled_original_snapshot":intervals(delivered,"read_snapshots","enter_ns","end_ns",lambda p:p["phase"]=="original"),
  "sampled_validation_snapshot":intervals(delivered,"read_snapshots","enter_ns","end_ns",lambda p:p["phase"]=="validation"),
  "original_fingerprint_build":intervals(delivered,"fingerprint_build","start_ns","end_ns",lambda p:p["phase"]=="original"),
  "validation_fingerprint_build":intervals(delivered,"fingerprint_build","start_ns","end_ns",lambda p:p["phase"]=="validation"),
  "ordered_release_wait":measure([n["wait"] for e in delivered for n in e.get("release_order_ns",[])]),
  "sqlite_release_begin_wait":measure([n["wait_ns"] for e in delivered for n in e.get("native",[]) if n["kind"]=="release_audit"]),
  "release_admission_wall":measure([n for e in delivered for n in e.get("phase_timing",{}).get("require_release_admission",{}).get("wall_ns",[])]),
  "check_data_version":intervals(delivered,"release_versions","start_ns","end_ns"),
  "fresh_reader":intervals(delivered,"fresh_reader","start_ns","end_ns"),
  "persist_wall":intervals(delivered,"release_persist","start_ns","end_ns"),
  "release_write_hold_through_commit_or_rollback":measure([n["hold_ns"] for e in delivered for n in e.get("native",[]) if n["kind"]=="release_audit" and "hold_ns" in n]),
  "release_native_commit":measure([n["commit_ns"] for e in delivered for n in e.get("native",[]) if n["kind"]=="release_audit" and "commit_ns" in n]),
  "http_body_to_client_completion":measure([e["completion_ns"]+start-e["asgi_response_body_end_ns"] for e in delivered if "asgi_response_body_end_ns" in e]),
  "original_first_read_to_validation_first_read":measure([
   snap["validation"]["first_read_start_ns"]-snap["original"]["first_read_execute_done_ns"] for e in delivered
   if {"validation","original"}<=(snap:={x["phase"]:x for x in e.get("read_snapshots",[])}).keys()
   and "first_read_start_ns" in snap["validation"] and "first_read_execute_done_ns" in snap["original"]]),
 }
 return {"offered":len(events),"dispatched":len(delivered),"within_window_http":during,"drained_http":drain,
         "success_200_after_cutoff":sum(e["completion_ns"]>cutoff for e in selected_events(events,200)),
         "outcomes":dict(count),"disjoint_offered_outcomes":dict(disjoint),"http_409_codes":dict(codes),
         "synthetic_conflict_causes":dict(Counter(e.get("conflict_explanation",{}).get("category","unclassified") for e in selected_events(events,409))),
         "confirmed_clinical_commit_offsets_ms":[round((n["finished_ns"]-start)/1e6,3) for n in clinical_commits],
         "sql_operator_p50":median(sql) if (sql:=[e["sql"] for e in delivered if "sql" in e]) else None,
         "phases":phases}

def verify_dir(path):
 plan_bytes=(path/"PLAN.json").read_bytes()
 assert digest(plan_bytes)==(path/"PLAN.sha256").read_text().strip()
 plan=json.loads(plan_bytes)
 index=[json.loads(t) for t in (path/"INDEX.jsonl").read_text().splitlines()]
 assert len(plan["arms"])==len(index)
 results=[]
 for registered,entry in zip(plan["arms"],index,strict=True):
  assert not entry["exit"] and entry["name"]==registered["name"]
  raw=(path/"raw"/f'{entry["name"]}.json').read_bytes()
  assert digest(raw)==entry["sha256"]
  info=json.loads(raw)
  assert info["synthetic_only"] and (registered["sha"],registered["count"],registered["role"])==(info["sha"],info["count"],info["role"])
  outcome=info["open_loop"]; events=outcome["events"]
  assert outcome["read_audit_manifest_verified"] and outcome["clinical_version_age_audit_verified"] and not outcome["clinical_chain_uncertain"]
  arrival_schedule=[(e["scheduled_ns"],e["method"],e["slot"],e["method_index"]) for e in events]
  assert digest((json.dumps(arrival_schedule,separators=(",",":"))+"\n").encode())==registered["slots_sha256"]
  methods={m:classify_method([e for e in events if e["method"]==m],outcome["start_monotonic_ns"],registered["seconds"]*10**9)
           for m in ("GET","PATCH")}
  for m,d in methods.items():
   assert d["offered"]==registered["offered"].get(m,0)
   assert d["offered"]==sum(d["outcomes"].values())
  assert len(methods["PATCH"]["confirmed_clinical_commit_offsets_ms"])==outcome["actual_clinical_changes"]==outcome["clinical_audit_events"]
  invalid=[e for e in events if e["method"]=="GET" and e["status"]==409]
  assert all(e["audit_manifest_or_no_payload"] and not any(n.get("manifest_rows_changed",0) for n in e["native"]) for e in invalid)
  assert all([n["end"] for n in e["native"] if n["kind"]=="release_audit"]==["ROLLBACK"] for e in invalid)
  safe_input={k:v for k,v in registered.items() if k!="repo"}
  results.append({"profile":safe_input,"receipt_sha256":entry["sha256"],"methods":methods,
                  "writer_commits_by_session":outcome.get("writer_commits_per_slot"),
                  "warmup_outcomes":Counter(map(str,outcome["warmup_outcomes"])),
                  "get_409_with_medical_commit_and_writer_outside_page":sum(e.get("writer_object_outside_page") is True
                    and e.get("conflict_explanation",{}).get("category")=="medical" for e in invalid)})
 return {"plan_sha256":digest(plan_bytes),"mode":plan["mode"],"arm_count":len(results),"arms":results}

if __name__=="__main__":
 p=argparse.ArgumentParser();p.add_argument("root",type=Path)
 print(json.dumps(verify_dir(p.parse_args().root),indent=2,ensure_ascii=False))
