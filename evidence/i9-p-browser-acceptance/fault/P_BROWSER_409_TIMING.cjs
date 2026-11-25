// Synthetic diagnostic only. Start exact-B1 tools/tests/wp_h/server.py with count=1000.
// No response bodies, authorization data, patient identities or URLs are recorded.
'use strict';
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WP_H_ORIGIN;
const identity = process.env.P_FAULT_SYNTHETIC_USER;
const passphrase = process.env.P_FAULT_SYNTHETIC_PASSWORD;
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
assert(identity && passphrase);
const isPage = request => {
    const url = new URL(request.url());
    return request.method() === 'GET' && url.pathname === '/api/patients' &&
        url.searchParams.get('view') === 'page';
};
const round = value => Math.round(value * 100) / 100;
async function main() {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
    try {
        const context = await browser.newContext({ reducedMotion: 'reduce' });
        const control = await browser.newContext();
        const page = await context.newPage();
        let queue = Promise.resolve();
        // Forward actual API results in deterministic order to isolate the
        // test-triggered release race from unrelated audit/activity traffic.
        await page.route('**/api/**', route => {
            const request = queue.then(async () => {
                const response = await route.fetch();
                await route.fulfill({ response });
            });
            queue = request.catch(() => {});
            return request;
        });
        let writes = 0;
        page.on('request', request => {
            if (new URL(request.url()).pathname.startsWith('/api/patients') &&
                !['GET', 'HEAD'].includes(request.method())) writes++;
        });
        let active = null;
        page.on('request', request => {
            if (active && isPage(request)) active.requests++;
        });
        page.on('response', response => {
            if (active && isPage(response.request())) {
                active.replies.push({ response, ms: performance.now() - active.started });
            }
        });
        const auth = await control.request.post(origin + '/api/auth/login', {
            data: { username: identity, password: passphrase }
        });
        assert.equal(auth.status(), 200);
        await page.goto(origin);
        await page.locator('#username').fill(identity);
        await page.locator('#password').fill(passphrase);
        await page.locator('#loginSubmit').click();
        const settled = () => page.waitForFunction(() => app.appReady &&
            app.patientListState === 'ready' && !app.pageLoading);
        await settled();
        await page.evaluate(() => clearInterval(app.internalNotifications.pollTimer));
        await queue;
        const next = page.getByRole('button', { name: 'Следующая страница', exact: true });
        const checks = [];
        for (const mode of ['once', 'always']) {
            assert.equal((await control.request.post(origin + '/synthetic/wph/release-race', {
                data: { mode }
            })).status(), 200);
            active = { started: performance.now(), requests: 0, replies: [] };
            await next.focus();
            await page.keyboard.press('Enter');
            if (mode === 'once') {
                await page.waitForFunction(() => app.patientListState === 'ready' &&
                    !app.pageLoading && app.patientPage.page.offset === 0 &&
                    document.activeElement.id === 'patientPageStatus');
            } else {
                await page.locator('#patientListError').waitFor({ state: 'visible' });
                await page.waitForFunction(() => !app.pageLoading);
                assert(!await page.locator('#patientRegistryResults').isVisible());
            }
            const uiMs = performance.now() - active.started;
            const focusAtFinalUI = await page.evaluate(() => ({
                id: document.activeElement.id || null,
                onDocumentBody: document.activeElement === document.body
            }));
            let tabsToExplicitRetry = null;
            if (mode === 'always') {
                assert(!await page.evaluate(() => document.activeElement.closest('#patientRegistryResults')));
                tabsToExplicitRetry = 0;
                while (!await page.evaluate(() => document.activeElement.id === 'retryPatientListBtn')) {
                    assert(tabsToExplicitRetry < 60, 'explicit retry must be reachable through the keyboard');
                    await page.keyboard.press('Tab');
                    tabsToExplicitRetry++;
                }
            }
            const { requests, replies } = active;
            active = null;
            assert.equal(requests, 2);
            assert.deepEqual(replies.map(item => item.response.status()), mode === 'once' ? [409, 200] : [409, 409]);
            for (const item of replies.filter(item => item.response.status() === 409)) {
                const body = await item.response.json();
                assert.equal(body.code, 'PATIENT_QUERY_CHANGED');
                assert(!('patients' in body));
            }
            assert.equal(writes, 0);
            assert.equal(await page.locator('#view-patients').getAttribute('aria-busy'), 'false');
            checks.push({
                mode, observedResponses: replies.map(item => item.response.status()),
                requests, noPatientPayloadIn409: true, noAutomaticMedicalWrite: true,
                actionToFinalUI_ms: round(uiMs), first409ToFinalUI_ms: round(uiMs - replies[0].ms),
                focusAtFinalUI, tabsToExplicitRetry,
                ariaBusyCleared: true
            });
            if (mode === 'always') {
                assert.equal((await control.request.post(origin + '/synthetic/wph/release-race', {
                    data: { mode: 'none' }
                })).status(), 200);
                await page.keyboard.press('Enter');
                await settled();
                assert.equal(writes, 0);
            }
        }
        await queue;
        await page.unrouteAll({ behavior: 'wait' });
        await context.close();
        await control.close();
        console.log(JSON.stringify({
            browserVersion: browser.version(), kind: 'server-fault-injection-patient-update',
            syntheticOnly: true, functionalCases: checks, natural409Sample: 0,
            UX_SLO: 'INSUFFICIENT'
        }, null, 2));
    } finally {
        await browser.close();
    }
}
main().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
});
