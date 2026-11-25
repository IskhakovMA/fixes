'use strict';

// Independent reconciliation of the driver receipt against the fixed slot
// schedule. The output consists only of checks and counts; keep input private.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const profile = require('./profile.json');
const { buildSchedule, classify } = require('./browser_p_schedule.cjs');

const receipt = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const report = receipt.public;
const concerns = [];
let total = 0;
let safeDigests = 0;

function requireFact(fact, concern, kind) {
    if (!fact) concerns.push({ concern, kind });
}

assert.equal(report.exactProductSha, profile.productSha);
assert(profile.sessions.includes(report.sessions));
for (const phaseName of ['warmup', 'measurement']) {
    const phase = report[phaseName];
    if (!phase) continue;
    const scheduled = buildSchedule(phase.seconds, report.block);
    const rows = receipt.privateRows[phaseName];
    assert.equal(rows.length, scheduled.length);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
    total += rows.length;
    const counts = {};
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const slot = scheduled[i];
        const first = row.requests[0];
        assert.equal(row.id, slot.id);
        assert.equal(row.offeredMs, slot.dueMs);
        assert.equal(row.kind, slot.kind);
        if (slot.kind === 'registry') assert.equal(row.role, slot.role);
        assert(row.outcome);
        assert(row.requests.every((r, index) => !index || r.dispatchMs >= row.requests[index - 1].dispatchMs));
        if (first) {
            requireFact(Number.isFinite(row.actionStartedMs) && first.dispatchMs + 0.01 >= row.actionStartedMs, 'request_preceded_action', row.kind);
        }
        if (row.outcome === 'client_busy') {
            assert(!first && row.actionStartedMs === undefined);
        } else if (first?.status) {
            requireFact(row.outcome === classify(first, row.ui, row.uiReadyMs, row.offeredMs),
                'known_http_outcome_disagrees', row.kind);
        }
        if (row.outcome === 'timely_200' || row.outcome === 'late_200') {
            requireFact(row.ui?.valid && Number.isFinite(row.uiReadyMs) && first.status === 200, 'missing_ui_or_http', row.kind);
        }
        if (row.kind === 'registry' && row.recovery?.valid) {
            requireFact(row.outcome === 'http_409:PATIENT_QUERY_CHANGED' && row.requests.length === 2
                && row.requests[1].status === 200 && row.ui?.valid && row.recovery.msFrom409 >= 0,
                'false_positive_recovery', row.kind);
        }
        requireFact(row.kind === 'patch' ? row.writeRequests <= 1 : row.writeRequests === 0, 'unattributed_write', row.kind);
        for (const request of row.requests.filter(response => response.status === 200)) {
            if (row.kind !== 'patch') safeDigests++;
            requireFact(/^[0-9a-f]{64}$/.test(request.bodyDigest || ''), 'missing_body_digest', row.kind);
        }
        const kind = counts[row.kind] ??= { offered: 0, dispatched: 0, requests: 0, outcomes: {} };
        kind.offered++;
        if (first) kind.dispatched++;
        kind.requests += row.requests.length;
        kind.outcomes[row.outcome] = (kind.outcomes[row.outcome] || 0) + 1;
    }
    for (const [name, kind] of Object.entries(counts)) {
        const published = phase.summary[name];
        assert.equal(published.offered, kind.offered);
        assert.equal(published.dispatchedActions, kind.dispatched);
        assert.equal(published.actualMatchingRequests, kind.requests);
        assert.deepEqual(published.outcomes, kind.outcomes);
    }
}
requireFact(receipt.releaseDigests.length === safeDigests, 'release_digest_coverage_mismatch', 'all_reads');
requireFact(total > 0, 'empty_driver_receipt', 'all');
requireFact(report.browserClosed, 'browser_lifecycle_not_closed', 'all');

process.stdout.write(JSON.stringify({
    sessions: report.sessions, reconciledOffered: total, observedReleaseDigests: safeDigests,
    status: concerns.length ? 'FAIL' : 'PASS', concerns,
}, null, 2) + '\n');
if (concerns.length) process.exitCode = 1;
