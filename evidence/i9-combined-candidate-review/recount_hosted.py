"""Recount exact combined-candidate hosted Chromium output without copying logs."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re

CANDIDATE = "b5b408fe411f4431042eced96f0801cffb577a83"
TREE = "cd00d4d55140d377038783234cc204c602741869"
HISTORY = {
    "navigation": 6, "saving": 1, "transportAndIdentity": 3,
    "objectRevocation": 1, "unknownDraft": 2, "unknownDenial": 1,
    "unknownRace": 2,
}


def cases(folder, *suites):
    return [f"{folder}-{suite}" for suite in suites]


MATRIX = {
    **{f"history-{key}": ["wp_i_card-history"] for key in HISTORY},
    "wp-h": cases("wp-h", "browser", "drafts", "zoom"),
    "registry-card": [*cases("registry", "100", "1000", "10000"),
                      *cases("wp_i_card", "card", "errors", "clinical", "zoom")],
    "create": cases("wp_i_create", "create", "errors", "workflows", "zoom"),
    "consilium-schedule": cases("wp_i_consilium", "schedule", "workflows", "loading", "zoom"),
    "consilium-records": cases("wp_i_consilium", "decisions", "decisionzoom", "records", "recordszoom"),
    "notifications": cases("wp_i_notifications", "browser", "workflows", "retry", "zoom", "fix1", "fix2"),
    "ai": cases("wp_i_ai", "browser", "workflows", "zoom"),
    "management-audit": [*cases("wp_i_management", "browser", "workflows", "zoom"),
                         *cases("wp_i_audit_chair", "browser", "workflows", "zoom")],
    "workspace": cases("wp_i_workspace", "browser", "workflows", "zoom"),
    "quality-owner": ["quality-browser"],
    "quality-native-zoom": ["quality-browser_zoom"],
}
ALLOWED_CASES = {case for suite in MATRIX.values() for case in suite}
PATTERN = re.compile(
    r"(?:(?<= )|^)(I9_CASE=[\w-]+ (?:PASS|FAIL \d+)|I9_HISTORY_GROUPS=[A-Za-z]+ \d+/\d+|"
    r"I9_MATRIX_RECEIPT=\{[^{}]+\}|I9_WS_CHECKS=13/13)$"
)
JOB_PATTERN = re.compile(r"^synthetic-browser \(([\w-]+)\)\t")


def recount(raw, workflow):
    outcomes = {suite: [] for suite in MATRIX}
    receipts = {}
    history_counts = {}
    workspace_checks = 0
    for line in raw.decode("utf-8", errors="replace").splitlines():
        job = JOB_PATTERN.match(line)
        marker = PATTERN.search(line)
        if not job or not marker:
            continue
        suite = job.group(1)
        if suite not in MATRIX:
            raise ValueError("unknown suite")
        label, value = marker.group(1).split("=", 1)
        if label == "I9_CASE":
            command, status, *_ = value.split()
            if command not in ALLOWED_CASES:
                raise ValueError("unknown command")
            outcomes[suite].append({"name": command, "status": status})
        elif label == "I9_MATRIX_RECEIPT":
            record = json.loads(value)
            if set(record) != {"candidate", "tree", "workflow", "suite", "commands", "passed"}:
                raise ValueError("unknown receipt fields")
            if (record["suite"] != suite or record["candidate"] != CANDIDATE
                    or record["workflow"] != workflow or record["tree"] != TREE
                    or suite in receipts):
                raise ValueError("invalid, duplicate or non-exact receipt")
            if not all(type(record[x]) is int and 0 <= record[x] <= len(MATRIX[suite])
                       for x in ("commands", "passed")):
                raise ValueError("invalid receipt count")
            receipts[suite] = record
        elif label == "I9_HISTORY_GROUPS":
            scenario, pair = value.split()
            if "history-" + scenario != suite or scenario not in HISTORY or scenario in history_counts:
                raise ValueError("invalid history marker")
            actual, expected = map(int, pair.split("/"))
            if expected != HISTORY[scenario] or actual != expected:
                raise ValueError("history group disagreement")
            history_counts[scenario] = actual
        elif label == "I9_WS_CHECKS":
            if suite != "workspace":
                raise ValueError("unexpected workspace marker")
            workspace_checks += 1

    jobs = {}
    for suite, expected in MATRIX.items():
        commands = outcomes[suite]
        passed = sum(item["status"] == "PASS" for item in commands)
        correct = (Counter(item["name"] for item in commands) == Counter(expected)
                   and passed == len(expected)
                   and receipts.get(suite, {}).get("commands") == len(expected)
                   and receipts.get(suite, {}).get("passed") == len(expected))
        jobs[suite] = {"expected": len(expected), "passed": passed, "cases": commands,
                       "verified": correct}
    command_count = sum(len(expected) for expected in MATRIX.values())
    jobs_passed = sum(job["verified"] for job in jobs.values())
    commands_passed = sum(job["passed"] for job in jobs.values())
    full_pass = (jobs_passed == len(MATRIX) == 18 and commands_passed == command_count == 49
                 and history_counts == HISTORY and workspace_checks == 1)
    return {
        "status": "PASS" if full_pass else "NOT_CONFIRMED",
        "candidate": CANDIDATE,
        "tree": TREE,
        "workflow": workflow,
        "jobs": jobs,
        "jobsVerified": jobs_passed,
        "commandsPassed": commands_passed,
        "historyGroups": history_counts,
        "totalHistoryGroups": sum(history_counts.values()),
        "verifiedWorkspaceMarkers": workspace_checks,
        "rawLogSha256": hashlib.sha256(raw).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("--workflow", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.workflow):
        parser.error("expected full workflow commit SHA")
    result = recount(args.log.read_bytes(), args.workflow)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
