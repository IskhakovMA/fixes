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
        page.on('request', request => {
            const parts = new URL(request.url()).pathname.split('/');
            pending.set(request, [request.method(), parts[1] === 'api' ? parts.slice(1,3).join('/') : request.resourceType()]);
        });
        for (const name of ['requestfinished', 'requestfailed']) page.on(name, request => {
            pending.delete(request);
            totalCompleted++;
        });
        await page.addInitScript(() => {`);
    const wait = "        await page.waitForLoadState('networkidle');";
    const endpoint = wait + "\n        await screen(page, 'calendar');";
    assert.equal(source.split(endpoint).length, 2);
    source = source.replace(endpoint, `
        let idleReached = false;
        try {
${wait}
            idleReached = true;
        } finally {
            const workspace = await page.evaluate(() => ({
                calendarSelected: app.currentView === 'calendar',
                patientHidden: document.getElementById('view-patient').classList.contains('is-hidden'),
                sessionExpired: Boolean(app.sessionExpired),
            }));
            fs.writeFileSync(path.join(out, 'history-idle-observer.json'), JSON.stringify({
                idleReached, pending: [...pending.values()], totalCompleted, workspace,
            }, null, 2));
        }
        await screen(page, 'calendar');`);
    module._compile(source, filename);
};
