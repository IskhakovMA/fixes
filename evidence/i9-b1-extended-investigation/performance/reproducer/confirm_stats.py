"""Preregistered review of complete matched confirmatory holdout blocks."""
from collections import defaultdict
from hashlib import sha256
from itertools import product
from math import ceil
from pathlib import Path
from statistics import mean
import argparse
import json

def exact_stratified(values):
 strata=[[d[k] for d in values if d['order']==k] for k in ('A–B1','B1–A')]
 assert [len(x) for x in strata]==[3,3]
 ax,bx=strata
 replicates=sorted(mean(a+b) for a in product(ax,repeat=3) for b in product(bx,repeat=3))
 coverage=[replicates[ceil(p*len(replicates))-1] for p in (.025,.975)]
 return {"pairs":6,"bootstrap_resamples":len(replicates),"paired_deltas_pp":[d[d['order']] for d in values],
         "order_means_pp":{"AB":mean(ax),"BA":mean(bx)},
         "point_pp":mean(ax+bx),"p025_p975_pp":coverage,"positive_pairs":sum(x>0 for x in ax+bx)}

def values_by_arm(arm):
 get=arm["methods"]["GET"]
 patch=arm["methods"]["PATCH"]
 assert get["offered"]==180 and patch["offered"]==30
 during=get["outcomes"].get("http_200",0)-get["success_200_after_cutoff"]
 return {"inside_200_percent":100*during/get["offered"],
         "drained_or_inside_200_percent":100*get["outcomes"].get("http_200",0)/get["offered"],
         "http_409_percent":100*get["outcomes"].get("http_409",0)/get["offered"],
         "client_busy_percent":100*get["outcomes"].get("client_busy",0)/get["offered"]}

p=argparse.ArgumentParser(); p.add_argument("path",type=Path)
args=p.parse_args()
data=args.path.read_bytes()
mat=json.loads(data); assert mat["arm_count"]==12 and mat["mode"]=="confirm"
pairs=defaultdict(dict)
for arm in mat["arms"]:
 conf=arm["profile"]; pairs[conf["cell"]][conf["arm"]]=arm
assert len(pairs)==6 and all(len(v)==2 for v in pairs.values())
differences=defaultdict(list)
others=[]
for name,both in pairs.items():
 a,b=(both[v] for v in ("A","B1"))
 assert a["profile"]["order"]==b["profile"]["order"]
 aa,bb=values_by_arm(a),values_by_arm(b)
 order=a["profile"]["order"]
 for metric in aa:
  differences[metric].append({order:bb[metric]-aa[metric],"order":order})
 other={"pair":name,"order":order,"offers_get_each":a["methods"]["GET"]["offered"],
        "commits":[len(e["methods"]["PATCH"]["confirmed_clinical_commit_offsets_ms"]) for e in (a,b)],
        "inside_200":[e["methods"]["GET"]["outcomes"].get("http_200",0)-e["methods"]["GET"]["success_200_after_cutoff"] for e in (a,b)],
        "outcomes_get":[e["methods"]["GET"]["outcomes"] for e in (a,b)],
        "p95_success_get_ms":[(e["methods"]["GET"]["phases"]["true_200_dispatch_to_completion"] or {}).get("p95_ms") for e in (a,b)]}
 others.append(other)
results={"source_sha256":sha256(data).hexdigest(),"pairs":others,
         "metrics":{m:exact_stratified(v) for m,v in differences.items()}}
print(json.dumps(results,indent=2,ensure_ascii=False))
