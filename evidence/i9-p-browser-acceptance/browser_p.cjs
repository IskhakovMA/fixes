'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');
const { parseArgs } = require('node:util');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const profile = require('./profile.json');
const { buildSchedule, classify, codeForResponse, quantiles } = require('./browser_p_schedule.cjs');

const OPTIONS = {
    fixture: { type: 'string' },
    out: { type: 'string' },
    sessions: { type: 'string' },
    seconds: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '5' },
    block: { type: 'string', default: '1' },
    confirmation: { type: 'boolean', default: false },
};
const REGISTRY = '/api/patients';
const MATCHERS = {
    registry: (method, path, url) => method === 'GET' && path === REGISTRY && url.searchParams.get('view') === 'page',
    patch: (method, path, _url, target) => method === 'PATCH' && path === target,
    card: (method, path, _url, target) => method === 'GET' && path === target,
    workspace: (method, path) => method === 'GET' && path === '/api/patients/workspace/events',
    consilium: (method, path) => method === 'GET' && path === '/api/consilium/appointments',
};

function config() {
    const argv = process.argv.slice(2);
    const options = argv[0]?.startsWith('--') ? parseArgs({ options: OPTIONS }).values : {
        fixture: argv[0], out: argv[1], sessions: argv[2], seconds: argv[3], warmup: argv[4],
        block: '1', confirmation: false,
    };
    const sessions = Number(options.sessions);
    const seconds = Number(options.seconds);
    const warmup = Number(options.warmup);
    const block = Number(options.block);
    assert(profile.sessions.includes(sessions), 'use exactly 4 or 8 sessions');
    assert(options.fixture && options.out, 'provide --fixture and --out');
    assert(Number.isInteger(block) && block >= 1 && block <= 12, 'invalid block');
    if (options.confirmation) {
        assert.equal(seconds, profile.confirmationBlockSeconds, 'invalid confirmation window');
        assert.equal(warmup, profile.confirmationWarmupSeconds, 'invalid confirmation warmup');
    } else {
        assert(Number.isInteger(seconds) && seconds >= 6 && seconds <= 40, 'shakedown window 6–40s');
        assert(Number.isInteger(warmup) && warmup >= 0 && warmup <= 15, 'shakedown warmup 0–15s');
    }
    const info = fs.lstatSync(options.fixture);
    assert(info.isFile() && (info.mode & 0o077) === 0, 'private fixture must be a local mode-0600 file');
    const fixture = JSON.parse(fs.readFileSync(options.fixture, 'utf8'));
    assert(fixture.syntheticOnly === true && fixture.count === profile.patients);
    assert.match(fixture.baseURL, /^http:\/\/127\.0\.0\.1:\d{2,5}$/);
    if (fixture.productSha !== undefined) assert.equal(fixture.productSha, profile.productSha);
    assert(Array.isArray(fixture.users) && fixture.users.length === 8);
    const roles = fixture.users.map(x => x.roleId);
    assert.deepEqual(roles, [...Array(5).fill('doctor'), 'department_head', 'developer', 'consilium_chair']);
    assert.equal(fixture.mutation.userIndex, 0);
    assert.match(fixture.mutation.path, /^\/api\/patients\/[A-Za-z0-9_-]+$/);
    assert(fixture.users.every(user => typeof (user.password ?? fixture.password) === 'string' && user.username));
    assert(fixture.hiddenPatientId);
    return { fixture, sessions, seconds, warmup, block, out: options.out, kind: options.confirmation ? 'confirmation' : 'shakedown' };
}

