// Load only with the repository's local clinical FastAPI fixture and locked Chromium.
// Add a browser transport control without altering tracked source or old assertions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const load = Module._extensions['.cjs'] || Module._extensions['.js'];

Module._extensions['.cjs'] = (module, filename) => {
    if (!filename.endsWith('/tools/tests/wp_i_card/clinical.cjs')) return load(module, filename);
    const source = fs.readFileSync(filename, 'utf8');
    const anchor = "// Placeholder creation confirmed, then PATCH fails";
    assert.equal(source.split(anchor).length, 2);
    const networkControl = `
const beforeAbort = writes;
const eventBeforeAbort = (await f.call('GET', '/api/patients/' + f.card.id)).history[0].events[0];
let abortedAtBrowser = 0;
await p.route(eventURL, async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    abortedAtBrowser++;
    await route.abort('connectionreset');
});
await setField(date(), '2006-08-08');
await p.getByRole('button', {name:'Сохранить: Плановая дата', exact:true}).first().click();
await p.waitForFunction(() => [...document.querySelectorAll('.clinical-save-status')]
    .some(n => n.textContent.includes('Результат записи')));
await retained(date(), '2006-08-08');
assert.equal(writes, beforeAbort + 1);
assert.equal(abortedAtBrowser, 1);
const eventAfterAbort = (await f.call('GET', '/api/patients/' + f.card.id)).history[0].events[0];
assert.equal(eventAfterAbort.version, eventBeforeAbort.version);
assert.equal(eventAfterAbort.date, eventBeforeAbort.date);
await p.unroute(eventURL);
checks.push('browser abort before forwarding PATCH: original version and server state intact, draft retained, no resend');
await discard();
`;
    module._compile(source.replace(anchor, networkControl + anchor), filename);
};
