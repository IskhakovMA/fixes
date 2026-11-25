// Browser navigation against the localhost-only synthetic FastAPI/SQLite lab.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { setup, api, password } = require('./fixtures.cjs');

const tabs = ['overview', 'notifications', 'data', 'complaints', 'events', 'checklist', 'notes', 'history'];
const origin = process.env.WP_H_ORIGIN;
const out = process.env.OUT;
assert.match(origin || '', /^http:\/\/127\.0\.0\.1:\d+$/);
assert(out, 'set OUT for the synthetic browser receipt');

const receipt = { syntheticOnly: true, realBackend: true, check: [], trace: [], axe: [], transport: [] };
const save = () => fs.writeFileSync(path.join(out, 'history-results.json'), JSON.stringify(receipt, null, 2));
const record = check => { receipt.check.push(check); save(); console.log(check); };

async function login(page, username) {
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#loginSubmit').click();
    await page.waitForFunction(() => app.appReady && !app.sessionExpired && !app.sessionReconciling);
}

async function screen(page, target, tab = null, focus = false) {
    try {
        await page.waitForFunction(({ target, tab }) => {
        const url = new URL(location.href);
        const view = document.getElementById('view-' + target);
        return url.searchParams.get('screen') === target && url.searchParams.get('tab') === tab
            && (target === 'create' ? !document.querySelector('#addModal').hidden : view && !view.classList.contains('is-hidden'))
            && (tab === null || document.querySelector('#patientTabs [aria-selected=true]')?.id === 'tab-' + tab);
        }, {target, tab});
    } catch (error) {
        receipt.failure = await page.evaluate(({target, tab}) => ({
            target, tab, screen: new URL(location.href).searchParams.get('screen'),
            index: history.state?.index, view: app.currentView, expired: app.sessionExpired,
            reconciling: app.sessionReconciling, hasPatient: Boolean(app.currentPatientId),
        }), {target, tab}).catch(() => ({target, tab}));
        save();
        console.error(JSON.stringify(receipt.failure));
        throw error;
    }
    const observed = await page.evaluate(() => ({
        query: [...new URL(location.href).searchParams], hash: location.hash,
        pathname: location.pathname, state: history.state, length: history.length,
    }));
    const expected = tab === null ? [['screen', target]] : [['screen', target], ['tab', tab]];
    assert.deepEqual(observed.query, expected, 'URL must contain the safe screen and tab only');
    assert.equal(observed.pathname, '/');
    assert.equal(observed.hash, '');
    assert.deepEqual(Object.keys(observed.state).sort(), ['index', 'nonce', 'route', 'v']);
    assert(Number.isSafeInteger(observed.state.v) && Number.isSafeInteger(observed.state.index));
    for (const key of ['nonce', 'route']) {
        assert.match(observed.state[key], /^[A-Za-z0-9_-]{16,128}$/, key + ' must be opaque');
    }
    if (focus) {
        if (tab) await page.waitForFunction(tab => document.activeElement?.id === 'tab-' + tab, tab);
        else await page.waitForFunction(target => {
            const active = document.activeElement;
            return active?.closest('#view-' + target) && (active.matches('h1,[role=heading]'));
        }, target);
    }
    receipt.trace.push({ screen: target, tab, index: observed.state.index, length: observed.length, expectedFocus: focus });
    return observed;
}

async function historyStep(page, direction, target, tab = null, focus = true) {
    if (direction === 'back') await page.goBack();
    else await page.goForward();
    return screen(page, target, tab, focus);
}

async function nav(page, view) {
    const target = page.locator('.nav__item[data-view="' + view + '"]');
    if (!await target.isVisible()) await page.locator('#sidebarToggle').click();
    await target.click();
    return screen(page, view);
}

async function openFromRegistry(page, name) {
    if (name) {
        const search = page.locator('#searchInput');
        await search.fill(name);
        await page.getByRole('button', {name: 'Открыть карточку: ' + name, exact: true}).click();
    } else {
        await page.locator('#patientsBody .patient-open').first().click();
    }
    return screen(page, 'patient', 'overview');
}

