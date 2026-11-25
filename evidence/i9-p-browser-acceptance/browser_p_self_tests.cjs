'use strict';

const assert = require('node:assert/strict');
const { buildSchedule, classify, codeForResponse, quantiles } = require('./browser_p_schedule.cjs');

const tests = [];

function check(name, run) {
    run();
    tests.push({ name, status: 'PASS' });
}

check('complete deterministic schedule for each confirmation block', () => {
    for (let block = 1; block <= 12; block++) {
        const slots = buildSchedule(300, block);
        assert.deepEqual(slots, buildSchedule(300, block));
        assert.equal(new Set(slots.map(slot => slot.id)).size, slots.length);
        for (const [kind, expected] of Object.entries({ registry: 900, patch: 150, card: 150, workspace: 60, consilium: 15 })) {
            assert.equal(slots.filter(slot => slot.kind === kind).length, expected);
        }
        for (const [role, expected] of Object.entries({ doctor: 360, department_head: 360, developer: 180 })) {
            assert.equal(slots.filter(slot => slot.role === role).length, expected);
        }
        assert(slots.every(slot => slot.dueMs >= 0 && slot.dueMs < 300000));
        assert(slots.every((slot, i) => !i || slot.dueMs >= slots[i - 1].dueMs));
    }
});

check('first HTTP outcome survives successful UI recovery', () => {
    const failure = { status: 409, code: 'PATIENT_QUERY_CHANGED' };
    assert.equal(classify(failure, { valid: true }, 10, 0), 'http_409:PATIENT_QUERY_CHANGED');
    assert.equal(classify({ status: 409, code: 'ACCESS_CONTEXT_CHANGED' }, { valid: true }, 10, 0), 'http_409:ACCESS_CONTEXT_CHANGED');
    assert.equal(classify({ status: 503 }, null, 0, 0), 'http_503');
});

check('HTTP 200 does not certify DOM, dispatch, timeout or deadline', () => {
    assert.equal(classify(null, true, 0, 0), 'no_dispatch');
    assert.equal(classify({}, null, 0, 0), 'timeout');
    assert.equal(classify({ failed: true }, null, 0, 0), 'transport_error');
    assert.equal(classify({ status: 200 }, { valid: false }, 2, 0), 'http_200_without_valid_ui');
    assert.equal(classify({ status: 200 }, { valid: true }, 2000, 0), 'timely_200');
    assert.equal(classify({ status: 200 }, { valid: true }, 2001, 0), 'late_200');
});

check('bounded code projection and finite-sample descriptive quantiles', () => {
    assert.equal(codeForResponse(409, { detail: { code: 'ACCESS_CONTEXT_CHANGED' } }), 'ACCESS_CONTEXT_CHANGED');
    assert.equal(codeForResponse(409, { code: 'potential private detail' }), undefined);
    assert.deepEqual(quantiles([]), { n: 0, p50: null, p95: null });
    assert.deepEqual(quantiles([100, 1, 2, 5]), { n: 4, p50: 2, p95: 100 });
});

process.stdout.write(JSON.stringify({ tests, passed: tests.length }, null, 2) + '\n');
