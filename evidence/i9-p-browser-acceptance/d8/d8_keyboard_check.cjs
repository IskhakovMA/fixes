#!/usr/bin/env node
// Exact synthetic D8 stand only. This records Chromium focus checks, never VoiceOver observations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
let checkpoint = 'fixture';

async function main() {
    const [origin, fixtureFile] = process.argv.slice(2);
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const stat = fs.statSync(fixtureFile);
    assert(stat.isFile() && stat.mode % 512 === 0o600);
    const fixture = JSON.parse(fs.readFileSync(fixtureFile));
    assert(fixture.syntheticOnly === true && fixture.baseURL + '/' === origin && fixture.count === 240);
    checkpoint = 'browser-launch';
    const browser = await chromium.launch({ headless: true });
    const checks = [];
    try {
        for (const theme of ['light', 'dark']) {
            const context = await browser.newContext({
                colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block',
                viewport: { width: 1440, height: 960 },
            });
            try {
                let outboundBlocked = 0, unexpectedMutations = 0, authActivity = 0, pageErrors = 0;
                await context.route('**/*', route => {
                    if (new URL(route.request().url()).origin !== new URL(origin).origin) {
                        outboundBlocked++;
                        return route.abort();
                    }
                    return route.continue();
                });
                const page = await context.newPage();
                page.setDefaultTimeout(7000);
                page.on('pageerror', () => pageErrors++);
                page.on('request', req => {
                    const path = new URL(req.url()).pathname;
                    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return;
                    if (req.method() === 'POST' && path === '/api/auth/activity') {
                        authActivity++;
                    } else if (req.method() !== 'POST' || path !== '/api/auth/login') {
                        unexpectedMutations++;
                    }
                });
                checkpoint = 'navigate';
                await page.goto(origin, { waitUntil: 'domcontentloaded' });
                checkpoint = 'sign-in';
                await page.locator('#username').fill(fixture.accounts.doctor);
                await page.locator('#password').fill(fixture.password);
                await page.locator('#loginSubmit').click();
                await page.waitForFunction(() => app.appReady && !app.sessionExpired && !app.sessionReconciling);
                checkpoint = 'theme';
                await page.evaluate(value => app.applyTheme(value), theme);
                checkpoint = 'skip-focus';
                await page.getByRole('link', {name: 'Перейти к содержимому'}).focus();
                await page.keyboard.press('Enter');
                await page.waitForFunction(() => document.activeElement?.id === 'workspaceMain');
                checkpoint = 'open-card';
                await page.locator('#patientsBody .patient-open').first().click();
                const selected = async id => {
                    await page.waitForFunction(tab => {
                        const el = document.getElementById('tab-' + tab);
                        const panel = document.getElementById('patientPanels');
                        return el === document.activeElement && el?.getAttribute('aria-selected') === 'true'
                            && el.getAttribute('aria-controls') === panel?.id
                            && panel.getAttribute('aria-labelledby') === el.id;
                    }, id);
                };
                checkpoint = 'overview';
                await page.locator('#tab-overview').focus();
                await selected('overview');
                for (const [key, tab] of [['ArrowRight', 'notifications'], ['ArrowLeft', 'overview'],
                                          ['End', 'history'], ['Home', 'overview']]) {
                    checkpoint = 'navigation-keys';
                    await page.keyboard.press(key);
                    await selected(tab);
                }
                checkpoint = 'tab-exit-return';
                await page.keyboard.press('Tab');
                await page.waitForFunction(() => !document.activeElement?.closest('#patientTabs'));
                await page.keyboard.press('Shift+Tab');
                await selected('overview');
                checkpoint = 'outbound-counter';
                assert.equal(outboundBlocked, 0);
                checkpoint = 'unauthorized-mutation-counter';
                assert.equal(unexpectedMutations, 0);
                checkpoint = 'page-error-counter';
                assert.equal(pageErrors, 0);
                checks.push({ theme, skipMainFocus: true, arrowsHomeEndFocus: true,
                              labelledPanel: true, tabExitAndReturn: true, unexpectedMutations,
                              outboundBlocked, authActivity, pageErrors });
            } finally {
                await context.close();
            }
        }
        process.stdout.write(JSON.stringify({ browser: 'Chromium', version: browser.version(), checks }));
    } finally {
        await browser.close();
    }
}
main().catch(error => {
    // Keep paths, URLs, fixture contents and selectors out of the automatic receipt.
    process.stderr.write('D8 keyboard check stopped: ' + checkpoint + ' ' + error.name + '\n');
    process.exitCode = 1;
});