function monitor(page) {
    const events = { detail: [], medicalWrites: 0, pageErrors: 0 };
    page.on('pageerror', () => events.pageErrors++);
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === origin && /^\/api\/(patients|consilium|notifications|analytics|data-quality|imports?|migrate)(\/|$)/.test(url.pathname)
            && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) events.medicalWrites++;
    });
    page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === origin && /^\/api\/patients\/[^/]+$/.test(url.pathname)
            && !['resolve', 'head-options', 'unresolved'].some(key => url.pathname.endsWith('/' + key))
            && response.request().method() === 'GET') events.detail.push({url: url.pathname, status: response.status()});
    });
    return events;
}

async function auditCardCount(fixture) {
    const result = await fixture.call('GET', '/api/audit?limit=200');
    return result.events.filter(event => event.event_type === 'medical_read_release'
        && event.detail?.includes('GET /api/patients/{patient_id}')).length;
}

async function presentation(page) {
    await page.evaluate(fs.readFileSync(process.env.AXE_SOURCE || path.join(__dirname, '../wp_h/node_modules/axe-core/axe.min.js'), 'utf8'));
    for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => app.applyTheme(theme), theme);
        for (const width of [320, 375, 768, 1440]) {
            await page.setViewportSize({width, height: 1000});
            const sample = await page.evaluate(async () => {
                await document.fonts.ready;
                await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
                const {violations} = await axe.run(document, {
                    runOnly: {type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']},
                });
                return {scrollWidth: document.documentElement.scrollWidth, violations: violations.map(item => item.id)};
            });
            receipt.axe.push({theme, width, ...sample});
            assert(sample.scrollWidth <= width, 'no horizontal document overflow at ' + width);
            assert.deepEqual(sample.violations, [], 'WCAG A/AA at ' + theme + ' ' + width);
        }
    }
    record('Chromium both themes, 320/375/768/1440 and WCAG 2.0/2.1 A/AA');
}

