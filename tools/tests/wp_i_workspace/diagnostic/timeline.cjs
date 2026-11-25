'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {performance} = require('node:perf_hooks');

const classes = new Map([
    ['/api/auth/login', 'login'], ['/api/auth/activity', 'touch'], ['/api/auth/me', 'identity'],
    ['/api/patients/workspace/events', 'calendar'], ['/api/audit', 'activity'],
    ['/api/ai/status', 'ai'], ['/api/internal-notifications/summary', 'notice'],
    ['/api/patients', 'registry'], ['/api/patients/head-options', 'heads'],
    ['/api/patients/resolve', 'resolve'], ['/api/users/doctors', 'doctors'],
]);
const codes = new Set(['PATIENT_QUERY_CHANGED','CURSOR_EXPIRED','ACCESS_CONTEXT_CHANGED',
    'SESSION_IDENTITY_CHANGED','READ_ADMISSION_UNAVAILABLE','AUDIT_UNAVAILABLE']);
const stateEvents = new Set(['resume', 'rebuild', 'show', 'render', 'identity', 'expire',
    'reconcile', 'calendar-json', 'read-current', 'read-begin', 'wait-start', 'wait-end', 'wait-error']);
const stateKeys = new Set(['expired','reconciling','appReady','calendarView','ready','busy',
    'retry','sameActor','result','returnedPromise','epoch','readVersion']);
const phases = new Set(['start','return','done','error','sample']);
const mark = 'I9_WS_STATE ';
const finiteInt = n => Number.isSafeInteger(n) && n >= 0 && n < 100000;

async function install(page) {
    const origin = new URL(process.env.WP_H_ORIGIN);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw Error('non-loopback');
    const output = path.join(process.env.OUT, 'browser-timeline.jsonl');
    let seq = 0, req = 0, finished = false;
    const start = performance.now();
    const requests = new WeakMap();
    const pending = new Set();
    const tasks = new Set();
    const write = (event, fields = {}) => {
        if (finished || seq >= 300) return;
        fs.appendFileSync(output, JSON.stringify({
            seq: ++seq, at_ms: Math.round(performance.now() - start), event, ...fields,
        }) + '\n', {mode: 0o600});
    };
    page.on('request', r => {
        const u = new URL(r.url());
        const type = u.origin === origin.origin && classes.get(u.pathname);
        const method = r.method();
        if (!type || !['GET','POST'].includes(method)) return;
        const record = {id: ++req, type, method};
        requests.set(r,record);
        pending.add(record.id);
        write('request',record);
    });
    page.on('response', response => {
        const record = requests.get(response.request());
        if (!record) return;
        const status = response.status();
        const rawId = response.headers()['x-i9-observer-order'];
        const serverId = /^\d{1,6}$/.test(rawId ?? '') ? Number(rawId) : 0;
        write('response', {...record, status, serverId});
        if (record.type === 'calendar' && status >= 400) {
            const task = response.json().then(body => {
                const code = body?.code ?? body?.detail?.code;
                write('calendar-code', {id:record.id, code:codes.has(code) ? code : 'other'});
            }, () => write('calendar-code',{id:record.id, code:'no-json'}));
            tasks.add(task);
            void task.finally(() => tasks.delete(task));
        }
    });
    for (const [name,label] of [['requestfinished','finish'],['requestfailed','request-failed']]) {
        page.on(name, r => {
            const record = requests.get(r);
            if (!record) return;
            pending.delete(record.id);
            write(label,record);
        });
    }
    page.on('pageerror', () => write('page-error'));
    page.on('console', message => {
        const text=message.text();
        if (!text.startsWith(mark)) return;
        try {
            const {name, phase, flags}=JSON.parse(text.slice(mark.length));
            if (!stateEvents.has(name) || !phases.has(phase)) return;
            if (!flags || !Object.entries(flags).every(([k,v]) => stateKeys.has(k)
                && (typeof v === 'boolean' || finiteInt(v)))) return;
            write('ui', {name,phase,flags});
        } catch {}
    });
    await page.evaluate(prefix => {
        const actor = app.user?.id;
        function flags() {
            const panel = document.getElementById('calendarPanel');
            return {
                expired: Boolean(app.sessionExpired), reconciling: Boolean(app.sessionReconciling),
                appReady: Boolean(app.appReady), calendarView: app.currentView === 'calendar',
                ready: Boolean(app.workspacePages?.events?.ready),
                busy: panel?.getAttribute('aria-busy') === 'true',
                retry: Boolean(panel?.querySelector('[role="alert"] + button')),
                sameActor: app.user?.id === actor, epoch: app.sessionEpoch || 0,
                readVersion: app.readVersions?.['workspace-events'] || 0,
            };
        }
        function note(name,phase,extra={}) {
            console.log(prefix+JSON.stringify({name,phase,flags:{...flags(),...extra}}));
        }
        window.__wsTimelineSample = name => note(name,'sample');
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
            const request = Reflect.apply(originalFetch,this,args);
            if (typeof args[0] !== 'string' || new URL(args[0],location.href).pathname !== '/api/patients/workspace/events') return request;
            request.then(response => {
                const originalJson = response.json;
                response.json = function(...jsonArgs) {
                    note('calendar-json','start');
                    const parsed=Reflect.apply(originalJson,this,jsonArgs);
                    parsed.then(()=>note('calendar-json','done'),()=>note('calendar-json','error'));
                    return parsed;
                };
            },()=>{});
            return request;
        };
        for (const [method,name,select] of [
            ['resumeSession','resume',null], ['rebuildAuthorizedWorkspace','rebuild',null],
            ['showView','show','calendar'], ['renderWorkspacePage','render','events'],
            ['checkSessionIdentity','identity',null], ['expireSession','expire',null],
            ['reconcilePeerSession','reconcile',null], ['beginRead','read-begin','workspace-events'],
            ['isCurrentRead','read-current','workspace-events'],
        ]) {
            const original=app[method];
            app[method]=function(...args) {
                if (select !== null && args[0] !== select) return Reflect.apply(original,this,args);
                note(name,'start');
                try {
                    const result=Reflect.apply(original,this,args);
                    if (result instanceof Promise) {
                        result.then(value=>note(name,'done',typeof value==='boolean'?{result:value}:{}),
                            ()=>note(name,'error'));
                        return result;
                    }
                    note(name,'return',typeof result==='boolean'?{result}:{});
                    return result;
                } catch (error) {
                    note(name,'error');
                    throw error;
                }
            };
        }
    },mark);
    fs.writeFileSync(process.env.WS_BACKEND_ARM, "", {flag:"wx",mode:0o600});
    return {async sample(label) {
        await page.evaluate(name=>window.__wsTimelineSample(name), label).catch(()=>{});
    }, async finish() {
        let timer;
        try {
            await Promise.race([Promise.allSettled([...tasks]),
                new Promise(resolve => {timer=setTimeout(resolve, 200);})]);
        } finally {
            clearTimeout(timer);
            write('summary',{pending:[...pending]});
            finished = true;
            fs.rmSync(process.env.WS_BACKEND_ARM, {force:true});
        }
    }};
}
module.exports = {install};