function observe(page, origin, global) {
    const state = { active: undefined, sent: new WeakMap() };
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== origin || !url.pathname.startsWith('/api/')) return;
        const method = request.method();
        if ((url.pathname.startsWith(REGISTRY) || url.pathname.startsWith('/api/consilium'))
            && !['GET', 'HEAD'].includes(method)) {
            const allowed = state.active?.slot.kind === 'patch' && method === 'PATCH' && url.pathname === state.active.target;
            if (!allowed) global.unexpectedMedicalWrites++;
        }
        const current = state.active;
        if (!current) return;
        const row = current.row;
        const write = !['GET', 'HEAD'].includes(method) && !url.pathname.startsWith('/api/auth/');
        if (write) row.writeRequests++;
        const primary = MATCHERS[current.slot.kind](method, url.pathname, url, current.target);
        if (!primary) {
            row.additionalHttp++;
            return;
        }
        const entry = { dispatchMs: performance.now() - current.start, status: null };
        if (current.slot.kind === 'registry') entry.cursor = url.searchParams.has('cursor');
        row.requests.push(entry);
        state.sent.set(request, { entry, originMs: current.start });
    });
    page.on('requestfailed', request => {
        const record = state.sent.get(request);
        if (record) record.entry.failed = true;
    });
    page.on('response', response => {
        const record = state.sent.get(response.request());
        if (!record) return;
        record.entry.status = response.status();
        record.entry.responseMs = performance.now() - record.originMs;
        record.entry.completion = (async () => {
            try {
                const body = await response.body();
                record.entry.bodyReadyMs = performance.now() - record.originMs;
                record.entry.bytes = body.length;
                const timing = response.request().timing();
                if (timing.startTime > 0) {
                    record.entry.chromiumStartMs = timing.startTime - (performance.timeOrigin + record.originMs);
                    if (timing.responseStart >= 0) record.entry.chromiumHeadersElapsedMs = timing.responseStart;
                    if (timing.responseEnd >= 0) record.entry.chromiumBodyElapsedMs = timing.responseEnd;
                }
                const parsed = JSON.parse(body.toString('utf8'));
                if (response.status() === 200) {
                    record.entry.bodyDigest = createHash('sha256').update(body).digest('hex');
                    return parsed;
                }
                record.entry.code = codeForResponse(response.status(), parsed);
            } catch (error) {
                record.entry.bodyUnavailable = true;
            }
            return null;
        })();
    });
    return state;
}

async function enter(browser, fixture, index, global) {
    const user = fixture.users[index];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const origin = fixture.baseURL;
    await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        global.blockedRequests++;
        return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(3500);
    page.on('pageerror', () => global.pageErrors++);
    const monitor = observe(page, origin, global);
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#username').fill(user.username);
    await page.locator('#password').fill(user.password ?? fixture.password);
    await page.locator('#loginSubmit').click();
    await page.waitForFunction(() => app.appReady && !app.sessionExpired && !app.sessionReconciling && app.patientListState === 'ready', undefined, { timeout: 12000 });
    const layout = await page.evaluate(() => ({
        role: app.user.roleId,
        total: app.patientPage.summary.total,
        rows: document.querySelectorAll('#patientsBody tr').length,
    }));
    assert.equal(layout.role, user.roleId);
    assert.equal(layout.total, user.expectTotal);
    assert.equal(layout.rows, Math.min(layout.total, 50));
    assert(Array.isArray(user.authorizedIds) && new Set(user.authorizedIds).size === user.expectTotal);
    return { user, allowed: new Set(user.authorizedIds), userIndex: index, context, page, monitor, tab: 'overview', busy: false };
}

async function preflight(client, fixture, global) {
    const { page, user } = client;
    assert.equal(user.roleId, 'doctor');
    const result = await page.evaluate(async ({ hidden, visible }) => {
        const hiddenResponse = await fetch('/api/patients/' + encodeURIComponent(hidden));
        let opened = null;
        if (visible) {
            opened = await app.openPatient(visible);
            if (opened) await app.navigateView('patients');
        }
        return { hiddenStatus: hiddenResponse.status, allowedOpen: opened };
    }, { hidden: fixture.hiddenPatientId, visible: user.patientId });
    assert.equal(result.hiddenStatus, 404, 'object denial check did not return 404');
    assert.equal(result.allowedOpen, true, 'allowed card could not be opened');
    global.actualObjectDenial404 = true;
    global.allowedCardOpen = true;
}