async function navigation(browser, fixture) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
    try {
        const page = await context.newPage();
        const events = monitor(page);
        await page.goto(origin);
        await login(page, 'wph.dev');
        const start = await screen(page, 'patients');
        const skip = page.getByRole('link', {name: 'Перейти к содержимому'});
        await skip.focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement?.id === 'workspaceMain');
        const afterSkip = await screen(page, 'patients');
        assert.deepEqual(afterSkip.state, start.state);
        assert.equal(afterSkip.length, start.length, 'skip link is a focus action, not a history entry');
        const beforeAudit = await auditCardCount(fixture);
        const opened = await openFromRegistry(page, fixture.card.name);
        const secretValues = [fixture.card.id, fixture.card.name, fixture.card.diagnosis, fixture.card.phone, password];
        const encoded = JSON.stringify(opened.state);
        assert(secretValues.every(value => !encoded.includes(value)), 'history state must not hold synthetic card values');
        assert.equal(opened.length, start.length + 1);
        for (const tab of tabs.slice(1)) {
            await page.locator('#tab-' + tab).click();
            await screen(page, 'patient', tab);
        }
        const selected = await screen(page, 'patient', 'history');
        await page.evaluate(() => { app.refreshCurrent(); app.applyTheme('light'); });
        const rendered = await screen(page, 'patient', 'history');
        assert.equal(rendered.length, selected.length, 'theme/rerender cannot create history entries');
        assert.deepEqual(rendered.state, selected.state);
        const detailPath = '/api/patients/' + fixture.card.id;
        const countDetail = () => events.detail.filter(event => event.url === detailPath && event.status === 200).length;
        const beforeBack = countDetail();
        for (const tab of tabs.slice(0, -1).reverse()) await historyStep(page, 'back', 'patient', tab);
        await historyStep(page, 'back', 'patients');
        for (const tab of tabs) await historyStep(page, 'forward', 'patient', tab);
        assert(countDetail() > beforeBack, 'history restores patient by a fresh authorized GET');
        assert(await auditCardCount(fixture) > beforeAudit, 'real backend audited released card data');
        assert.equal((await screen(page, 'patient', 'history')).length, selected.length);
        record('Eight real card tabs traverse Back/Forward without adding entries; authorized GET and medical read audit');

        await historyStep(page, 'back', 'patient', 'notes');
        await historyStep(page, 'back', 'patient', 'checklist');
        const eventEntry = await historyStep(page, 'back', 'patient', 'events');
        const input = page.getByRole('textbox', {name: 'Примечание к этапу', exact: true}).first();
        const draft = 'Синтетический несохраненный ввод I9';
        await input.fill(draft);
        await page.goBack();
        await page.locator('#confirmCancelBtn').click();
        const restored = await screen(page, 'patient', 'events');
        assert.equal(restored.state.index, eventEntry.state.index);
        assert.equal(restored.length, eventEntry.length);
        assert.equal(await input.inputValue(), draft);
        assert(!JSON.stringify(restored.state).includes(draft));
        await page.goForward();
        await page.locator('#confirmOkBtn').click();
        await screen(page, 'patient', 'checklist', true);
        await historyStep(page, 'forward', 'patient', 'notes');
        record('Clinical draft cancel restores index and preserves Forward; explicit discard permits next transition');

        await nav(page, 'calendar');
        await page.locator('#calendarPanel').getByRole('button', {name: /Открыть карточку:/}).first().click();
        await screen(page, 'patient', 'events');
        await historyStep(page, 'back', 'calendar');
        await historyStep(page, 'forward', 'patient', 'events');
        await nav(page, 'analytics');
        await page.locator('#analyticsStatsRow').getByRole('button', {name: /^Активные/}).click();
        await page.locator('#analyticsDetailsPanel').getByRole('button', {name: 'Открыть пациента'}).first().click();
        await screen(page, 'patient', 'overview');
        await historyStep(page, 'back', 'analytics');
        await historyStep(page, 'forward', 'patient', 'overview');
        record('Click through calendar and analytics to authorized cards, with Back/Forward and focus');

        await nav(page, 'patients');
        await page.locator('#openAddBtn').click();
        await screen(page, 'create');
        await page.locator('#fio').fill(draft);
        await page.goBack();
        await page.locator('#confirmCancelBtn').click();
        await screen(page, 'create');
        assert.equal(await page.locator('#fio').inputValue(), draft);
        await page.goBack();
        await page.locator('#confirmOkBtn').click();
        await screen(page, 'patients');
        record('Create form Back cancellation preserves local input; explicit discard returns to registry');

        await openFromRegistry(page, fixture.card.name);
        await presentation(page);
        await page.locator('#tab-overview').focus();
        await page.keyboard.press('ArrowRight');
        await screen(page, 'patient', 'notifications', true);
        const beforeReload = events.detail.length;
        await page.reload();
        await screen(page, 'patients');
        assert.equal(events.detail.length, beforeReload, 'reload never fetches a prior route by old URL');
        await page.goBack();
        await screen(page, 'patients');
        await page.goForward();
        await screen(page, 'patients');
        assert.equal(events.detail.length, beforeReload, 'prior-document entries cannot restore any card');
        assert.equal(events.medicalWrites, 0, 'navigation never writes medical data');
        assert.equal(events.pageErrors, 0);
        record('Arrow navigation, reload and old history entries resolve to authorized registry, zero medical writes');
    } finally {
        await context.close();
    }
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}

async function saving(browser, fixture) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    const received = deferred();
    const release = deferred();
    try {
        const page = await context.newPage();
        const events = monitor(page);
        await page.goto(origin);
        await login(page, 'wph.dev');
        await openFromRegistry(page, fixture.card.name);
        await page.locator('#tab-data').click();
        await screen(page, 'patient', 'data');
        await page.locator('#patientPanels input[type=tel]').fill('+70000000199');
        await page.locator('#tab-history').click();
        await page.locator('#confirmOkBtn').click();
        const current = await screen(page, 'patient', 'history');
        const edit = await fixture.call('GET', '/api/patients/' + fixture.card.id);
        await fixture.call('PATCH', '/api/patients/' + fixture.card.id,
            {field: 'phone', value: '+70000000188', expectedVersion: edit.version});
        const detail = origin + '/api/patients/' + fixture.card.id;
        await page.route(detail, async route => {
            if (route.request().method() !== 'PATCH') { await route.continue(); return; }
            const reply = await route.fetch();
            received.resolve(reply.status());
            await release.promise;
            await route.fulfill({response: reply});
        });
        const outgoing = page.waitForRequest(request => request.url() === detail && request.method() === 'PATCH');
        await page.getByRole('button', {name: 'Сохранить правку', exact: true}).click();
        await outgoing;
        assert.equal(await received.promise, 409, 'actual stale-version backend denial before response released');
        await page.goBack();
        const corrected = await screen(page, 'patient', 'history');
        assert.equal(corrected.state.index, current.state.index);
        assert.equal(events.medicalWrites, 1);
        const delivered = page.waitForResponse(response => response.url() === detail
            && response.request().method() === 'PATCH' && response.status() === 409);
        release.resolve();
        await (await delivered).finished();
        await page.getByRole('button', {name: 'Сохранить правку', exact: true}).waitFor();
        assert.equal((await fixture.call('GET', '/api/patients/' + fixture.card.id)).phone, '+70000000188');
        assert.equal(events.medicalWrites, 1);
        assert.equal(events.pageErrors, 0);
        receipt.transport.push('Actual stale-version 409 withheld until browser Back is rejected during pending write');
        record('Pending explicit save blocks Back and never resubmits; real 409 retains manual original-version draft');
    } finally {
        release.resolve();
        await context.close();
    }
}

