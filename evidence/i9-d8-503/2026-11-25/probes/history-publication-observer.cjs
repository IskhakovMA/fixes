const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const load = Module._extensions['.cjs'] || Module._extensions['.js'];

// A read-only observer for the exact browser test's waiting point.
Module._extensions['.cjs'] = (module, filename) => {
    if (!filename.endsWith('/tools/tests/wp_i_card/history.cjs')) return load(module, filename);
    let source = fs.readFileSync(filename, 'utf8');
    const marker = "        const events = monitor(page);\n        await page.addInitScript(() => {";
    assert.equal(source.split(marker).length, 2);
    source = source.replace(marker, `
        const events = monitor(page);
        const pending = new Map();
        let totalCompleted = 0;
        let lastNetworkEvent = performance.now();
        const requestsInWait = new Map();
        let watchingIdle = false;
        page.on('request', request => {
            const parts = new URL(request.url()).pathname.split('/');
            const routeClass = parts[1] === 'api' ? parts.slice(1,3).join('/') : request.resourceType();
            pending.set(request, [request.method(), routeClass]);
            lastNetworkEvent = performance.now();
            if (watchingIdle) requestsInWait.set(routeClass, (requestsInWait.get(routeClass) || 0) + 1);
        });
        for (const name of ['requestfinished', 'requestfailed']) page.on(name, request => {
            pending.delete(request);
            totalCompleted++;
            lastNetworkEvent = performance.now();
        });
        await page.addInitScript(() => {`);
    const wait = "        await page.waitForLoadState('networkidle');";
    const endpoint = wait + "\n        await screen(page, 'calendar');";
    assert.equal(source.split(endpoint).length, 2);
    source = source.replace(endpoint, `
        let idleReached = false;
        const waitStarted = performance.now();
        watchingIdle = true;
        try {
${wait}
            idleReached = true;
        } finally {
            watchingIdle = false;
            const waitedMs = Math.round(performance.now() - waitStarted);
            const lastNetworkEventAgeMs = Math.round(performance.now() - lastNetworkEvent);
            const workspace = await page.evaluate(() => ({
                calendarSelected: app.currentView === 'calendar',
                patientHidden: document.getElementById('view-patient').classList.contains('is-hidden'),
                sessionExpired: Boolean(app.sessionExpired),
                noPatientSelected: app.currentPatientId == null,
                historyIndex: history.state?.index,
                historyVersion: history.state?.v,
                historyKeys: Object.keys(history.state || {}).sort(),
                screenCalendarInUrl: new URL(location.href).searchParams.get('screen') === 'calendar',
                appReady: Boolean(app.appReady),
                sessionReconciling: Boolean(app.sessionReconciling),
            }));
            fs.writeFileSync(path.join(out, 'history-idle-observer.json'), JSON.stringify({
                idleReached, pending: [...pending.values()], totalCompleted, workspace,
                waitedMs, lastNetworkEventAgeMs, requestsInWait: Object.fromEntries(requestsInWait),
            }, null, 2));
        }
        await screen(page, 'calendar');`);
    module._compile(source, filename);
};