async function evaluateRegistry(page, row, index) {
    const action = index % 4;
    const result = await page.evaluate(async action => {
        if (app.currentView !== 'patients') {
            if (!await app.navigateView('patients')) return { variant: 'navigation_denied' };
            // Returning to the registry dispatches a real first-page read in
            // browserNavigation.render. Wait for that intent, without a second read.
            return { variant: 'first_load' };
        }
        if (app.patientListState === 'loading') return { variant: 'existing_load' };
        if (action === 1 && app.patientListState === 'ready' && app.patientPage?.page.hasNext) {
            const direction = app.pageIndex === 0 ? 1 : -1;
            await app.changePatientPage(direction);
            return { variant: direction === 1 ? 'next_page' : 'previous_page' };
        }
        if (action === 2) {
            const stage = document.getElementById('filterStage');
            stage.value = stage.value ? '' : 'exam';
            stage.dispatchEvent(new Event('change', { bubbles: true }));
            return { variant: 'filter' };
        }
        await app.reloadPatientsAndRender();
        return { variant: 'refresh' };
    }, action);
    row.variant = result.variant;
    await page.waitForFunction(() => app.patientListState !== 'loading', undefined, { timeout: 3000 });
    return page.evaluate(() => {
        const view = document.getElementById('view-patients');
        const visible = !view.classList.contains('is-hidden') &&
            !document.getElementById('patientRegistryResults').inert;
        return {
            valid: visible && app.currentView === 'patients' && app.patientListState === 'ready' && !app.sessionExpired,
            renderedNames: Array.from(document.querySelectorAll('#patientsBody .patient-open'), node => node.textContent),
            offset: app.patientPage?.page.offset,
            tab: app.currentTab,
            scopeCount: app.patientPage?.summary.total,
            state: app.patientListState,
            focused: document.activeElement?.id === 'patientPageStatus',
        };
    });
}

async function evaluateCard(page, row, id, intendedTab) {
    row.variant = intendedTab;
    return page.evaluate(async ({ key, tab }) => {
        const opened = await app.openPatient(key, tab);
        const panel = document.getElementById('patientPanels');
        const title = document.querySelector('#patientSide .pcard__name')?.textContent;
        const visible = !document.getElementById('view-patient').classList.contains('is-hidden');
        return {
            valid: opened && visible && app.currentView === 'patient' && app.currentPatientId === key
                && panel?.dataset.patientId === key && panel?.dataset.tab === tab && app.currentTab === tab
                && document.getElementById('tab-' + tab)?.getAttribute('aria-selected') === 'true',
            title, tab: app.currentTab, intendedPatient: panel?.dataset.patientId === key,
        };
    }, { key: id, tab: intendedTab });
}

async function evaluateWorkspace(page) {
    return page.evaluate(async () => {
        const already = app.currentView === 'calendar';
        if (already) await app.renderCalendar();
        else if (!await app.navigateView('calendar')) return { valid: false };
        return { valid: !app.sessionExpired, navigatePending: !already };
    });
}

async function evaluateConsilium(page) {
    return page.evaluate(async () => {
        const already = app.currentView === 'consilium';
        if (already) await app.renderConsilium();
        else if (!await app.navigateView('consilium')) return { valid: false };
        return { valid: !app.sessionExpired, navigatePending: !already };
    });
}

async function evaluatePatch(page, fixture, writer) {
    const mutation = fixture.mutation;
    const old = writer.version;
    const value = mutation.body.field === 'age' ? (writer.value === 47 ? 46 : 47) : (writer.value === 'urgent' ? 'normal' : 'urgent');
    const result = await page.evaluate(async ({ path, version, field, value }) => {
        try {
            const record = await apiPatch(path, { field, value, expectedVersion: version });
            return { valid: record.version === version + 1 && record[field] === value, version: record.version };
        } catch (err) {
            return { valid: false, rejected: Number(err.status) || null };
        }
    }, { path: mutation.path, version: old, field: mutation.body.field, value });
    if (result.valid) {
        writer.version = result.version;
        writer.value = value;
    }
    return { ...result, expectedVersion: old + 1 };
}

