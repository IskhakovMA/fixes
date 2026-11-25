'use strict';

// Run with the authorized synthetic WP-H release-race fixture only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WP_H_ORIGIN;
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const isRegistryPage = request => {
    const url = new URL(request.url());
    return request.method() === 'GET' && url.pathname === '/api/patients' && url.searchParams.get('view') === 'page';
};

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-pager-zoom-'));
    const extension = path.join(root, 'extension');
    fs.mkdirSync(extension, {mode: 0o700});
    fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: 'Clinic synthetic native tab zoom', version: '1.0', permissions: ['tabs'],
        background: {service_worker: 'worker.js'},
    }));
    fs.writeFileSync(path.join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    const checks = [];
    let context;
    let control;
    try {
        context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
            headless:true, executablePath:process.env.WP_H_FULL_CHROMIUM || chromium.executablePath(),
            viewport:null, ignoreDefaultArgs:['--disable-extensions'],
            args:['--window-size=1280,1000', '--disable-extensions-except=' + extension, '--load-extension=' + extension],
        });
        const page = context.pages()[0] || await context.newPage();
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        control = context.request;
        let queue = Promise.resolve();
        let observed = false;
        let responses = [];
        let writes = 0;
        await context.route('**/*', route => {
            const location = new URL(route.request().url());
            if (location.origin !== origin) return route.abort('blockedbyclient');
            if (!location.pathname.startsWith('/api/')) return route.continue();
            const forwarded = queue.then(async () => {
                const req = route.request();
                if (observed && !['GET','HEAD'].includes(req.method()) && location.pathname !== '/api/auth/activity') writes++;
                const response = await route.fetch();
                if (observed && isRegistryPage(req)) {
                    responses.push(response.status());
                    if (response.status() === 409) {
                        const refusal = await response.json();
                        assert.equal(refusal.code, 'PATIENT_QUERY_CHANGED');
                        assert(!('patients' in refusal), 'refusal must not carry rows');
                    }
                }
                await route.fulfill({response});
            });
            queue = forwarded.catch(() => {});
            return forwarded;
        });
        const ready = () => page.waitForFunction(()=>app.appReady && !app.sessionExpired && app.patientListState === 'ready' && !app.pageLoading);
        const race = async mode => {
            const response = await control.post(origin + '/synthetic/wph/release-race',{data:{mode}});
            assert.equal(response.status(), 200);
        };
        await page.goto(origin);
        await page.locator('#username').fill(process.env.P_FAULT_SYNTHETIC_USER);
        await page.locator('#password').fill(process.env.P_FAULT_SYNTHETIC_PASSWORD);
        await page.locator('#loginSubmit').click();
        await ready();
        await page.evaluate(()=>clearInterval(app.internalNotifications.pollTimer));
        await queue;
        const axe = process.env.AXE_SOURCE;
        assert(axe, 'Set AXE_SOURCE to the vetted installed axe-core script');
        await page.evaluate(fs.readFileSync(axe,'utf8'));
        for (const theme of ['light','dark']) {
            await page.evaluate(theme => app.applyTheme(theme), theme);
            for (const factor of [1,2,4]) {
                const zoom = await worker.evaluate(async ({origin,factor}) => {
                    const tab = (await chrome.tabs.query({})).find(item=>item.url.startsWith(origin+'/'));
                    if (!tab) throw new Error('Synthetic source tab missing');
                    await chrome.tabs.setZoom(tab.id,factor);
                    return chrome.tabs.getZoom(tab.id);
                },{origin,factor});
                assert.equal(Math.round(zoom*100),factor*100);
                await page.waitForFunction(factor=>Math.abs(devicePixelRatio-factor)<0.01,factor);
                await race('always');
                await queue;
                responses=[];
                writes=0;
                observed=true;
                await page.getByRole('button',{name:'Следующая страница',exact:true}).focus();
                await page.keyboard.press('Enter');
                await page.waitForFunction(()=>app.patientListState==='error'&&!app.pageLoading);
                await queue;
                assert.deepEqual(responses,[409,409]);
                const snapshot = await page.evaluate(() => {
                    const retry=document.getElementById('retryPatientListBtn');
                    const rect=retry.getBoundingClientRect();
                    const obsolete=document.getElementById('patientRegistryResults');
                    return {active:document.activeElement===retry,width:innerWidth,dpr:devicePixelRatio,
                        visualScale:visualViewport.scale,overflow:document.documentElement.scrollWidth>innerWidth,
                        inViewport:rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth,
                        hiddenOld:obsolete.hidden&&obsolete.inert,
                        described:retry.getAttribute('aria-describedby')==='patientListErrorText'};
                });
                assert(snapshot.active&&snapshot.hiddenOld&&snapshot.described&&snapshot.inViewport);
                assert.equal(snapshot.visualScale,1);
                assert.equal(snapshot.overflow,false);
                if (factor===4) assert.equal(snapshot.width,320);
                assert.equal(await page.getByRole('button',{name:'Обновить список',exact:true}).count(),1);
                await page.keyboard.press('Shift+Tab');
                assert(await page.evaluate(()=>!document.activeElement.closest('#patientRegistryResults')));
                await page.keyboard.press('Tab');
                assert(await page.evaluate(()=>document.activeElement.id==='retryPatientListBtn'));
                await queue;
                assert.deepEqual(responses,[409,409]);
                const violations=await page.evaluate(async()=>
                    (await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}))
                    .violations.map(rule=>rule.id));
                assert.deepEqual(violations,[]);
                assert.equal(writes,0);
                const measuredStatuses=[...responses];
                await race('none');
                await page.keyboard.press('Enter');
                await ready();
                await queue;
                assert.deepEqual(responses,[409,409,200]);
                assert.equal(writes,0);
                observed=false;
                checks.push({theme,zoomPercent:Math.round(zoom*100),...snapshot,violations,
                    automaticStatuses:measuredStatuses,explicitRetryStatus:responses[2],clinicalWrites:writes});
            }
        }
        process.stdout.write(JSON.stringify({syntheticOnly:true,browser:context.browser()?.version(),
            nativeChromeTabZoom:true,checks},null,2)+'\n');
    } finally {
        if (context) await context.close();
        fs.rmSync(root,{recursive:true,force:true});
    }
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
