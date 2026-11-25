'use strict';

const assert = require('node:assert/strict');
const profile = require('./profile.json');

function randomGenerator(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 2 ** 32;
    };
}

function buildSchedule(seconds, block, seed = profile.seed) {
    assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= 300);
    assert(Number.isInteger(block) && block >= 1 && block <= 12);
    const random = randomGenerator(seed + block);
    const offered = [];
    const add = (kind, rate, offset, assign) => {
        for (let index = 0; index < Math.ceil(seconds * rate); index++) {
            const dueMs = offset(index);
            if (dueMs < seconds * 1000) {
                offered.push({ id: kind + ':' + index, kind, index, dueMs, ...assign(index) });
            }
        }
    };
    add('registry', profile.registryRate,
        i => (i + 0.5) * 1000 / profile.registryRate + (2 * random() - 1) * profile.registryJitterMs,
        i => ({ role: profile.registryRoleCycle[i % profile.registryRoleCycle.length] }));
    add('patch', profile.patchRate, i => i * 2000 + 250 + 125 * (block - 1), () => ({}));
    add('card', profile.cardRate, i => i * 2000 + 875, () => ({}));
    add('workspace', profile.workspaceRate, i => i * 5000 + 1375, () => ({}));
    add('consilium', profile.consiliumRate, i => i * 20000 + 2375, () => ({}));
    return offered.sort((a, b) => a.dueMs - b.dueMs || a.id.localeCompare(b.id));
}

function quantiles(values) {
    if (!values.length) return { n: 0, p50: null, p95: null };
    const sorted = values.slice().sort((a, b) => a - b);
    const nearest = p => sorted[Math.ceil(sorted.length * p) - 1];
    return { n: sorted.length, p50: nearest(0.5), p95: nearest(0.95) };
}

function codeForResponse(status, body) {
    if (status < 400) return undefined;
    const code = body?.code ?? body?.detail?.code;
    if (typeof code !== 'string' || !/^[A-Z_]{3,70}$/.test(code)) return undefined;
    return code;
}

function classify(first, ui, completed, due, deadline = profile.timelyDeadlineMs) {
    if (!first) return 'no_dispatch';
    if (first.status === undefined || first.status === null) {
        return first.failed ? 'transport_error' : 'timeout';
    }
    if (first.status === 409) return first.code ? 'http_409:' + first.code : 'http_409:UNCLASSIFIED';
    if (first.status === 503) return 'http_503';
    if (first.status !== 200) return 'http_' + first.status;
    if (!ui?.valid) return 'http_200_without_valid_ui';
    return completed - due <= deadline ? 'timely_200' : 'late_200';
}

module.exports = { buildSchedule, quantiles, classify, codeForResponse };