function pick(slot, clients, counters) {
    if (slot.kind === 'patch') return clients.writer;
    let role = slot.role;
    if (slot.kind === 'card') role = 'doctor';
    if (slot.kind === 'workspace') role = 'department_head';
    if (slot.kind === 'consilium') role = clients.readers.some(x => x.user.roleId === 'consilium_chair') ? 'consilium_chair' : 'developer';
    const users = clients.readers.filter(client => client.user.roleId === role);
    const key = slot.kind + ':' + role;
    const counter = counters[key] || 0;
    counters[key] = counter + 1;
    return users[counter % users.length];
}

async function action(slot, client, row, fixture, start) {
    const { page, monitor } = client;
    const target = slot.kind === 'card' ? REGISTRY + '/' + encodeURIComponent(client.user.patientId) : fixture.mutation.path;
    monitor.active = { slot, row, target, start };
    try {
        let ui;
        if (slot.kind === 'registry') ui = await evaluateRegistry(page, row, slot.index);
        else if (slot.kind === 'card') {
            const intended = client.tab === 'overview' ? 'history' : 'overview';
            ui = await evaluateCard(page, row, client.user.patientId, intended);
            if (ui.valid) client.tab = intended;
        } else if (slot.kind === 'workspace') {
            ui = await evaluateWorkspace(page);
            if (ui.navigatePending) await page.waitForFunction(() => !app.sessionExpired && app.currentView === 'calendar'
                && !document.getElementById('calendarPanel').hasAttribute('aria-busy'), undefined, { timeout: 3000 });
            const snapshot = await page.evaluate(() => {
                const host = document.getElementById('calendarPanel');
                const state = app.workspacePages?.events;
                return {
                    valid: !host.classList.contains('is-hidden') && app.currentView === 'calendar'
                        && state?.ready && !host.hasAttribute('aria-busy'),
                    renderedIds: [...host.querySelectorAll('[data-workspace-row]')].map(node => node.dataset.workspaceRow),
                    total: state?.page?.total,
                };
            });
            ui = { ...snapshot, valid: ui.valid && snapshot.valid };
        } else if (slot.kind === 'consilium') {
            ui = await evaluateConsilium(page);
            if (ui.navigatePending) await page.waitForFunction(() => app.consilium.readState !== 'loading', undefined, { timeout: 3000 });
            const snapshot = await page.evaluate(() => ({
                valid: app.currentView === 'consilium' && app.consilium.readState === 'ready'
                    && document.getElementById('consiliumLoadState').classList.contains('is-hidden'),
                appointmentIds: app.consilium.appointments.map(row => row.id),
            }));
            ui = { ...snapshot, valid: ui.valid && snapshot.valid };
        } else ui = await evaluatePatch(page, fixture, client);
        row.uiReadyMs = performance.now() - start;
        const first = row.requests[0];
        const latest = row.requests.at(-1);
        await Promise.all(row.requests.map(request => request.completion));
        const body = latest?.completion ? await latest.completion : null;
        if (slot.kind === 'registry') {
            const payloadMatches = Array.isArray(body?.patients) && body.page.offset === ui.offset
                && body.summary.total === client.user.expectTotal && body.summary.total === ui.scopeCount
                && body.patients.length <= 50 && body.patients.length === ui.renderedNames.length
                && body.patients.every((p, i) => p.name === ui.renderedNames[i] && client.allowed.has(p.id))
                && (first?.status !== 200 || row.variant !== 'next_page' || ui.offset === 50)
                && (first?.status !== 200 || row.variant !== 'previous_page' || ui.offset === 0);
            row.ui = { valid: Boolean(ui.valid && payloadMatches), state: ui.state, offset: ui.offset, focus: ui.focused };
            if (first?.status === 409 && first.code === 'PATIENT_QUERY_CHANGED') {
                row.recovery = {
                    valid: row.requests.length === 2 && latest.status === 200 && row.ui.valid && ui.offset === 0 && row.writeRequests === 0,
                    reads: row.requests.length,
                    msFrom409: row.uiReadyMs - first.responseMs,
                };
            }
        } else if (slot.kind === 'card') {
            row.ui = { valid: Boolean(ui.valid && body?.id === client.user.patientId && client.allowed.has(body.id) && body?.name === ui.title), tab: ui.tab, intendedPatient: ui.intendedPatient };
        } else if (slot.kind === 'patch') {
            row.ui = { valid: Boolean(ui.valid && body?.version === ui.expectedVersion), versionConfirmed: Boolean(ui.valid && body?.version === ui.expectedVersion) };
        } else if (slot.kind === 'workspace') {
            const events = body?.events;
            row.ui = { valid: Boolean(ui.valid && Array.isArray(events) && ui.total === body.page?.total
                && events.length === ui.renderedIds.length
                && events.every((event, index) => event.id === ui.renderedIds[index] && client.allowed.has(event.patientId))) };
        } else {
            const appointments = body?.appointments;
            row.ui = { valid: Boolean(ui.valid && Array.isArray(appointments) && appointments.length === ui.appointmentIds.length
                && appointments.every((item, index) => item.id === ui.appointmentIds[index])) };
        }
        row.outcome = classify(first, row.ui, row.uiReadyMs, slot.dueMs);
    } catch (error) {
        const first = row.requests[0];
        if (first?.completion) await first.completion;
        row.error = error.name === 'TimeoutError' ? 'ui_timeout' : 'browser_action_error';
        row.outcome = row.error === 'ui_timeout' && !first ? 'timeout' : classify(first, { valid: false }, 0, slot.dueMs);
    } finally {
        monitor.active = undefined;
    }
}