async function transportAndIdentity(browser, fixture) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    let release;
    try {
        const page = await context.newPage();
        const events = monitor(page);
        await page.addInitScript(() => {
            window.addEventListener('pageshow', event => { window.historyTestRestored = event.persisted; });
        });
        await page.goto(origin);
        await login(page, 'wph.dev');
        const oldEntry = await openFromRegistry(page, fixture.card.name);
        await nav(page, 'calendar');
        const detail = origin + '/api/patients/' + fixture.card.id;
        const fetched = deferred();
        const paused = new Promise(resolve => { release = resolve; });
        await page.route(detail, async route => {
            const reply = await route.fetch();
            fetched.resolve(reply.status());
            await paused;
            await route.fulfill({response: reply});
        }, {times: 1});
        const read = page.waitForRequest(request => request.url() === detail);
        await page.goBack();
        await read;
        assert.equal(await fetched.promise, 200, 'auth-scoped backend response obtained before opposite traversal');
        await page.goForward();
        await screen(page, 'calendar');
        const delayed = page.waitForResponse(response => response.url() === detail && response.status() === 200);
        release();
        await (await delayed).finished();
        await page.waitForLoadState('networkidle');
        await screen(page, 'calendar');
        assert(await page.locator('#view-patient').isHidden());
        receipt.transport.push('Real 200 withheld by Playwright until newer Forward intent');
        record('Opposite browser traversal beats delayed genuine HTTP 200 and retains authorized destination');

        const lost = page.waitForEvent('requestfailed', request => request.url() === detail);
        await page.route(detail, route => route.abort('connectionreset'), {times: 1});
        await page.goBack();
        await lost;
        await screen(page, 'calendar');
        assert(await page.locator('#view-patient').isHidden());
        receipt.transport.push('Single detail GET transport failure injected; no synthetic HTTP status returned');
        record('Failed detail transport restores current location without revealing cached card');
        await historyStep(page, 'back', 'patient', 'overview');

        await page.goto(origin + '/api/health');
        assert.equal(new URL(page.url()).pathname, '/api/health');
        await api(context, origin, 'POST', '/api/auth/logout', {});
        const expired = await context.request.get(detail);
        assert.equal(expired.status(), 401, 'real backend reports revoked session');
        await page.evaluate(() => history.back());
        await page.locator('#loginForm').waitFor({state: 'visible'});
        assert(await page.locator('#view-patient').isHidden(), 'cached patient screen is not displayed without session');
        receipt.bfcache = await page.evaluate(() => window.historyTestRestored === true);
        const freshNonce = await login(page, fixture.roles.doctor.username).then(() => screen(page, 'patients'));
        assert.notEqual(freshNonce.state.nonce, oldEntry.state.nonce, 'new identity gets a different history nonce');
        assert(await page.locator('#view-patient').isHidden());
        const forbidden = await context.request.get(origin + '/api/audit');
        assert.equal(forbidden.status(), 403, 'real audit permission remains denied for doctor');
        await nav(page, 'calendar');
        assert.equal((await screen(page, 'calendar')).state.index, freshNonce.state.index + 1, 'one history entry after login');
        await historyStep(page, 'back', 'patients');
        assert.equal(events.medicalWrites, 0);
        record('External document, revoked session (real 401), different login and unchanged RBAC (real audit 403)');
    } finally {
        if (release) release();
        await context.close();
    }
}

