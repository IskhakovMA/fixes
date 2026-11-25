"""Recount two prior private shakedown receipts without copying payload or IDs."""
import collections
import hashlib
import json
from pathlib import Path
import sys

SCOPES = {"doctor": 160, "department_head": 800, "developer": 1000}


def rounded(value):
    return round(value, 3) if value is not None else None


def summarize(path, mode):
    raw = path.read_bytes()
    data = json.loads(raw)
    assert data["public"]["sessions"] == mode
    rows = data["privateRows"]["measurement"]
    registry = [row for row in rows if row["kind"] == "registry"]
    writes = [row["requests"][0] for row in rows if row["kind"] == "patch"
              and row.get("ui", {}).get("versionConfirmed")]
    assert len(registry) == len({r["id"] for r in registry}) == 60 and len(writes) == 10
    cases = []
    role_counts = collections.defaultdict(collections.Counter)
    for row in registry:
        first = row["requests"][0] if row["requests"] else {}
        count = role_counts[row["role"]]
        count["offered"] += 1
        count["firstTimely200"] += row["outcome"] == "timely_200"
        count["completedUi"] += bool(row.get("ui", {}).get("valid"))
        count["busy"] += row["outcome"] == "client_busy"
        count["first409"] += first.get("status") == 409
        if first.get("status") != 409:
            continue
        second = row["requests"][1]
        end = row["uiReadyMs"]
        recovery = row["recovery"]["valid"]
        assert len(row["requests"]) == 2
        nearest = min(writes, key=lambda w: abs(w["responseMs"] - first["dispatchMs"]))
        potentially_overlapping = sum(
            w["dispatchMs"] <= first["responseMs"] and w["responseMs"] >= first["dispatchMs"]
            for w in writes
        )
        cases.append(dict(
            role=row["role"], scope=SCOPES[row["role"]], filterAction=row.get("variant"),
            activeFilter=None, initialPageIndex=None, initialCursor=bool(first.get("cursor")),
            firstDispatchMs=rounded(first["dispatchMs"]), firstResponseMs=rounded(first["responseMs"]),
            clinicalCommitExactMs=None,
            nearestClinicalPatchDispatchRelativeToFirstGetMs=rounded(nearest["dispatchMs"] - first["dispatchMs"]),
            nearestClinicalPatchResponseRelativeToFirstGetMs=rounded(nearest["responseMs"] - first["dispatchMs"]),
            overlappingClinicalPatchHttpIntervals=potentially_overlapping,
            firstHttp=409, code=first["code"], retryCount=1, secondHttp=second["status"],
            secondCode=second.get("code"), finalState=row["ui"].get("state"),
            finalOffset=row["ui"].get("offset"), readyUiMsFromOffered=rounded(end - row["offeredMs"]) if recovery else None,
            cause="UNKNOWN",
        ))
    return dict(
        sessions=mode, privateReceiptSha256=hashlib.sha256(raw).hexdigest(),
        byRole=role_counts, offered=60, firstTimely200=sum(r["outcome"] == "timely_200" for r in registry),
        completedUi=sum(bool(r.get("ui", {}).get("valid")) for r in registry),
        first409=len(cases), recovered=sum(c["secondHttp"] == 200 and c["readyUiMsFromOffered"] is not None for c in cases),
        terminal=sum(c["secondHttp"] == 409 for c in cases), cases=cases,
    )


if __name__ == "__main__":
    runs = [summarize(Path(path), mode) for path, mode in zip(sys.argv[1:], (4, 8), strict=True)]
    print(json.dumps({"runs": runs, "causeCounts": {"confirmedClinical": 0, "confirmedTechnical": 0,
                                                   "unknown": 20, "diagnosticErrorInFinalRuns": 0}}, indent=2))
