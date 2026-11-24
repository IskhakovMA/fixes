const assert = require('node:assert/strict');

const {
    api, arm, boundedWait, currentSession, fixture, getQuality, isQuality, login, observe,
    qualityView, setupBounded, successful, syntheticError,
} = require('./browser_helpers.cjs');

const qualityRequests = url => isQuality(url.href);
const ownerName = 'Синтетика I8A3 00000';
const nextName = 'Синтетика I8A3 00001';

async function withQuality(browser, ui, operation, username = fixture.accounts.developer) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
        await login(page, username);
        const ledger = observe(page);
        await setupBounded(page);
        const first = await ui.enter(page);
        await operation(page, context, ledger, first);
    } finally {
        await context.close();
    }
}

async function superseded(browser, ui, failLatest) {
    await withQuality(browser, ui, async (page, context, ledger) => {
        const held = arm();
        const release = arm();
        const finished = arm();
        await page.route(qualityRequests, async route => {
            const search = decodeURIComponent(await route.request().headerValue('x-search') || '');
            if (search === ownerName) {
                const response = await route.fetch();
                assert.equal(response.status(), 200, 'get a real completed response before delay');
                held.resolve();
                await release.promise;
                try { await route.fulfill({ response }); }
                finally { finished.resolve(); }
                return;
            }
            if (search === nextName && failLatest) return syntheticError(route, 503, 'QUALITY_READ_UNAVAILABLE');
            return route.continue();
        });
        try {
            const old = ui.changeSearch(page, ownerName);
            old.catch(() => {});
            await boundedWait(held.promise, 'previous real Quality response was not held');
            const newest = await ui.changeSearch(page, nextName);
            if (failLatest) {
                assert.equal(newest.status(), 503);
                await ui.action(ui.section(page, 'patients'), 'retry').waitFor({ state: 'visible' });
                await ui.waitEmptyActions(page);
            } else {
                const data = await successful(newest, 'page');
                const winner = data.patients.items[0].patient_id;
                assert.notEqual(winner, fixture.ownerPatientId);
                await ui.waitPatient(page, winner);
            }
            release.resolve();
            await boundedWait(finished.promise, 'held response was not delivered or settled');
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.equal(await page.getByText(ownerName, { exact: true }).count(), 0, 'late response may not publish old rows');
            const text = await ui.searchBox(page).inputValue();
            assert.equal(text, nextName);
            if (failLatest) {
                assert(await ui.action(ui.section(page, 'patients'), 'retry').isVisible());
                await ui.waitEmptyActions(page);
            } else {
                assert.equal(await ui.action(ui.section(page, 'patients'), 'patient').count(), 1);
            }
            assert.equal(ledger.quality.length, 3, 'delays and terminal 503 cannot cause background fetch');
            ui.noLegacyOrWrites(ledger);
        } finally {
            release.resolve();
            await page.unroute(qualityRequests);
        }
    });
}

async function restart(browser, ui, status, code, repeated) {
    await withQuality(browser, ui, async (page, context, ledger) => {
        assert.equal((await ui.changeSearch(page, 'Синтетика I8A3')).status(), 200);
        await ui.action(ui.section(page, 'patients'), 'next').waitFor({ state: 'visible' });
        const prior = ledger.quality.length;
        let hit = 0;
        await page.route(qualityRequests, route => {
            hit++;
            if (repeated || hit === 1) return syntheticError(route, status, code);
            return route.continue();
        });
        const firstError = page.waitForResponse(r => isQuality(r.url()) && r.status() === status);
        const restartReply = page.waitForResponse(r => isQuality(r.url()) &&
            !new URL(r.url()).searchParams.has('cursor'));
        await ui.action(ui.section(page, 'patients'), 'next').click();
        assert.equal((await firstError).status(), status);
        const reply = await restartReply;
        if (repeated) {
            assert.equal(reply.status(), status);
            await ui.action(ui.section(page, 'patients'), 'retry').waitFor({ state: 'visible' });
            await ui.waitEmptyActions(page);
        } else {
            const data = await successful(reply, 'page');
            assert.equal(data.patients.page.offset, 0);
            await ui.waitPatient(page, data.patients.items[0].patient_id);
        }
        assert.equal(hit, 2, 'bounded to one restart for a user action');
        assert.equal(ledger.quality.length, prior + 2);
        assert.equal(await ui.searchBox(page).inputValue(), 'Синтетика I8A3');
        assert.equal(!!(await reply.request().headerValue('x-search')), true, 'restart preserves search in header');
        ui.noLegacyOrWrites(ledger);
    });
}