async function prepareUnknownForward(page, tab) {
    // Simulate an entry created by an older client in the same document.
    await page.evaluate(() => { history.pushState({legacyFixture: true}, '', '?screen=calendar'); });
    const current = await historyStep(page, 'back', 'patient', tab, false);
    await page.goForward();
    await page.locator('#confirmModal').waitFor({state: 'visible'});
    const scrubbed = await page.evaluate(() => ({
        query: location.search, keys: Object.keys(history.state || {}).sort(),
        route: history.state?.route, length: history.length,
    }));
    assert.equal(scrubbed.query, '?screen=patients', 'unknown entry URL is scrubbed before consent');
    assert.deepEqual(scrubbed.keys, ['index', 'nonce', 'route', 'v'], 'unknown state is scrubbed before consent');
    assert.notEqual(scrubbed.route, current.state.route, 'browser reached the formerly unknown entry');
    assert.equal(scrubbed.length, current.length);
    return current;
}

async function unknownDraft(browser, fixture) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    try {
        const page = await context.newPage();
        const events = monitor(page);
        await page.goto(origin);
        await login(page, 'wph.dev');
        await openFromRegistry(page, fixture.card.name);
        await page.locator('#tab-events').click();
        await screen(page, 'patient', 'events');
        const input = page.getByRole('textbox', {name: 'Примечание к этапу', exact: true}).first();
        const initial = await input.inputValue();
        const draft = 'Синтетический черновик неизвестного маршрута';
        await input.fill(draft);
        await input.evaluate(node => { window.i9OriginalDraftField = node; });
        const beforeStay = await prepareUnknownForward(page, 'events');
        const countAudit = await auditCardCount(fixture);
        const response = page.waitForResponse(res => res.request().method() === 'GET'
            && new URL(res.url()).pathname === '/api/patients/' + fixture.card.id && res.status() === 200);
        await page.locator('#confirmCancelBtn').click();
        await (await response).finished();
        const stayed = await screen(page, 'patient', 'events');
        assert.equal(stayed.length, beforeStay.length, 'stay replaces the unknown entry; it never pushes');
        assert.notEqual(stayed.state.route, beforeStay.state.route, 'the replacement has its own opaque route');
        assert(!JSON.stringify(stayed.state).includes(draft));
        assert(await input.evaluate(node => node === window.i9OriginalDraftField), 'stay preserves the existing DOM');
        assert(await input.inputValue() === draft, 'stay preserves exact draft content');
        await input.evaluate(node => {
            if (document.activeElement !== node) throw new Error('stay must return focus to the draft control');
        });
        assert(await auditCardCount(fixture) > countAudit, 'stay released a new audited patient response');
        assert.equal(events.medicalWrites, 0);
        record('Unknown entry, stay: audited real GET, original DOM/draft/focus, only replaceState, zero medical writes');

        const beforeLeave = await prepareUnknownForward(page, 'events');
        await page.locator('#confirmOkBtn').click();
        const registry = await screen(page, 'patients', null, true);
        assert.equal(registry.length, beforeLeave.length, 'leave replaces the unknown entry; it never pushes');
        assert(await page.locator('#view-patient').isHidden());
        assert(!JSON.stringify(registry.state).includes(draft));
        await openFromRegistry(page, fixture.card.name);
        await page.locator('#tab-events').click();
        await screen(page, 'patient', 'events');
        assert(await input.inputValue() === initial, 'confirmed departure discarded unsaved input');
        assert.equal(events.medicalWrites, 0);
        assert.equal(events.pageErrors, 0);
        record('Unknown entry, leave: authorized registry, explicit draft discard, only replaceState, zero medical writes');
    } finally {
        await context.close();
    }
}

