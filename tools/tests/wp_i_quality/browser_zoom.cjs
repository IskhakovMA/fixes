// Chromium tab zoom in a disposable local profile, with only a synthetic app origin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium, fixture, getQuality, login, qualityView, receipt, setupBounded, successful } = require('./browser_helpers.cjs');

async function main() {
    const profileHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-quality-native-zoom-'));
    const extension = path.join(profileHome, 'extension');
    fs.mkdirSync(extension);
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Synthetic app zoom check', version: '1.0', permissions: ['tabs'],
        background: { service_worker: 'worker.js' },
    }));
    fs.writeFileSync(path.join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    let context;
    let phase = 'launch-persistent-context';
    const samples = [];
    try {
        context = await chromium.launchPersistentContext(path.join(profileHome, 'profile'), {
            headless: true, executablePath: process.env.WP_H_FULL_CHROMIUM || chromium.executablePath(),
            viewport: null, ignoreDefaultArgs: ['--disable-extensions'],
            args: ['--window-size=1280,1000', '--disable-extensions-except=' + extension, '--load-extension=' + extension],
        });
        phase = 'login-and-load-quality-page';
        const page = await context.newPage();
        await page.bringToFront();
        await login(page, fixture.accounts.developer);
        await setupBounded(page);
        const response = getQuality(page);
        await qualityView(page);
        const data = await successful(await response, 'page');
        const workspace = page.locator('#qualityV1Workspace');
        const patients = workspace.locator('[data-quality-part="patients"]');
        const rows = patients.locator('[data-quality-action="patient"]');
        await rows.first().waitFor({ state: 'visible' });
        assert.equal(data.patients.page.limit, 50);
        assert.equal(data.patients.items.length, 50);
        const expectedIds = data.patients.items.map(row => row.patient_id);
        const actions = [
            [workspace.locator('[data-quality-action="apply"]'), true],
            [workspace.locator('[data-quality-action="reset"]'), true],
            [patients.locator('[data-quality-action="previous"]'), false],
            [patients.locator('[data-quality-action="next"]'), true],
        ];
        const axeSource = process.env.AXE_SOURCE;
        assert(axeSource, 'AXE_SOURCE is required for the native zoom suite');
        await page.evaluate(fs.readFileSync(axeSource, 'utf8'));
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        for (const theme of ['light', 'dark']) {
            await page.evaluate(value => app.applyTheme(value), theme);
            for (const factor of [1, 2, 4]) {
                phase = `theme=${theme} nativeZoom=${factor * 100}`;
                const zoom = await worker.evaluate(async ({ origin, factor }) => {
                    const tab = (await chrome.tabs.query({})).find(item => item.url.startsWith(origin + '/'));
                    if (!tab) throw new Error('Synthetic app tab missing');
                    await chrome.tabs.setZoom(tab.id, factor);
                    return chrome.tabs.getZoom(tab.id);
                }, { origin: fixture.baseURL, factor });
                assert.equal(Math.round(zoom * 100), factor * 100);
                await page.waitForFunction(f => Math.abs(devicePixelRatio - f) < 0.01, factor);
                const geometry = await workspace.evaluate(element => ({
                    theme: document.documentElement.dataset.theme,
                    width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale,
                    overflow: document.documentElement.scrollWidth > innerWidth,
                    contentWidth: element.clientWidth, contentScrollWidth: element.scrollWidth,
                    contentLeft: element.getBoundingClientRect().left,
                    contentRight: element.getBoundingClientRect().right,
                }));
                assert.equal(geometry.theme, theme);
                assert.equal(geometry.overflow, false);
                assert.equal(geometry.scale, 1);
                assert(geometry.contentWidth > 0 && geometry.contentLeft >= -1);
                assert(geometry.contentScrollWidth <= geometry.contentWidth + 1);
                assert(geometry.contentRight <= geometry.width + 1);
                if (factor === 4) assert.equal(geometry.width, 320);
                assert.deepEqual(await rows.evaluateAll(items => items.map(row => row.dataset.patientId)), expectedIds);
                for (const [index, item] of data.patients.items.entries()) {
                    assert(item.patient_name.trim(), `synthetic patient name ${index + 1}`);
                    const namedRow = rows.nth(index).and(patients.getByRole('button', {
                        name: item.patient_name, exact: true,
                    }));
                    assert.equal(await namedRow.count(), 1, `accessible patient name ${index + 1}`);
                }

                for (const [action, enabled] of actions) {
                    assert(await action.isVisible(), 'filter or pager action is visible');
                    assert.equal(await action.isEnabled(), enabled);
                }

                const [apply, reset, previous, next] = actions.map(([action]) => action);
                for (const [action, label] of [
                    [apply, 'Применить'], [reset, 'Сбросить'],
                    [previous, 'Назад · Пациенты'], [next, 'Далее · Пациенты'],
                ]) {
                    assert.equal(await action.and(workspace.getByRole('button', { name: label, exact: true })).count(), 1);
                }
                const assertFocus = async (locator, label) => {
                    assert(await locator.evaluate(element => {
                        const bounds = element.getBoundingClientRect();
                        return document.activeElement === element && bounds.width > 0 && bounds.height > 0 &&
                            bounds.left >= -1 && bounds.right <= innerWidth + 1 &&
                            bounds.bottom > 0 && bounds.top < innerHeight;
                    }), label);
                };
                const pressAndCheck = async (key, locator, label) => {
                    await page.keyboard.press(key);
                    await assertFocus(locator, label);
                };
                await apply.focus();
                await pressAndCheck('Tab', reset, 'Tab reaches Reset');
                for (let index = 0; index < expectedIds.length; index++) {
                    await pressAndCheck('Tab', rows.nth(index), `Tab reaches patient ${index + 1}`);
                }
                await pressAndCheck('Tab', next, 'Tab reaches Next');
                for (let index = expectedIds.length - 1; index >= 0; index--) {
                    await pressAndCheck('Shift+Tab', rows.nth(index), `Shift+Tab reaches patient ${index + 1}`);
                }
                await pressAndCheck('Shift+Tab', reset, 'Shift+Tab reaches Reset');
                await pressAndCheck('Shift+Tab', apply, 'Shift+Tab reaches Apply');

                const violations = await page.evaluate(async () => {
                    const result = await axe.run(document, {
                        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
                    });
                    return result.violations.map(rule => rule.id);
                });
                console.log(JSON.stringify({ theme, factor, axeViolations: violations }));
                assert.deepEqual(violations, [], 'automated WCAG A/AA check');
                samples.push({ ...geometry, factor, namedRows: 50, tabRows: 50, shiftTabRows: 50, violations });
            }
        }
        receipt('browser-native-zoom.json', { syntheticOnly: true, nativeChromeZoom: true, samples });
        console.log(JSON.stringify({ nativeChromeZoom: true, samples }));
    } catch (error) {
        console.error(`Quality native zoom failed at ${phase}`);
        throw error;
    } finally {
        if (context) await context.close();
        fs.rmSync(profileHome, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
});