async function denial(browser, ui, status) {
    await withQuality(browser, ui, async (page, context, ledger, first) => {
        const group = first.duplicate_groups.items[0];
        const target = ui.section(page, 'groups').locator(`[data-group-id="${group.group_id}"]`);
        await page.route(qualityRequests, route => syntheticError(route, status));
        const failed = await ui.clickFor(page, target, 'members');
        assert.equal(failed.status(), status);
        await ui.waitEmptyActions(page, 'members');
        assert.equal(ledger.quality.length, 2, 'scope and neutral missing failures do not retry');
        assert.equal(await ui.action(ui.section(page, 'members'), 'patient').count(), 0);
        ui.noLegacyOrWrites(ledger);
    });
}

async function privileged(browser) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, fixture.accounts.developer);
    return context;
}

async function liveAuthorization(browser, ui, type) {
    const admin = await privileged(browser);
    try {
        const actor = type === '401' ? 'doctor' : 'head';
        await withQuality(browser, ui, async (page, context, ledger, first) => {
            const oldId = first.patients.items[0].patient_id;
            await ui.waitPatient(page, oldId);
            const path = '/api/users/' + encodeURIComponent(fixture.accountIds[actor]);
            const response = type === '401'
                ? await api(admin, 'POST', path + '/terminate-sessions', { data: {} })
                : await api(admin, 'PATCH', path, { data: { departmentIds: [] } });
            assert(response.ok(), 'real synthetic actor session/scope mutation');
            const denied = await ui.changeSearch(page, ownerName);
            assert.equal(denied.status(), Number(type));
            if (type === '409') assert.equal((await denied.json()).code, 'ACCESS_CONTEXT_CHANGED');
            await page.waitForFunction(() => app.sessionExpired && document.body.classList.contains('session-locked'));
            await page.locator('#loginSubmit').waitFor({ state: 'visible' });
            const oldRow = page.locator(`#qualityV1Workspace [data-patient-id="${oldId}"]`);
            assert.equal(await oldRow.count(), 0, 'obsolete rows clear while the session is locked');
            assert.equal(ledger.quality.length, 2, 'auth failures never restart the root');
            // Re-auth does a new read in the current context. The head whose
            // department membership was removed sees a valid empty state.
            const fresh = getQuality(page);
            await page.locator('#password').fill(fixture.password);
            await page.locator('#loginSubmit').click();
            await currentSession(page);
            const data = await successful(await fresh, 'page');
            assert.notEqual(data.snapshot.token, first.snapshot.token, 'reauth uses a new root');
            assert.equal(ledger.quality.length, 3);
            if (type === '409') {
                assert.equal(data.scope_summary.total_patients, 0);
                assert.equal(await oldRow.count(), 0);
            } else {
                assert.equal(data.scope_summary.total_patients, first.scope_summary.total_patients);
            }
            ui.noLegacyOrWrites(ledger);
        }, fixture.accounts[actor]);
    } finally {
        await admin.close();
    }
}

async function peerIdentity(browser, ui) {
    await withQuality(browser, ui, async (page, context, ledger, first) => {
        const tab = await context.newPage();
        await tab.goto(fixture.baseURL);
        await currentSession(tab);
        const held = arm();
        const release = arm();
        const finished = arm();
        await page.route(qualityRequests, async route => {
            const reply = await route.fetch();
            assert.equal(reply.status(), 200);
            held.resolve();
            await release.promise;
            try { await route.fulfill({ response: reply }); }
            catch (error) {
                if (await page.evaluate(() => app.user?.id).catch(() => null) !== fixture.accountIds.hiddenDoctor) throw error;
            } finally { finished.resolve(); }
        });
        try {
            const pending = ui.changeSearch(page, ownerName);
            pending.catch(() => {});
            await boundedWait(held.promise, 'did not suspend old actor response');
            await Promise.all([tab.waitForEvent('load'), tab.getByRole('button', { name: 'Выйти', exact: true }).click()]);
            await tab.locator('#username').fill(fixture.accounts.hiddenDoctor);
            await tab.locator('#password').fill(fixture.password);
            await tab.locator('#loginSubmit').click();
            await tab.waitForFunction(id => app.appReady && app.user?.id === id, fixture.accountIds.hiddenDoctor);
            await page.evaluate(() => app.reconcilePeerSession()).catch(() => {});
            await page.waitForFunction(id => app.appReady && !app.sessionExpired && app.user?.id === id, fixture.accountIds.hiddenDoctor);
            release.resolve();
            await boundedWait(finished.promise, 'old actor request did not settle');
            assert.equal(await page.locator(`#qualityV1Workspace [data-patient-id="${first.patients.items[0].patient_id}"]`).count(), 0);
            assert.equal(await page.locator('#qualityV1Workspace').isVisible(), false);
            ui.noLegacyOrWrites(ledger);
        } finally {
            release.resolve();
            await page.unroute(qualityRequests);
        }
    });
}