async function unknownDenial(browser, fixture) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    const releaseReload = deferred();
    try {
        const page = await context.newPage();
        const events = monitor(page);
        await page.goto(origin);
        await login(page, fixture.roles.doctor.username);
        // This fixture is already in the doctor's registry. A search here
        // schedules a debounced GET that can take the one-shot reload route.
        await page.getByRole('button', {name: 'Открыть карточку: ' + fixture.large.name, exact: true}).click();
        await screen(page, 'patient', 'overview');
        await page.locator('#tab-events').click();
        await screen(page, 'patient', 'events');
        await page.getByRole('textbox', {name: 'Примечание к этапу', exact: true}).first().fill('Синтетический черновик отзыва');
        const previous = await prepareUnknownForward(page, 'events');
        const old = await fixture.call('GET', '/api/patients/' + fixture.large.id);
        await fixture.call('PUT', '/api/patients/' + fixture.large.id + '/treating-doctor',
            {userId: null, expectedVersion: old.version});
        const rowPresent = () => page.evaluate(name => [...document.querySelectorAll('#patientsBody .patient-open')]
            .some(button => button.textContent === name), fixture.large.name);
        assert(await rowPresent(), 'the pre-revocation registry still contains the fixture row');
        const registryPage = url => url.origin === origin && url.pathname === '/api/patients'
            && url.searchParams.get('view') === 'page';
        const isRegistryRead = request => request.method() === 'GET' && registryPage(new URL(request.url()));
        const session = await page.evaluate(() => ({epoch: app.sessionEpoch, actor: app.user?.id}));
        await page.route(registryPage, async route => {
            await releaseReload.promise;
            await route.continue();
        }, {times: 1});
        const reloadRequest = page.waitForRequest(isRegistryRead);
        // If the detail assertion fails, the absent reload must not mask it.
        void reloadRequest.catch(() => {});
        const denied = page.waitForResponse(response => response.request().method() === 'GET'
            && response.url() === origin + '/api/patients/' + fixture.large.id);
        await page.locator('#confirmCancelBtn').click();
        const deniedResponse = await denied;
        assert.equal(deniedResponse.status(), 404, 'the live scoped detail must deny the reassigned patient');
        await deniedResponse.finished();
        const registry = await screen(page, 'patients', null, true);
        const request = await reloadRequest;
        assert.equal(registry.length, previous.length);
        assert(await page.locator('#view-patient').isHidden());
        assert(await page.evaluate(() => app.currentPatientId == null && app.patientDetails.size === 0
            && app.sessionFieldDrafts.size === 0));
        assert(!await rowPresent(), 'the revoked row must be purged before the registry response arrives');
        assert(await page.evaluate(({epoch, actor}) => Boolean(actor)
            && app.sessionEpoch === epoch && app.user?.id === actor
            && !app.sessionExpired && !app.sessionReconciling, session), 'object denial keeps the same authorized session');
        const reloaded = page.waitForResponse(response => response.request() === request);
        releaseReload.resolve();
        await (await reloaded).finished();
        assert.equal(events.medicalWrites, 0);
        assert.equal(events.pageErrors, 0);
        record('Unknown entry, stay denied by real 404: only replaceState, card and registry row purged before reload, zero medical writes');
    } finally {
        releaseReload.resolve();
        await context.close();
    }
}

async function holdUnknownStay(page, detail, release) {
    const obtained = deferred();
    await page.route(detail, async route => {
        const response = await route.fetch();
        obtained.resolve(response.status());
        await release.promise;
        await route.fulfill({response});
    }, {times: 1});
    const request = page.waitForRequest(req => req.method() === 'GET' && req.url() === detail);
    await page.locator('#confirmCancelBtn').click();
    await request;
    assert.equal(await obtained.promise, 200, 'stay response came from the authorized backend');
}