function summarize(rows) {
    const byKind = {};
    for (const kind of Object.keys(MATCHERS)) {
        const group = rows.filter(row => row.kind === kind);
        const dispatches = group.flatMap(row => row.requests);
        const count = predicate => group.filter(predicate).length;
        const outcomes = {};
        const firstHttp = {};
        for (const row of group) {
            outcomes[row.outcome] = (outcomes[row.outcome] || 0) + 1;
            const response = row.requests[0];
            if (response?.status) {
                const key = response.status === 409 ? '409:' + (response.code || 'UNCLASSIFIED') : String(response.status);
                firstHttp[key] = (firstHttp[key] || 0) + 1;
            }
        }
        byKind[kind] = {
            offered: group.length,
            dispatchedActions: count(row => row.requests.length !== 0),
            actualMatchingRequests: dispatches.length,
            additionalHttpRequests: group.reduce((sum, row) => sum + row.additionalHttp, 0),
            outcomes, firstHttp,
            httpMs: quantiles(dispatches.filter(row => row.responseMs !== undefined).map(row => row.responseMs - row.dispatchMs)),
            httpBodyMs: quantiles(dispatches.filter(row => row.bodyReadyMs !== undefined).map(row => row.bodyReadyMs - row.dispatchMs)),
            chromiumBodyMs: quantiles(dispatches.filter(row => row.chromiumBodyElapsedMs !== undefined).map(row => row.chromiumBodyElapsedMs)),
            validUiMsFromOffered: quantiles(group.filter(row => row.ui?.valid).map(row => row.uiReadyMs - row.offeredMs)),
            validUiMsFromAction: quantiles(group.filter(row => row.ui?.valid).map(row => row.uiReadyMs - row.actionStartedMs)),
        };
    }
    return byKind;
}

