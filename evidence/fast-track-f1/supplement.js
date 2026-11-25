async function supplemental() {
    const browser = await chromium.launch({headless: true, args: ['--disable-background-networking']});
    const results = {syntheticOnly: true, chromium: browser.version(), checks: []};
    try {
        const pulseContext = await newContext(browser);
        const manager = await pulseContext.newPage();
        monitor(manager);
        await login(manager, 'head');
        await go(manager, 'pulse');
        const pulse = manager.locator('#f1Pulse');
        await pulse.locator('[data-f1-metric=overdue_events]').waitFor();
        const failedSummary = route => route.fulfill({status: 503, contentType: 'application/json',
            body: JSON.stringify({code:'UNAVAILABLE'})});
        await manager.route('**/api/analytics/summary**', failedSummary);
        const onFailure = apiResponse(manager, '/api/analytics/summary');
        await pulse.locator('#f1PulseRefresh').click();
        assert.equal((await onFailure).status(), 503);
        await pulse.getByRole('alert').waitFor();
        assert.equal(await pulse.locator('[data-f1-metric]').count(), 0);
        await manager.unroute('**/api/analytics/summary**', failedSummary);
        const onRecovery = apiResponse(manager, '/api/analytics/summary');
        await pulse.locator('#f1PulseRefresh').click();
        assert.equal((await onRecovery).status(), 200);
        await pulse.locator('[data-f1-metric=overdue_events]').waitFor();
        results.checks.push({kind:'pulse-503', source:'transport', removesOldMetrics:true, explicitRefreshHttp:200});
        await pulseContext.close();

        const context = await newContext(browser);
        const page = await context.newPage();
        monitor(page);
        await login(page, 'doctor');
        await go(page, 'myDay');
        const day = page.locator('#f1MyDay');
        await day.getByText(patients.overdue.name, {exact: true}).first().waitFor();
        let attempts = 0;
        const conflicts = route => {
            attempts++;
            return route.fulfill({status: 409, contentType:'application/json',
                body: JSON.stringify({code:'PATIENT_QUERY_CHANGED'})});
        };
        await page.route('**/api/patients/workspace/checklists**', conflicts);
        await day.locator('[data-f1-doctor-mode=checklists]').click();
        await day.getByRole('alert').waitFor();
        assert.equal(attempts, 2);
        assert.equal(await day.locator('[data-f1-doctor-row]').count(), 0);
        const retry = day.getByRole('button',{name:'Обновить список',exact:true});
        await retry.waitFor();
        await page.unroute('**/api/patients/workspace/checklists**', conflicts);
        const onExplicit = apiResponse(page, '/api/patients/workspace/checklists');
        await retry.focus();
        await page.keyboard.press('Enter');
        assert.equal((await onExplicit).status(), 200);
        results.checks.push({kind:'my-day-terminal-409', source:'transport', automaticGets:attempts,
            staleRowsHidden:true, keyboardExplicitHttp:200});

        const peer = await context.newPage();
        monitor(peer);
        await peer.goto(origin);
        await peer.waitForFunction(actor=>app.appReady && app.user?.username===actor, users.doctor);
        // Putting focus back on the tested page can run its legitimate session refresh.
        await page.bringToFront();
        await page.waitForFunction(actor=>app.appReady && app.user?.username===actor
            && !app.sessionReconciling && !app.sessionExpired, users.doctor);
        if (!await day.isVisible()) await go(page,'myDay');
        let release, held, settled;
        const hold = new Promise(resolve=>{release=resolve;});
        const ready = new Promise(resolve=>{held=resolve;});
        const complete = new Promise(resolve=>{settled=resolve;});
        const handler = async route => {
            let yielded = false;
            try {
                const reply=await route.fetch();
                const body=await reply.json();
                assert.equal(reply.status(),200);
                assert(body.events.some(event=>event.patientId===patients.overdue.id));
                held();
                yielded = true;
                await hold;
                await route.fulfill({response:reply});
                settled('delivered');
            } catch(error) {
                if (!yielded) throw error;
                settled('discarded-with-prior-document');
            }
        };
        await page.route('**/api/patients/workspace/events**',handler);
        try {
            if (await day.locator('[data-f1-doctor-mode=events]').getAttribute('aria-pressed')==='true') {
                await day.locator('[data-f1-doctor-mode=patients]').click();
            }
            await day.locator('[data-f1-doctor-mode=events]').click();
            await bounded(ready, 'did not capture old actor response');
            await Promise.all([peer.waitForEvent('load'), peer.getByRole('button',{name:'Выйти',exact:true}).click()]);
            await login(peer,'foreign',true);
            await page.waitForFunction(actor=>app.appReady && !app.sessionExpired && !app.sessionReconciling
                && app.user?.username===actor,users.foreign);
            release();
            const disposition=await bounded(complete,'did not settle old response');
            assert(!(await day.textContent()).includes(patients.overdue.name));
            if (!await day.isVisible()) await go(page,'myDay');
            if (await day.locator('[data-f1-doctor-mode=patients]').getAttribute('aria-pressed')!=='true') {
                await day.locator('[data-f1-doctor-mode=patients]').click();
            }
            await day.getByText(patients.foreign.name,{exact:true}).first().waitFor();
            assert(!(await day.textContent()).includes(patients.overdue.name));
            results.checks.push({kind:'my-day-late-prior-identity', originalHttp:200, realPeerLogoutAndLogin:true,
                stalePayloadAbsent:true, oldResponseDisposition:disposition});
        } finally {
            release();
            await page.unroute('**/api/patients/workspace/events**',handler);
        }
        assert.equal(receipt.unexpectedMedicalWrites,0);
        assert.equal(receipt.pageErrors,0);
        results.unexpectedMedicalWrites = receipt.unexpectedMedicalWrites;
        results.pageErrors = receipt.pageErrors;
        fs.writeFileSync(process.env.F1_RECEIPT,JSON.stringify(results,null,2)+'\n',{flag:'wx',mode:0o600});
    } finally { await browser.close(); }
}

function bounded(promise, message) {
    let timer;
    return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),12000);})])
        .finally(()=>clearTimeout(timer));
}

supplemental().catch(error=>{
    process.stderr.write(error.name+'\n');
    const match=error.stack?.split('\n').find(line=>line.includes('supplement.cjs'));
    if(match)process.stderr.write(match.replace(/.*supplement\.cjs:/,'supplement.cjs:')+'\n');
    process.exitCode=1;
});
