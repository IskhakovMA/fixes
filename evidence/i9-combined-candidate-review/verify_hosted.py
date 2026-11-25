"""Verify exact-candidate hosted data against the historical coverage set.

Input files have private access: full GitHub Actions log text and gh run view
JSON. Output contains only evidence labels, counters, and associated SHAs.
"""
import argparse
import collections
import json
import re
from pathlib import Path

CANDIDATE = 'b5b408fe411f4431042eced96f0801cffb577a83'
TREE = 'cd00d4d55140d377038783234cc204c602741869'
WORKFLOW = 'f026f1e46b914157a484131cfb24f3d72c10469e'
HISTORY_COUNTS = {'navigation': 6, 'saving': 1, 'transportAndIdentity': 3, 'objectRevocation': 1,
                  'unknownDraft': 2, 'unknownDenial': 1, 'unknownRace': 2}
SUITE = re.compile(r'^synthetic-browser \(([A-Za-z0-9_-]+)\)$')
CASE = re.compile(r'^\S+ I9_CASE=([A-Za-z0-9_-]+) (PASS|FAIL \d+)$')
MATRIX = re.compile(r'^\S+ I9_MATRIX_RECEIPT=(\{.*\})$')
HISTORY = re.compile(r'^\S+ I9_HISTORY_GROUPS=(\w+) (\d+)/(\d+)$')
WORKSPACE = re.compile(r'^\S+ I9_WS_CHECKS=(\d+)/(\d+)$')
ENV = re.compile(r'^\S+ I9_ENV=([a-f0-9]{40}) Linux x86_64 Python 3\.13\.18 node=v22\.23\.5$')


def verify(metadata, lines, expected):
    assert metadata['headSha'] == WORKFLOW and metadata['conclusion'] == 'success'
    jobs = {}
    for entry in metadata['jobs']:
        match = SUITE.fullmatch(entry['name'])
        assert match and entry['conclusion'] == 'success'
        suite = match.group(1)
        assert suite not in jobs
        jobs[suite] = entry['databaseId']
    assert jobs.keys() == expected.keys()
    commands, receipts, environments = (collections.defaultdict(list) for _ in range(3))
    history = {}
    workspace = []
    for line in lines:
        columns = line.rstrip().split('\t')
        if len(columns) < 3:
            continue
        match = SUITE.fullmatch(columns[0])
        if not match:
            continue
        suite = match.group(1)
        msg = columns[-1]
        if case := CASE.fullmatch(msg):
            assert case[2] == 'PASS'
            commands[suite].append(case[1])
        if receipt := MATRIX.fullmatch(msg):
            receipts[suite].append(json.loads(receipt[1]))
        if env := ENV.fullmatch(msg):
            environments[suite].append(env[1])
        if counts := HISTORY.fullmatch(msg):
            name, observed, configured = counts.groups()
            assert suite == f'history-{name}' and name not in history
            assert observed == configured and int(observed) == HISTORY_COUNTS[name]
            history[name] = int(observed)
        if checks := WORKSPACE.fullmatch(msg):
            assert suite == 'workspace'
            workspace.append(list(map(int, checks.groups())))
    assert commands == expected
    assert history == HISTORY_COUNTS
    assert workspace == [[13, 13]]
    for suite, labels in commands.items():
        assert environments[suite] == [CANDIDATE]
        assert receipts[suite] == [
            dict(candidate=CANDIDATE, tree=TREE, workflow=WORKFLOW, suite=suite,
                 commands=len(labels), passed=len(labels))]
    return dict(run=45688807818, candidateSha=CANDIDATE, candidateTree=TREE, workflowSha=WORKFLOW,
                passedJobs=len(jobs), passedCommands=sum(map(len, commands.values())),
                historyScenarios=len(history), historyGroups=sum(history.values()),
                workspaceCheckGroups=workspace[0][0],
                verificationJobs={key: dict(jobId=jobs[key], commands=labels)
                                  for key, labels in sorted(commands.items())})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run_json', type=Path)
    parser.add_argument('run_log', type=Path)
    parser.add_argument('baseline_json', type=Path)
    args = parser.parse_args()
    with args.run_log.open(errors='replace') as stream:
        result = verify(json.loads(args.run_json.read_bytes()), stream,
                        json.loads(args.baseline_json.read_bytes())['passedCommandsByJobSuite'])
    print(json.dumps(result, indent=2))