async function phase(clients, fixture, seconds, block, warmup) {
    const schedule = buildSchedule(seconds, block);
    const rows = [];
    const counters = {};
    const tasks = new Set();
    const start = performance.now();
    let missedWrites = false;
    for (const slot of schedule) {
        const delay = start + slot.dueMs - performance.now();
        if (delay > 0) await pause(delay);
        const client = pick(slot, clients, counters);
        const current = performance.now() - start;
        const row = { id: slot.id, kind: slot.kind, role: client.user.roleId, userIndex: client.userIndex, offeredMs: slot.dueMs,
            schedulerMs: current, requests: [], writeRequests: 0, additionalHttp: 0 };
        rows.push(row);
        if (client.busy) {
            row.outcome = 'client_busy';
            continue;
        }
        if (slot.kind === 'patch' && missedWrites) {
            row.outcome = 'blocked_after_unverified_commit';
            continue;
        }
        client.busy = true;
        row.actionStartedMs = performance.now() - start;
        const executed = action(slot, client, row, fixture, start).finally(() => {
            client.busy = false;
            if (slot.kind === 'patch' && !row.ui?.valid) missedWrites = true;
            tasks.delete(executed);
        });
        tasks.add(executed);
    }
    const fixedWindowRemaining = start + seconds * 1000 - performance.now();
    if (fixedWindowRemaining > 0) await pause(fixedWindowRemaining);
    const remaining = Math.max(0, start + seconds * 1000 + profile.drainSeconds * 1000 - performance.now());
    const stopTimer = new AbortController();
    const drained = await Promise.race([
        Promise.allSettled(tasks).then(() => true),
        pause(remaining, false, { signal: stopTimer.signal }),
    ]);
    stopTimer.abort();
    if (!drained) {
        for (const reader of clients.readers) await reader.context.close();
        await Promise.allSettled(tasks);
    }
    for (const row of rows) for (const request of row.requests) delete request.completion;
    assert.equal(rows.length, schedule.length);
    assert(rows.every(row => row.outcome));
    const scheduler = quantiles(rows.map(row => row.schedulerMs - row.offeredMs));
    const maxLagMs = Math.max(...rows.map(row => row.schedulerMs - row.offeredMs));
    const missingDispatch = rows.filter(row => row.outcome === 'no_dispatch').length;
    const falseTimeout = rows.filter(row => row.outcome === 'timeout' && row.requests[0]?.status !== null && row.requests[0]?.status !== undefined).length;
    const successfulWithoutDigest = rows.flatMap(row => row.requests).filter(response => response.status === 200 && !response.bodyDigest).length;
    return {
        seconds, warmup, scheduleSeed: profile.seed,
        scheduling: { ...scheduler, maxLagMs, complete: true, drained, missingDispatch, falseTimeout, successfulWithoutDigest,
            generatorTimingAcceptable: scheduler.p95 <= 50 && maxLagMs <= 200 },
        summary: summarize(rows), rows,
        naturalRecovery: {
            total: rows.filter(row => row.recovery).length,
            valid: rows.filter(row => row.recovery?.valid).length,
            ms: quantiles(rows.filter(row => row.recovery?.valid).map(row => row.recovery.msFrom409)),
        },
        perfectReadWriteAttribution: rows.every(row => row.kind === 'patch' ? row.writeRequests <= 1 : row.writeRequests === 0),
        allPatchVersionsConfirmed: !missedWrites,
    };
}

