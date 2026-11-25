'use strict';
// Observer-only instrumentation of browser fetch/focus, with no payload capture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.WP_H_ORIGIN;
const username = process.env.P_FAULT_SYNTHETIC_USER;
const password = process.env.P_FAULT_SYNTHETIC_PASSWORD;
const expectedFix = process.env.EXPECT_FOCUS === '1';
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const path = req => new URL(req.url()).pathname;
const registry = req => req.method() === 'GET' && path(req) === '/api/patients' &&
    new URL(req.url()).searchParams.get('view') === 'page';
const round = n => Math.round(n * 100) / 100;
async function runCase(browser, kind, width = 1440, theme = 'light') {
    const context = await browser.newContext({ viewport: {width, height:900}, reducedMotion:'reduce' });
    const control = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.addInitScript(() => {
            const active = el => el?.id || (el?.closest?.('#patientPagination') ? 'pagination-button' : el?.tagName) || null;
            const publish = (kind, extra = {}) => {
                if (!window.focusProbe) return;
                const state = typeof app === 'undefined' ? {} : {
                    epoch: app.sessionEpoch || 0, revision: app.readVersions?.patients || 0,
                    stage: app.patientListState, scope: app.currentView,
                    dirty: Boolean(app.patientListDirty), reconciling: Boolean(app.sessionReconciling),
                };
                window.focusProbe.push({t:Math.round(performance.now()), kind, ...state,
                    target:active(document.activeElement), focused:document.hasFocus(),
                    visibility:document.visibilityState, ...extra});
            };
            const original = window.fetch;
            window.fetch = (...args) => {
                const p = new URL(args[0], location.href);
                if (p.pathname === '/api/patients' && p.searchParams.get('view') === 'page') {
                    const frames = new Error().stack?.split('\n').slice(1).map(frame =>
                        frame.match(/^\s*at ([\w.<>{}]+)(?:\s|$)/)?.[1]).filter(Boolean);
                    publish('registry-fetch', {cursor:p.searchParams.has('cursor'), frames});
                }
                if (p.pathname === '/api/auth/me') publish('session-read');
                return original(...args);
            };
            for (const name of ['focusin','focusout']) {
                document.addEventListener(name, e => publish(name,{element:active(e.target),related:active(e.relatedTarget)}), true);
            }
            for (const name of ['focus','blur']) {
                window.addEventListener(name, e => { if (e.target === window) publish('window-'+name); });
            }
            document.addEventListener('visibilitychange', () => publish('visibilitychange'));
        });
        const auth = await control.request.post(origin+'/api/auth/login',{data:{username,password}});
        assert.equal(auth.status(),200);
        assert.equal((await control.request.post(origin+'/synthetic/wph/release-race',{data:{mode:'none'}})).status(),200);
        let queue = Promise.resolve();
        let count = 0;
        let holdResolve;
        let firstHeld;
        let firstFetched;
        const reached = new Promise(resolve => { firstFetched=resolve; });
        const hold = new Promise(resolve => { holdResolve=resolve; });
        let active = false;
        let statuses = [];
        let writes = 0;
        const heldKinds = ['move-focus','move-back','modal','navigate','401','context','network','stale-200','repeat-enter','real-401'];
        await page.route('**/api/**', route => {
            const job = queue.then(async () => {
                const req=route.request();
                const observed = active && registry(req);
                if (observed) count++;
                if (active && !['GET','HEAD'].includes(req.method()) && path(req) !== '/api/auth/activity') writes++;
                if (observed && count === 2 && kind === '401') {
                    statuses.push(401);
                    await route.fulfill({status:401,contentType:'application/json',body:'{}'});
                } else if (observed && count === 2 && kind === 'context') {
                    statuses.push(409);
                    await route.fulfill({status:409,contentType:'application/json',body:'{"code":"ACCESS_CONTEXT_CHANGED"}'});
                } else if (observed && count === 2 && kind === 'network') {
                    statuses.push('transport-failure');
                    await route.abort('timedout');
                } else if (observed && count === 1 && kind === 'cursor') {
                    statuses.push(410);
                    await route.fulfill({status:410,contentType:'application/json',body:'{"code":"CURSOR_EXPIRED"}'});
                } else {
                    const res = await route.fetch();
                    if (observed) {
                        const status=res.status();
                        statuses.push(status);
                        if (status===409) {
                            const body=await res.json();
                            assert.equal(body.code,'PATIENT_QUERY_CHANGED');
                            assert(!('patients' in body));
                        }
                    }
                    if (observed && count===1 && heldKinds.includes(kind)) {
                        firstHeld = true;
                        firstFetched();
                        await hold;
                    }
                    await route.fulfill({response:res});
                }
            });
            queue=job.catch(()=>{});
            return job;
        });
        await page.goto(origin);
        await page.locator('#username').fill(username);
        await page.locator('#password').fill(password);
        await page.locator('#loginSubmit').click();
        await page.waitForFunction(()=>app.appReady && app.patientListState==='ready' && !app.pageLoading);
        await page.evaluate(theme=> app.applyTheme(theme),theme);
        await page.evaluate(()=>clearInterval(app.internalNotifications.pollTimer));
        await queue;
        let race='always';
        if (['single','401','context','network','cursor','real-401'].includes(kind)) race='once';
        if (['stale-200','cursor'].includes(kind)) race='none';
        assert.equal((await control.request.post(origin+'/synthetic/wph/release-race',{data:{mode:race}})).status(),200);
        await page.evaluate(()=>{window.focusProbe=[];});
        active=true;
        const trigger=page.getByRole('button',{name:'Следующая страница',exact:true});
        await trigger.focus();
        await page.keyboard.press('Enter');
        if (heldKinds.includes(kind)) {
            await reached;
            assert(firstHeld);
            if (kind==='move-focus' || kind==='move-back') await page.locator('#searchInput').focus();
            if (kind==='move-back') await page.locator('#patientRegistryTitle').focus();
            if (kind==='modal') await page.evaluate(()=>ui.openModal('confirmModal'));
            if (kind==='navigate' || kind==='stale-200') await page.locator('[data-view=calendar]').click();
            if (kind==='repeat-enter') await page.keyboard.press('Enter');
            if (kind==='real-401') {
                const token = (await context.cookies()).find(c=>c.name==='clinic_csrf').value;
                const logout = await context.request.post(origin+'/api/auth/logout', {headers:{'X-CSRF-Token':token}});
                assert(logout.ok());
            }
            holdResolve();
        }
        await page.waitForFunction(away=>app.sessionExpired || (!app.pageLoading && (away || app.patientListState!=='loading')),['navigate','stale-200'].includes(kind));
        await queue;
        const snapshot = () => page.evaluate(() => {
            const button=document.getElementById('retryPatientListBtn');
            const list=document.getElementById('patientRegistryResults');
            const label=button.textContent.trim();
            return {active:document.activeElement?.id || document.activeElement?.tagName,
                hasFocus:document.hasFocus(), hidden:list.hidden,inert:list.inert, disabled:button.disabled,
                retryExposed:!button.closest('[hidden], [inert], .is-hidden') && button.getClientRects().length>0,
                alert:document.getElementById('patientListError').getAttribute('role'),
                errorDescribed:button.getAttribute('aria-describedby')==='patientListErrorText',
                busy:document.getElementById('view-patients').getAttribute('aria-busy'),
                labelPresent:label.length>0, state:app.patientListState, epoch:app.sessionEpoch||0,
                revision:app.readVersions?.patients, view:app.currentView, modal:ui.topModal()??null,
                expired:Boolean(app.sessionExpired)};
        });
        const terminal=await snapshot();
        const automatic={requests:count,statuses:[...statuses]};
        const traversal=[];
        if (kind==='double') {
            assert.deepEqual(automatic.statuses,[409,409]);
            assert.equal(automatic.requests,2);
            assert(terminal.hidden && terminal.inert && terminal.retryExposed && !terminal.disabled);
            assert.equal(terminal.alert,'alert');
            const tabs=expectedFix ? ['Shift+Tab','Tab'] : Array(60).fill('Tab');
            for (const key of tabs) {
                await page.keyboard.press(key);
                traversal.push((await snapshot()).active);
            }
            await queue;
            if (expectedFix) {
                assert.equal(terminal.active,'retryPatientListBtn');
                assert.equal(traversal.at(-1),'retryPatientListBtn');
                assert.equal(count, 2);
                assert(terminal.errorDescribed);
            } else {
                assert.equal(terminal.active,'BODY');
                assert(!traversal.includes('retryPatientListBtn'));
                assert.equal(count,3);
            }
        }
        if (kind==='single') {
            assert.deepEqual(automatic.statuses,[409,200]);
            assert.equal(terminal.active,'patientPageStatus');
        }
        if (kind==='move-focus') assert.equal(terminal.active,'searchInput');
        if (kind==='move-back') assert.equal(terminal.active,'patientRegistryTitle');
        if (kind==='modal') assert(terminal.modal==='confirmModal' && terminal.active!=='retryPatientListBtn');
        if (kind==='navigate' || kind==='stale-200') assert(terminal.view==='calendar' && terminal.active!=='retryPatientListBtn');
        if (kind==='stale-200') assert.deepEqual(automatic.statuses,[200]);
        if (kind==='network') assert.deepEqual(automatic.statuses,[409,'transport-failure']);
        if (kind==='repeat-enter') assert.deepEqual(automatic.statuses,[409,409]);
        if (kind==='cursor') assert.deepEqual(automatic.statuses,[410,200]);
        if (['401','context','real-401'].includes(kind)) assert(terminal.expired && terminal.active!=='retryPatientListBtn');
        if (kind==='real-401') assert.deepEqual(automatic.statuses,[409,401]);
        assert.equal(writes,0);
        const events=await page.evaluate(()=>window.focusProbe);
        const afterTabs={requests:count,statuses:[...statuses],final:await snapshot()};
        let axe=null;
        if (expectedFix && kind==='double' && process.env.AXE_SOURCE && afterTabs.final.state==='error') {
            await page.evaluate(fs.readFileSync(process.env.AXE_SOURCE,'utf8'));
            axe=await page.evaluate(async()=> (await window.axe.run(document.body,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}})).violations.map(x=>x.id));
            assert.deepEqual(axe,[]);
        }
        if (expectedFix && kind==='double' && traversal.at(-1)==='retryPatientListBtn') {
            active=false;
            assert.equal((await control.request.post(origin+'/synthetic/wph/release-race',{data:{mode:'none'}})).status(),200);
            await page.keyboard.press('Enter');
            await page.waitForFunction(()=>app.patientListState==='ready');
        }
        let followup = null;
        if (expectedFix && kind==='modal') {
            active=false;
            await page.keyboard.press('Escape');
            assert.equal(await page.evaluate(()=>ui.topModal()), null);
            followup='Escape closed modal';
        }
        if (expectedFix && kind==='real-401') {
            active=false;
            await page.locator('#password').fill(password);
            await page.locator('#loginSubmit').click();
            await page.waitForFunction(()=>!app.sessionExpired && !app.sessionReconciling && app.patientListState==='ready' && !app.pageLoading);
            const next=page.getByRole('button',{name:'Следующая страница',exact:true});
            await next.focus(); await page.keyboard.press('Enter');
            await page.waitForFunction(()=>app.patientListState==='ready' && app.pageIndex===1 && !app.pageLoading && document.activeElement.id==='patientPageStatus');
            followup='real relogin and keyboard paging succeeded';
        }
        if (expectedFix && kind==='stale-200') {
            active=false;
            await page.goBack();
            await page.waitForFunction(()=>app.currentView==='patients' && app.patientListState==='ready');
            await page.goForward();
            await page.waitForFunction(()=>app.currentView==='calendar');
            followup='real Back to registry and Forward to calendar';
        }
        return {kind,width,theme,automatic,terminal,traversal,afterTabs,events,writes,axe,followup};
    } finally {
        await page.unrouteAll({behavior:'ignoreErrors'});
        await context.close();
        await control.close();
    }
}
async function main() {
    const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE});
    try {
        const args=process.env.FOCUS_CASES?.split(',') || ['single','double'];
        const results=[];
        for (const arg of args) {
            const [kind,width,theme]=arg.split(':');
            try { results.push(await runCase(browser,kind,width?Number(width):1440,theme||'light')); }
            catch (err) {
                const line=err.stack?.match(/focus_browser\.cjs:(\d+):(\d+)/)?.slice(1,3).map(Number);
                results.push({kind,width:width?Number(width):1440,theme:theme||'light',status:'FAIL',error:err.name,line});
                process.exitCode=1;
            }
        }
        console.log(JSON.stringify({syntheticOnly:true, browser:browser.version(),candidate:expectedFix,results},null,2));
    } finally { await browser.close(); }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