async function unknownRace(browser, fixture) {
    for (const trigger of ['history', 'epoch']) {
        const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
        const release = deferred();
        try {
            const page = await context.newPage();
            const events = monitor(page);
            await page.goto(origin);
            await login(page, 'wph.dev');
            await openFromRegistry(page, fixture.card.name);
            await page.locator('#tab-events').click();
            await screen(page, 'patient', 'events');
            const input = page.getByRole('textbox', {name: 'Примечание к этапу', exact: true}).first();
            await input.fill('Синтетический черновик гонки истории');
            // Observe completion of the real recovery handler. A stale fetch can
            // be dropped before its body is read, so Response.finished() is not a barrier.
            await page.evaluate(() => {
                const recover = browserNavigation.recoverUnknown;
                const completed = [];
                window.i9CompletedRecoveries = completed;
                let sequence = 0;
                browserNavigation.recoverUnknown = async function (...args) {
                    const id = ++sequence;
                    try { return await recover.apply(this, args); }
                    finally { completed.push(id); }
                };
            });
            const previous = await prepareUnknownForward(page, 'events');
            const detail = origin + '/api/patients/' + fixture.card.id;
            await holdUnknownStay(page, detail, release);
            let secured;
            if (trigger === 'history') {
                const restored = await historyStep(page, 'back', 'patient', 'events', false);
                assert.deepEqual(restored.state, previous.state, 'Back reaches the prior known position');
                await page.goForward();
                await page.locator('#confirmOkBtn').click();
                secured = await screen(page, 'patients');
                assert.equal(secured.length, previous.length);
            } else {
                const epoch = await page.evaluate(() => app.sessionEpoch || 0);
                await api(context, origin, 'POST', '/api/auth/logout', {});
                const status = await page.evaluate(async () => {
                    try { await apiGetJson('/api/patients/head-options'); return 200; }
                    catch (error) { return error.status; }
                });
                assert.equal(status, 401, 'backend revoked session during old response delivery');
                await page.locator('#loginForm').waitFor({state: 'visible'});
                await page.waitForFunction(epoch => app.sessionEpoch > epoch, epoch);
                assert(await page.locator('#view-patient').isHidden());
                secured = await page.evaluate(() => ({state: history.state, length: history.length}));
            }
            const delivered = page.waitForResponse(response => response.request().method() === 'GET'
                && response.url() === detail && response.status() === 200);
            release.resolve();
            assert.equal((await delivered).status(), 200);
            await page.waitForFunction(() => window.i9CompletedRecoveries.includes(1));
            const active = await page.evaluate(() => ({state: history.state, length: history.length}));
            assert.deepEqual(active, {state: secured.state, length: secured.length}, 'old HTTP 200 cannot modify the secure history state');
            assert(await page.locator('#view-patient').isHidden());
            if (trigger === 'history') await screen(page, 'patients');
            else assert(await page.locator('#loginForm').isVisible());
            assert.equal(events.medicalWrites, 0);
            assert.equal(events.pageErrors, 0);
            record(trigger === 'history'
                ? 'Unknown stay race: held audited HTTP 200 cannot override the newer Back/Forward and confirmed exit'
                : 'Unknown stay race: held audited HTTP 200 cannot restore card after real 401 and changed session epoch');
        } finally {
            release.resolve();
            await context.close();
        }
    }
}

async function objectRevocation(browser, fixture) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
    try {
        const page = await context.newPage();
        const events = monitor(page);
        await page.goto(origin);
        await login(page, fixture.roles.doctor.username);
        await openFromRegistry(page, fixture.card.name);
        const epoch = await page.evaluate(() => app.sessionEpoch);
        await historyStep(page, 'back', 'patients');
        await page.waitForFunction(() => !app.patientListDirty);
        const old = await fixture.call('GET', '/api/patients/' + fixture.card.id);
        await fixture.call('PUT', '/api/patients/' + fixture.card.id + '/treating-doctor',
            {userId: null, expectedVersion: old.version});
        assert.equal(await page.evaluate(() => app.sessionEpoch), epoch, 'object-only change leaves session epoch alone');
        const denied = page.waitForResponse(response => response.request().method() === 'GET'
            && new URL(response.url()).pathname === '/api/patients/' + fixture.card.id && response.status() === 404);
        await page.goForward();
        await denied;
        await screen(page, 'patients', null, false);
        assert(await page.locator('#view-patient').isHidden());
        assert.equal(await page.evaluate(() => app.currentPatientId == null && app.patientDetails.size === 0), true);
        assert.equal(events.medicalWrites, 0);
        record('Real 404 after independently reassigned object; unchanged pre-restore epoch, previous card purged');
    } finally {
        await context.close();
    }
}

async function main() {
    const browser = await chromium.launch({
        headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
        ignoreDefaultArgs: ['--disable-back-forward-cache'],
    });
    let fixture;
    try {
        fixture = await setup(browser, origin);
        const cases = {navigation, saving, transportAndIdentity, objectRevocation, unknownDraft, unknownDenial, unknownRace};
        const requested = process.env.HISTORY_SCENARIO;
        assert(!requested || Object.hasOwn(cases, requested), 'unknown history test scenario');
        for (const [name, run] of Object.entries(cases)) {
            if (requested && name !== requested) continue;
            receipt.phase = name;
            save();
            await run(browser, fixture);
        }
        receipt.phase = 'complete';
    } finally {
        save();
        if (fixture) await fixture.admin.close();
        await browser.close();
    }
}

main().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
});
