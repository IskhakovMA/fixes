"""Add allowlisted observations to the exact synthetic history scenario."""
from pathlib import Path

target = Path("tools/tests/wp_i_card/history.cjs")
source = target.read_text()
start = source.index("async function unknownDenial(")
stop = source.index("async function holdUnknownStay(", start)
scenario = source[start:stop]


def insert(old, new):
    global scenario
    if scenario.count(old) != 1:
        raise ValueError("unexpected history diagnostic anchor")
    scenario = scenario.replace(old, new)


insert("        const events = monitor(page);", """        const events = monitor(page);
        const started = performance.now();
        let sequence = 0;
        const emit = label => console.log('I9_HD=' + (++sequence) + ' ' +
            Math.round(performance.now() - started) + ' ' + label);
        const annotate = request => {
            const url = new URL(request.url());
            if (url.origin !== origin || request.method() !== 'GET') return null;
            if (url.pathname === '/api/patients/' + fixture.large.id) return 'detail';
            if (url.pathname === '/api/patients' && url.searchParams.get('view') === 'page')
                return url.searchParams.has('q') ? 'search' : 'registry';
            if (url.pathname === '/api/auth/me') return 'identity';
            return null;
        };
        page.on('request', request => {
            const type = annotate(request);
            if (type) emit('request-' + type);
        });
        page.on('response', response => {
            const type = annotate(response.request());
            if (type) emit('response-' + type + '-' + response.status());
        });
        page.on('requestfailed', request => {
            const type = annotate(request);
            if (type) emit('failed-' + type);
        });
        const state = async label => {
            const bits = await page.evaluate(() => [
                app.currentView === 'patients', Boolean(app.currentPatientId),
                app.sessionExpired, app.sessionReconciling, Boolean(app.user),
                document.activeElement?.matches('#view-patients h1') ?? false,
                document.querySelector('#confirmModal')?.getAttribute('aria-hidden') === 'false',
            ].map(Number).join(''));
            emit(label + '-' + bits);
        };""")
for old, label in [
    ("await login(page, fixture.roles.doctor.username);", "logged-in"),
    ("await openFromRegistry(page, fixture.large.name);", "card-open"),
    ("await screen(page, 'patient', 'events');", "events-open"),
    ("const previous = await prepareUnknownForward(page, 'events');", "unknown-dialog"),
    ("assert(await rowPresent(), 'the pre-revocation registry still contains the fixture row');", "revoked"),
    ("await page.locator('#confirmCancelBtn').click();", "clicked-stay"),
    ("await (await denied).finished();", "denied-finished"),
    ("const registry = await screen(page, 'patients', null, true);", "registry-focused"),
    ("await reloadStarted.promise;", "held-arrived"),
    ("await (await reloaded).finished();", "registry-finished"),
]:
    insert(old, old + "\n        await state('" + label + "');")
insert("            const response = await route.fetch();", """            emit('held-start-' + annotate(route.request()));
            const response = await route.fetch();
            emit('held-status-' + response.status());""")
insert("            await route.fulfill({response});", """            await route.fulfill({response});
            emit('held-fulfilled');""")
target.write_text(source[:start] + scenario + source[stop:])