async function main() {
    const settings = config();
    const { fixture, sessions, seconds, warmup, block } = settings;
    const global = { blockedRequests: 0, unexpectedMedicalWrites: 0, pageErrors: 0 };
    const output = { exactProductSha: profile.productSha, kind: settings.kind, sessions, block,
        node: process.version, syntheticOnly: true, fastapiThroughHttp: true, global };
    let browser;
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
            args: ['--disable-background-networking'] });
        output.chromium = browser.version();
        const indices = sessions === 4 ? [0, 1, 5, 6] : [0, 1, 2, 3, 4, 5, 6, 7];
        const readers = [];
        for (const index of indices) readers.push(await enter(browser, fixture, index, global));
        await preflight(readers[0], fixture, global);
        const writerPage = await readers[0].context.newPage();
        writerPage.setDefaultTimeout(3500);
        const writerMonitor = observe(writerPage, fixture.baseURL, global);
        writerPage.on('pageerror', () => global.pageErrors++);
        await writerPage.goto(fixture.baseURL, { waitUntil: 'domcontentloaded' });
        await writerPage.waitForFunction(() => app.appReady && !app.sessionExpired, undefined, { timeout: 12000 });
        const writer = { user: readers[0].user, userIndex: readers[0].userIndex, page: writerPage, monitor: writerMonitor, busy: false,
            version: fixture.mutation.body.expectedVersion, value: fixture.mutation.body.value };
        assert(Number.isInteger(writer.version));
        const clients = { readers, writer };
        output.sessionRoles = readers.map(x => x.user.roleId);
        output.authenticatedWriterTabSharesReaderSession = true;
        if (warmup) output.warmup = await phase(clients, fixture, warmup, block, true);
        output.measurement = await phase(clients, fixture, seconds, block, false);
        output.finalVersion = writer.version;
        output.instrumentationStatus = output.measurement.scheduling.generatorTimingAcceptable && output.measurement.scheduling.drained
            && output.measurement.scheduling.missingDispatch === 0 && output.measurement.scheduling.falseTimeout === 0
            && output.measurement.scheduling.successfulWithoutDigest === 0 && global.pageErrors === 0 && global.unexpectedMedicalWrites === 0
            && ['registry', 'card', 'workspace', 'consilium'].every(kind => output.measurement.summary[kind].validUiMsFromOffered.n > 0
                && !output.measurement.summary[kind].outcomes.http_200_without_valid_ui)
            && output.measurement.perfectReadWriteAttribution && output.measurement.allPatchVersionsConfirmed
            && (output.warmup?.allPatchVersionsConfirmed ?? true) ? 'PASS' : 'FAIL';
    } catch (error) {
        output.instrumentationStatus = 'FAIL';
        output.failure = error.name === 'TimeoutError' ? 'technical_preflight_timeout' : 'technical_preflight_or_runner_failure';
        if (process.env.PILOT_LOCAL_DIAGNOSTIC === '1') process.stderr.write(error.stack + '\n');
    } finally {
        if (browser) await browser.close();
        output.browserClosed = Boolean(browser && !browser.isConnected());
        const phases = [output.warmup, output.measurement].filter(Boolean);
        const publicPhase = phase => {
            if (!phase) return undefined;
            const { rows, ...aggregate } = phase;
            return aggregate;
        };
        const { warmup, measurement, ...meta } = output;
        const receipt = {
            public: { ...meta, warmup: publicPhase(warmup), measurement: publicPhase(measurement) },
            privateRows: { warmup: warmup?.rows, measurement: measurement?.rows },
            successfulWrites: phases.flatMap(phase => phase.rows).filter(row => row.kind === 'patch' && row.ui?.versionConfirmed).length,
            releaseDigests: phases.flatMap(phase => phase.rows).filter(row => ['registry', 'card', 'workspace', 'consilium'].includes(row.kind))
                .flatMap(row => row.requests.filter(response => response.status === 200 && response.bodyDigest)
                    .map(response => ({ userIndex: row.userIndex, sha256: response.bodyDigest }))),
        };
        fs.writeFileSync(settings.out, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    process.stdout.write(JSON.stringify({ status: output.instrumentationStatus, sessions, measurement: output.measurement?.summary }) + '\n');
    if (output.instrumentationStatus !== 'PASS') process.exitCode = 1;
}

main().catch(error => {
    process.stderr.write(error.name + ': could not execute isolated browser harness\n');
    process.exitCode = 1;
});