async function staleIdentityFailure(browser, ui) {
    await withQuality(browser, ui, async (page, context, ledger, first) => {
        await ui.waitPatient(page, first.patients.items[0].patient_id);
        const held = arm();
        const release = arm();
        const completed = arm();
        let firstCheck = true;
        const authPath = '**/api/auth/me';
        await page.route(authPath, async route => {
            if (!firstCheck) return route.continue();
            firstCheck = false;
            held.resolve();
            await release.promise;
            try { await route.abort('failed'); }
            finally { completed.resolve(); }
        });
        try {
            assert.equal((await ui.changeSearch(page, ownerName)).status(), 200);
            await boundedWait(held.promise, 'identity validation after old Quality response was not suspended');
            const epoch = await page.evaluate(() => app.sessionEpoch || 0);
            // Explicit synthetic lock opens the normal same-user login screen.
            // The delayed failure is injected on the earlier identity transport.
            await page.evaluate(() => app.expireSession());
            const fresh = getQuality(page);
            await page.locator('#password').fill(fixture.password);
            await page.locator('#loginSubmit').click();
            await currentSession(page);
            const data = await successful(await fresh, 'page');
            assert.notEqual(data.snapshot.token, first.snapshot.token);
            await ui.waitPatient(page, data.patients.items[0].patient_id);
            release.resolve();
            await boundedWait(completed.promise, 'old identity failure did not settle');
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.equal(await page.evaluate(() => !!app.sessionExpired), false);
            assert(await page.evaluate(value => app.sessionEpoch > value, epoch));
            assert.equal(await page.locator('#loginScreen').isVisible(), false);
            ui.noLegacyOrWrites(ledger);
        } finally {
            release.resolve();
            await page.unroute(authPath);
        }
    });
}

async function ownerReassignment(browser, ui) {
    const admin = await privileged(browser);
    try {
        await withQuality(browser, ui, async (page, context, ledger) => {
            const owner = fixture.ownerPatientId;
            const objectPath = '/api/patients/' + encodeURIComponent(owner);
            const ownerIssues = response => {
                const url = new URL(response.url());
                return isQuality(url.href) && url.searchParams.get('view') === 'patient_issues'
                    && url.searchParams.get('owner_patient_id') === owner;
            };
            const overviewReads = () => ['attention', 'portal-access'].map(section =>
                page.waitForRequest(request => request.method() === 'GET'
                    && new URL(request.url()).pathname === objectPath + '/' + section));
            const finishOverviewReads = async requests => {
                await Promise.all(requests.map(async pending => {
                    const request = await pending;
                    const response = await boundedWait(request.response(), 'owner Overview response was not received');
                    assert.equal(response?.status(), 200, 'owner Overview read completed before reassignment');
                    assert.equal(await boundedWait(response.finished(), 'owner Overview response did not finish'), null);
                }));
            };

            const initialReads = overviewReads();
            const first = page.waitForResponse(ownerIssues);
            await (await ui.waitPatient(page, owner)).click();
            await successful(await first, 'patient_issues');
            await finishOverviewReads(initialReads);
            await ui.action(ui.section(page, 'issues', '#patientQualityBlock'), 'finding').first()
                .waitFor({ state: 'visible' });
            await page.getByRole('tab', { name: 'Данные', exact: true }).click();
            const phone = page.locator('#patientPanels input[type="tel"]');
            await phone.fill('+70000000999');
            const epoch = await page.evaluate(() => app.sessionEpoch || 0);
            const overview = overviewReads();
            let reassignmentStarted = false;
            let assigned = 0;
            await page.route(qualityRequests, async route => {
                const query = new URL(route.request().url()).searchParams;
                if (query.get('view') === 'patient_issues' && query.get('owner_patient_id') === owner && !reassignmentStarted) {
                    reassignmentStarted = true;
                    // Finish the other audited Overview reads before changing ownership.
                    // Their concurrent release can lock the session with its own 409.
                    await finishOverviewReads(overview);
                    await page.waitForFunction(id => app.currentView === 'patient' && app.currentPatientId === id
                        && app.patientDetails.has(id) && [...app.sessionFieldDrafts.values()]
                            .some(value => value.patientId === id), owner);
                    const current = await api(admin, 'GET', objectPath);
                    assert.equal(current.status(), 200);
                    const expectedVersion = (await current.json()).version;
                    const changed = await api(admin, 'PUT', objectPath + '/treating-doctor', {
                        data: { userId: fixture.accountIds.hiddenDoctor, expectedVersion },
                    });
                    assert.equal(changed.status(), 200);
                    assigned++;
                }
                await route.continue();
            });
            const denied = page.waitForResponse(ownerIssues);
            await page.getByRole('tab', { name: 'Обзор', exact: true }).click();
            const reply = await denied;
            assert.equal(reply.status(), 404);
            assert.equal(assigned, 1, 'real offline-synthetic actor no longer owns the selected patient');
            await page.waitForFunction(id => app.currentView === 'patients' && app.currentPatientId === null
                && !app.patientDetails.has(id) && !app.patientRows.some(row => row.id === id)
                && ![...app.sessionFieldDrafts.values()].some(value => value.patientId === id), owner);
            assert.deepEqual(await page.evaluate(() => ({
                user: app.user.id, epoch: app.sessionEpoch || 0, expired: !!app.sessionExpired,
            })), { user: fixture.accountIds.doctor, epoch, expired: false });
            assert.equal(await page.locator('#loginScreen').isVisible(), false);
            assert.equal(await page.locator('#patientQualityBlock, #patientPanels input[type="tel"]').count(), 0);
            assert.equal(ledger.quality.filter(row => row.view === 'patient_issues').length, 2);
            ui.noLegacyOrWrites(ledger);
        }, fixture.accounts.doctor);
    } finally {
        await admin.close();
    }
}

async function clinicalNavigation(browser, ui) {
    await withQuality(browser, ui, async (page, context, ledger) => {
        const filtered = await successful(await ui.changeSearch(page, ownerName), 'page');
        assert.equal(filtered.patients.items[0].patient_id, fixture.ownerPatientId);
        await (await ui.waitPatient(page, fixture.ownerPatientId)).click();
        await page.waitForFunction(id => app.currentPatientId === id && app.currentView === 'patient', fixture.ownerPatientId);
        await page.getByRole('tab', { name: 'События и даты', exact: true }).click();
        const note = page.getByRole('textbox', { name: 'Примечание к этапу', exact: true }).first();
        await note.fill('Синтетический черновик до перехода в Quality');
        await qualityView(page);
        await page.locator('#confirmModal').waitFor({ state: 'visible' });
        await page.locator('#confirmCancelBtn').click();
        assert.equal(await note.inputValue(), 'Синтетический черновик до перехода в Quality');
        assert.equal(await page.evaluate(() => app.currentTab), 'events');
        assert.equal(ledger.writes, 0);

        const held = arm();
        const release = arm();
        await page.route('**/api/patients/**/note', async route => {
            if (route.request().method() !== 'PATCH') return route.continue();
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            held.resolve();
            await release.promise;
            return route.fulfill({ response });
        });
        try {
            await page.getByRole('button', { name: 'Сохранить заметку', exact: true }).first().click();
            await boundedWait(held.promise, 'explicit synthetic note save did not reach server');
            await qualityView(page);
            assert.equal(await page.evaluate(() => app.currentView), 'patient');
            assert.equal(ledger.writes, 1, 'only the one explicit clinical save');
        } finally {
            release.resolve();
        }
        await page.waitForFunction(() => !app.clinicalWriteInFlight);
        await page.unroute('**/api/patients/**/note');
        assert.equal(ledger.legacyQuality, 0);
        assert.equal(ledger.fullRegistry, 0);
    });
}

module.exports = async function verify(browser, results, ui) {
    await superseded(browser, ui, false);
    await superseded(browser, ui, true);
    results.faultChecks.push('late real 200 cannot replace newer 200 or synthetic terminal 503');
    for (const [status, code] of [[409, 'PATIENT_QUERY_CHANGED'], [410, 'CURSOR_EXPIRED']]) {
        await restart(browser, ui, status, code, false);
        await restart(browser, ui, status, code, true);
        results.faultChecks.push(`injected ${status} ${code}: one restart and terminal repeated failure`);
    }
    for (const status of [403, 404]) await denial(browser, ui, status);
    results.faultChecks.push('injected 403 and neutral 404 do not render actionable member rows or retry');
    await clinicalNavigation(browser, ui);
    results.faultChecks.push('actual pending clinical write blocks navigation; cancel retains draft; only explicit save');
    await peerIdentity(browser, ui);
    results.faultChecks.push('real two-tab identity change rejects held old actor body');
    await staleIdentityFailure(browser, ui);
    results.faultChecks.push('delayed failure of an old identity check cannot lock a freshly authenticated epoch');
    await liveAuthorization(browser, ui, '401');
    await liveAuthorization(browser, ui, '409');
    results.faultChecks.push('real 401 and real access-context 409 lock, re-auth and clear old rows without restart');
    await ownerReassignment(browser, ui);
    results.faultChecks.push('real same-session owner 404 clears opened card, derived rows and existing draft without reauth');
};
