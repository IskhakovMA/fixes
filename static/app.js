/* ==========================================================================
   Система планирования — фронтенд.

   Правила, которые нельзя нарушать (закреплены тестами backend/tests/test_frontend_csp.py):
     • разметка только через DOM API — никакой сборки HTML из строк;
     • никаких inline-обработчиков и никаких inline-стилей в атрибутах;
     • никакого динамического исполнения кода;
     • в localStorage — только тема оформления, никаких медицинских данных и токенов.
   Соответствующие имена сюда намеренно не выписаны: тесты ищут их по всему файлу.

   Разметка строится через el()/frag(): значения полей попадают в DOM только
   как textContent или .value и не могут быть интерпретированы как разметка.
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   DOM-хелперы
   -------------------------------------------------------------------------- */

function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'text') node.textContent = value;
            else if (key === 'class') node.className = value;
            else if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key === 'value') node.value = value;
            else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'hidden') node[key] = !!value;
            else if (key === 'on') {
                for (const [evt, handler] of Object.entries(value)) node.addEventListener(evt, handler);
            } else node.setAttribute(key, value);
        }
    }
    appendChildren(node, children);
    return node;
}

function appendChildren(node, children) {
    if (children === undefined || children === null || children === false) return;
    if (Array.isArray(children)) {
        children.forEach(child => appendChildren(node, child));
        return;
    }
    node.append(children instanceof Node ? children : document.createTextNode(String(children)));
}

function frag(children) {
    const f = document.createDocumentFragment();
    appendChildren(f, children);
    return f;
}

function option(value, label, selected) {
    return el('option', { value, text: label, selected: !!selected });
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
    trash: ['M5 7h14', 'M9 7V5h6v2', 'M7 7l1 12h8l1-12'],
    plus: ['M12 5v14', 'M5 12h14'],
    chevron: ['M6 9l6 6 6-6'],
    check: ['M5 12l5 5 9-10'],
    sparkles: ['M12 3l1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3', 'M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14'],
};

/** Иконка создаётся через createElementNS — SVG требует своего namespace. */
function icon(name, extraClass) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', extraClass ? `icon ${extraClass}` : 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    (ICON_PATHS[name] || []).forEach(d => {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    });
    return svg;
}

const $ = (id) => document.getElementById(id);

/* --------------------------------------------------------------------------
   Сетевой слой
   -------------------------------------------------------------------------- */

function getCookie(name) {
    const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
    const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
}

// Текст поиска по пациенту уходит в заголовке, а не в URL: строку запроса
// целиком пишут журналы reverse proxy.
function searchHeaders(text) {
    const q = (text || '').trim();
    return q ? { 'X-Search': encodeURIComponent(q) } : {};
}

// WP-D: тексты сервера не используются как пользовательские сообщения.
function apiErrorMessage(status, data, path) {
    const codes = {
        STALE_PATIENT_VERSION: 'Карточка уже изменена. Обновите данные и проверьте правку перед сохранением.',
        STALE_CHECKLIST_ITEM: 'Пункт уже изменен. Обновите данные и повторите действие.',
        SESSION_IDENTITY_CHANGED: 'Вход изменился в другой вкладке. Обновите страницу.',
        ACCESS_CONTEXT_CHANGED: 'Полномочия изменились. Войдите повторно для проверки доступа.',
        AUDIT_UNAVAILABLE: 'Не удалось сохранить запись аудита. Изменение не сохранено. Повторите позже.',
        PATIENT_HAS_CLINICAL_HISTORY: 'Карточка содержит медицинскую историю и не может быть удалена.',
        FACT_DATE_IN_FUTURE: 'Фактическая дата не может быть позже сегодняшней.',
        POSSIBLE_DUPLICATE: 'Найден возможный дубль. Проверьте совпадения.',
        DUPLICATE_MATCH_LIMIT_EXCEEDED: 'Совпадений слишком много. Неполный список подтверждать нельзя: требуется ручной разбор карточек.',
    };
    if (data && Object.hasOwn(codes, data.code)) return codes[data.code];
    if (status === 422 && data && Array.isArray(data.detail)) {
        const fields = {name: 'ФИО', phone: 'телефон', diagnosis: 'диагноз', policyNumber: 'полис ОМС',
            actualDate: 'фактическая дата', date: 'дата', email: 'адрес почты', username: 'логин'};
        const names = [...new Set(data.detail.flatMap(e => (Array.isArray(e.loc) ? e.loc : [])
            .filter(key => Object.hasOwn(fields, key)).map(key => fields[key])))];
        if (names.length) return 'Проверьте поля: ' + names.join(', ') + '.';
    }
    if (status === 401 && path === '/api/auth/login') return 'Неверный логин или пароль.';
    return ({400: 'Не удалось обработать запрос. Проверьте данные.',
        401: 'Сессия истекла. Войдите повторно. Черновик остается в этой вкладке.',
        403: 'Недостаточно прав для этого действия.', 404: 'Запись не найдена или недоступна.',
        409: 'Данные изменились. Обновите их и проверьте действие перед повторной отправкой.',
        422: 'Проверьте заполнение полей формы.', 429: 'Слишком много запросов. Подождите и повторите действие.',
        500: 'Внутренняя ошибка сервера. Повторите позже.',
        503: 'Сервер временно недоступен. Повторите позже.'})[status] || 'Не удалось выполнить запрос. Повторите позже.';
}

async function apiFetch(path, options) {
    options = options || {};
    const opts = Object.assign({ credentials: 'include' }, options);
    delete opts.rawResponse;
    delete opts.reconcileUser;
    opts.headers = Object.assign({}, options.headers);
    const method = (opts.method || 'GET').toUpperCase();
    if (opts.body !== undefined) opts.headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') {
        const csrf = getCookie(path === '/api/auth/mfa/authenticate' ? 'clinic_pre_auth_csrf' : 'clinic_csrf');
        if (csrf) opts.headers['X-CSRF-Token'] = csrf;
    }
    const authRequest = path.startsWith('/api/auth/') && path !== '/api/auth/activity';
    const reconciling = options.reconcileUser && ['/api/patients', '/api/patients/resolve', '/api/patients/head-options', '/api/users/doctors'].includes(path.split('?')[0]) && method === 'GET';
    const expectedUser = reconciling ? options.reconcileUser : app.user;
    if (expectedUser && !['/api/auth/login', '/api/auth/me'].includes(path)) {
        opts.headers['X-Clinic-User'] = expectedUser.id;
        if (expectedUser.accessContext) opts.headers['X-Clinic-Access'] = expectedUser.accessContext;
    }
    if ((app.sessionExpired && !authRequest && !reconciling) || (app.sessionReconciling && !authRequest && method !== 'GET')) {
        const error = new Error(apiErrorMessage(401)); error.status = 401; throw error;
    }
    const epoch = app.sessionEpoch || 0;
    const controller = options.signal ? null : new AbortController();
    if (controller) opts.signal = controller.signal;
    const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
    const requestStarted = performance.now();
    // AI chat is a read-only assistant exchange, not a clinical mutation.
    const write = !path.startsWith('/api/auth/') && path !== '/api/ai/chat' &&
        !['GET', 'HEAD'].includes(method) ? {} : null;
    if (write) browserNavigation.writes.add(write);
    try {
        const response = await fetch(path, opts);
        if (!authRequest && epoch !== (app.sessionEpoch || 0)) {
            const error = new Error(apiErrorMessage(401)); error.status = 401; error.obsolete = true; throw error;
        }
        const responseUser = response.headers.get('X-Clinic-User');
        if (!authRequest && expectedUser && responseUser && responseUser !== expectedUser.id) {
            app.discardSessionAndReload();
            const error = new Error(apiErrorMessage(401)); error.status = 409; error.obsolete = true; throw error;
        }
        if (!response.ok) {
            let data = null;
            try { data = await response.json();if(data?.detail?.code)data=data.detail; } catch (e) { /* ответ без JSON */ }
            if (!authRequest && epoch !== (app.sessionEpoch || 0)) {
                const error = new Error(apiErrorMessage(401)); error.status = 401; error.obsolete = true; throw error;
            }
            if (response.status === 401 && !authRequest) app.expireSession();
            if (data && data.code === 'SESSION_IDENTITY_CHANGED') app.discardSessionAndReload();
            if (data && data.code === 'ACCESS_CONTEXT_CHANGED') app.expireSession(true);
            const err = new Error(apiErrorMessage(response.status, data, path));
            err.status = response.status;
            if (data && data.code === 'SESSION_IDENTITY_CHANGED') err.obsolete = true;
            if (data && data.detail && typeof data.detail === 'object' && !Array.isArray(data.detail)) data = data.detail;
            err.data = data;   // code и сведения сервера для явного подтверждения (например, архивное решение ОК)
            throw err;
        }
        const idleDeadline = response.headers.get('X-Clinic-Idle-Deadline');
        if (idleDeadline) app.setIdleDeadline(idleDeadline, Math.max(0, Number(response.headers.get('X-Clinic-Idle-Remaining')) - (performance.now() - requestStarted) / 1000));
        if (response.status === 204) {
            if (!authRequest && !await app.checkSessionIdentity(epoch)) {
                const error = new Error(apiErrorMessage(401)); error.status = 401; error.obsolete = true; throw error;
            }
            return null;
        }
        const contentType = response.headers.get('content-type') || '';
        if (!options.rawResponse && contentType.includes('application/json')) {
            const data = await response.json();
            if (!authRequest && epoch !== (app.sessionEpoch || 0)) {
                const error = new Error(apiErrorMessage(401)); error.status = 401; error.obsolete = true; throw error;
            }
            if (!authRequest && !reconciling && !await app.checkSessionIdentity(epoch)) {
                const error = new Error(apiErrorMessage(401)); error.status = 401; error.obsolete = true; throw error;
            }
            if (data && data.idleDeadline) app.setIdleDeadline(data.idleDeadline, Math.max(0, data.idleRemainingSeconds - (performance.now() - requestStarted) / 1000));
            return data;
        }
        if (!authRequest && !reconciling) {
            const blob = await response.blob();
            if (!await app.checkSessionIdentity(epoch)) {
                const error = new Error(apiErrorMessage(401)); error.status = 401; error.obsolete = true; throw error;
            }
            return new Response(blob, {status: response.status, headers: response.headers});
        }
        return response;
    } catch (cause) {
        if (cause.status) throw cause;
        throw new Error(cause.name === 'AbortError' ? 'Время ожидания ответа истекло. Проверьте результат перед повторной отправкой.'
            : cause.name === 'SyntaxError' ? 'Не удалось прочитать ответ сервера. Повторите позже.'
                : 'Нет связи с сервером. Проверьте соединение и повторите действие.');
    } finally {
        if (timer) clearTimeout(timer);
        if (write) browserNavigation.writes.delete(write);
    }
}

const apiGetJson = (path) => apiFetch(path);
const apiPost = (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body === undefined ? {} : body) });
const apiPatch = (path, body) => apiFetch(path, { method: 'PATCH', body: JSON.stringify(body === undefined ? {} : body) });
const apiPut = (path, body) => apiFetch(path, { method: 'PUT', body: JSON.stringify(body === undefined ? {} : body) });
const apiDelete = (path) => apiFetch(path, { method: 'DELETE' });

/* WP2.4-B: ключ идемпотентности (UUID v4) для операций, которые нельзя выполнить
   дважды: создание пациента, импорт и перенос данных. Ключ передается только в
   заголовке Idempotency-Key — не в адресе, не в журналах и не в текстах ошибок. */
function newIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const IDEMPOTENT_TIMEOUT_MS = 30000;
const NETWORK_FAILURE_MESSAGE = 'Нет ответа от сервера. Повторите отправку: повтор с теми же данными безопасен и не создаст копию.';

// POST с ключом идемпотентности. Если ответ не получен (сеть, таймаут), запрос
// один раз повторяется с тем же ключом: сервер вернет результат первого
// выполнения, а не выполнит операцию снова. Ответ сервера с ошибкой не повторяется.
async function apiPostIdempotent(path, body, key) {
    const text = JSON.stringify(body === undefined ? {} : body);
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), IDEMPOTENT_TIMEOUT_MS);
        try {
            return await apiFetch(path, { method: 'POST', body: text, signal: controller.signal,
                headers: { 'Idempotency-Key': key } });
        } catch (err) {
            if (err && err.status) throw err;          // сервер ответил: повтор не нужен
            lastError = err;
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1000));
        } finally {
            clearTimeout(timer);
        }
    }
    const failure = new Error(NETWORK_FAILURE_MESSAGE);
    failure.network = true;
    failure.cause = lastError;
    throw failure;
}

/* --------------------------------------------------------------------------
   Модальные окна, подтверждения, уведомления
   -------------------------------------------------------------------------- */

const ui = {
    openModals: [],
    returnFocusTargets: new Map(),

    openModal(id) {
        if (id === 'addModal') { $('addModal').hidden=false; app.showView('create'); $('addModalTitle').focus(); return; }
        const modal = $(id);
        this.returnFocusTargets.set(id, document.activeElement);
        modal.hidden = false;
        modal.dataset.returnFocus = document.activeElement && document.activeElement.id ? document.activeElement.id : '';
        this.openModals.push(id);
        const focusable = modal.querySelector('input, select, textarea, button');
        if (focusable) focusable.focus();
    },

    closeModal(id, { force = false, keepView = false } = {}) {
        if (!force && !app.allowConsiliumDecisionClose(id)) return;
        if (id === 'addModal') {
            $('addModal').hidden=true; app.addFormActive=false;
            if (app.currentView==='create' && !keepView) { app.showView('patients'); browserNavigation.replaceScreen('patients'); $('openAddBtn').focus(); }
            return;
        }
        const modal = $(id);
        if (!modal || modal.hidden) return;
        modal.hidden = true;
        this.openModals = this.openModals.filter(m => m !== id);
        const returnId = modal.dataset.returnFocus;
        const target=this.returnFocusTargets.get(id);this.returnFocusTargets.delete(id);
        if(target?.isConnected && !target.closest('[hidden],.is-hidden,[inert]')) target.focus();
        else if (returnId && $(returnId)) $(returnId).focus();
        else document.querySelector('#patientTabs [aria-selected="true"],#openAddBtn')?.focus();
    },

    topModal() {
        return this.openModals[this.openModals.length - 1] || null;
    },

    /** Удерживает фокус внутри верхнего открытого окна. */
    trapFocus(event) {
        const id = this.topModal();
        if (!id || event.key !== 'Tab') return;
        const modal = $(id);
        const items = [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
            .filter(node => node.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    },

    /** Замена window.confirm: модалка в стиле приложения, Promise<boolean>. */
    confirm({ title, text, okLabel = 'Подтвердить', danger = true }) {
        return new Promise(resolve => {
            $('confirmTitle').textContent = title;
            $('confirmText').textContent = text;
            const okBtn = $('confirmOkBtn');
            okBtn.textContent = okLabel;
            okBtn.className = danger ? 'btn btn--danger' : 'btn btn--primary';

            const finish = (value) => {
                okBtn.removeEventListener('click', onOk);
                $('confirmCancelBtn').removeEventListener('click', onCancel);
                this.closeModal('confirmModal');
                resolve(value);
            };
            const onOk = () => finish(true);
            const onCancel = () => finish(false);

            okBtn.addEventListener('click', onOk);
            $('confirmCancelBtn').addEventListener('click', onCancel);
            this.pendingConfirmCancel = onCancel;
            this.openModal('confirmModal');
        });
    },

    /** Замена window.prompt для пары дата+время. Promise<{date,time}|null>. */
    promptDateTime({ title, text, date = '', time = '' }) {
        return new Promise(resolve => {
            $('promptTitle').textContent = title;
            $('promptText').textContent = text;
            $('promptDate').value = date;
            $('promptTime').value = time;

            const form = $('promptForm');
            const finish = (value) => {
                form.removeEventListener('submit', onSubmit);
                $('promptCancelBtn').removeEventListener('click', onCancel);
                this.closeModal('promptModal');
                resolve(value);
            };
            const onSubmit = (event) => {
                event.preventDefault();
                if (!$('promptDate').value) {
                    $('promptDate').focus();
                    return;
                }
                finish({ date: $('promptDate').value, time: $('promptTime').value });
            };
            const onCancel = () => finish(null);

            form.addEventListener('submit', onSubmit);
            $('promptCancelBtn').addEventListener('click', onCancel);
            this.pendingPromptCancel = onCancel;
            this.openModal('promptModal');
        });
    },

    /** Явный выбор одного значения из списка. options: [{value, label}]. Promise<value|null>. */
    choose({ title, text, label, options, okLabel = 'Выбрать' }) {
        return new Promise(resolve => {
            $('choiceTitle').textContent = title;
            $('choiceText').textContent = text;
            $('choiceLabel').textContent = label;
            $('choiceOkBtn').textContent = okLabel;
            const select = $('choiceSelect');
            // Значения по умолчанию нет: выбор должен быть явным.
            select.replaceChildren(
                el('option', { value: '', text: 'Выберите…' }),
                ...options.map(o => el('option', { value: o.value, text: o.label })),
            );
            const form = $('choiceForm');
            const finish = (value) => {
                form.removeEventListener('submit', onSubmit);
                $('choiceCancelBtn').removeEventListener('click', onCancel);
                this.closeModal('choiceModal');
                resolve(value);
            };
            const onSubmit = (event) => {
                event.preventDefault();
                if (!select.value) {
                    select.focus();
                    return;
                }
                finish(select.value);
            };
            const onCancel = () => finish(null);

            form.addEventListener('submit', onSubmit);
            $('choiceCancelBtn').addEventListener('click', onCancel);
            this.pendingChoiceCancel = onCancel;
            this.openModal('choiceModal');
        });
    },

    /** Замена window.prompt для одиночного текстового значения. Promise<string|null>. */
    textPrompt({ title, label, value = '' }) {
        return new Promise(resolve => {
            $('textPromptTitle').textContent = title;
            $('textPromptLabel').textContent = label;
            $('textPromptInput').value = value;

            const form = $('textPromptForm');
            const finish = (result) => {
                form.removeEventListener('submit', onSubmit);
                $('textPromptCancelBtn').removeEventListener('click', onCancel);
                this.closeModal('textPromptModal');
                resolve(result);
            };
            const onSubmit = (event) => {
                event.preventDefault();
                const trimmed = $('textPromptInput').value.trim();
                if (!trimmed) {
                    $('textPromptInput').focus();
                    return;
                }
                finish(trimmed);
            };
            const onCancel = () => finish(null);

            form.addEventListener('submit', onSubmit);
            $('textPromptCancelBtn').addEventListener('click', onCancel);
            this.pendingTextPromptCancel = onCancel;
            this.openModal('textPromptModal');
        });
    },

    toast(message, kind = 'info') {
        const node = el('div', { class: `toast toast--${kind}`, text: message });
        $('toasts').append(node);
        setTimeout(() => node.remove(), 5000);
    },
};

/* --------------------------------------------------------------------------
   Приложение
   -------------------------------------------------------------------------- */

const app = {
    patientRows: [],
    patientDetails: new Map(),
    patientPage: null,
    pageTrail: [null],
    pageIndex: 0,
    headOptions: [],
    candidateRows: [],
    activityByPatient: {},
    user: null,          // профиль из /api/auth/me; серверные права первичны
    doctors: [],         // врачи, доступные для назначения лечащим
    staffUsers: [],
    departments: [],
    currentView: 'patients',
    currentPatientId: null,
    currentTab: 'overview',
    selectedTimelineNodes: {},
    searchQuery: '',
    stageFilter: null,
    headFilter: null,
    deadlineFilter: null,
    attentionFilter: null,
    attentionReasonFilter: null,
    sortOrder: 'updated-newest',
    includeTerminal: false,
    registrySource: null,
    attentionModalPatientId: null,
    attentionCloseTarget: null,
    quality: {
        summary: null,
        issues: [],
        patients: [],
        duplicateGroups: [],
        rules: {},
        loading: false,
        error: '',
        filters: {
            query: '',
            severity: '',
            category: '',
            code: '',
            doctor: '',
            department: '',
            sort: 'severity',
        },
    },
    notifications: {
        summary: null,
        items: [],
        templates: [],
        loading: false,
        error: '',
        activeTab: 'inbox',
        limit: 20, offset: 0, ready: false,
        filters: {
            query: '',
            status: '',
            template: '',
            dateFrom: '',
            dateTo: '',
            doctor: '',
            department: '',
            sort: 'scheduled_asc',
        },
    },
    internalNotifications: {
        summary: null,
        drawerItems: [],
        fullItems: [],
        drawerFilter: 'all',
        fullTab: 'all',
        total: 0,
        loading: false,
        error: '',
        lastFocusId: '',
        pollTimer: null,
        filters: {
            query: '',
            type: '',
            unread: '',
            limit: 20,
            offset: 0,
        },
    },
    diagnosisComboboxItems: [],
    diagnosisComboboxActive: -1,
    consilium: {
        appointments: [],
        meta: null,
        editingId: null,
        // WP2.3-B1: версия открытой записи (контроль устаревшей формы) и текст,
        // который пользователь не успел сохранить до конфликта версий.
        editingVersion: null,
        conflictDraft: null,
        decisionId: null,
        dateFilter: '',
        chairGroupFilters: null,
        doctorDate: '',
        groupFilters: null,
        onlyFree: false,
        mineOnly: false,
        search: '',
        focusId: null,
        schedule: [],
        blockedPatientIds: [],
        archiveAppointments: [],
        scheduleCalendarMonth: '',
        registries: { surgical: [], chemotherapy: [], goc: [], goc65Plus: [] },
        loading: false,
        loaded: false,
    },
    ai: {
        status: { enabled: false, available: false, message: 'ИИ-помощник не настроен' },
        messages: [],
        references: [],
        patientContextId: null,
        patientContextLabel: '',
        loading: false,
        lastError: '',
        lastFocusId: '',
    },
    analytics: {
        dashboard: null,
        summary: null,
        stages: null,
        overdue: null,
        workload: null,
        dataQuality: null,
        checklists: null,
        notifications: null,
        details: null,
        detailsToken: 0,
        source: null,
        pendingDetails: null,
        filters: {
            dateFrom: '',
            dateTo: '',
            stage: '',
            nosology: '',
            doctor: '',
            department: '',
            attentionReason: '',
        },
    },

    QUALITY_SEVERITY_LABELS: {
        critical: 'Критическая ошибка',
        warning: 'Предупреждение',
        info: 'Информация',
    },
    QUALITY_CATEGORY_LABELS: {
        completeness: 'Заполненность полей',
        assignment: 'Ответственные',
        format: 'Формат данных',
        dates: 'Даты',
        stage: 'Маршрут',
        checklist: 'Чек-лист',
        duplicates: 'Возможные дубли',
    },
    ATTENTION_REASON_LABELS: {
        emergency_hospitalization: 'Экстренная госпитализация',
        route_change: 'Изменение маршрута пациента',
        critical_overdue: 'Критичная просрочка',
        doctor_decision_required: 'Требуется решение врача',
        department_head_decision_required: 'Требуется решение заведующего',
        organizational_issue: 'Организационная проблема',
        documents_or_data_issue: 'Проблема с документами или данными',
        patient_unavailable: 'Не удалось связаться / пациент временно недоступен',
        other: 'Другая причина',
    },
    QUALITY_CODE_LABELS: {
        missing_treating_doctor: 'Не назначен лечащий врач',
        missing_required_field: 'Не заполнено поле',
        missing_policy_number: 'Не указан номер полиса ОМС',
        missing_diagnosis: 'Не указан диагноз',
        missing_stage: 'Не указан текущий этап',
        invalid_phone: 'Некорректный телефон',
        actual_date_in_future: 'Фактическая дата в будущем',
        stage_sequence_violation: 'Нарушение маршрута',
        overdue_event: 'Просроченное событие',
        incomplete_required_checklist: 'Незавершённый чек-лист',
        possible_duplicate: 'Возможный дубль',
    },

    NOTIFICATION_STATUS_LABELS: {
        pending: 'Ожидает отправки',
        processing: 'Отправляется',
        sent: 'Отправлено',
        failed: 'Ошибка отправки',
        cancelled: 'Отменено',
        skipped: 'Пропущено',
    },
    NOTIFICATION_SOURCE_LABELS: {
        manual: 'Ручное напоминание',
        event: 'Плановое событие',
    },
    NOTIFICATION_REASON_LABELS: {
        no_consent: 'Нет согласия',
        invalid_phone: 'Некорректный телефон',
        missing_phone: 'Телефон отсутствует',
        patient_unavailable: 'Пациент недоступен',
        template_disabled: 'Шаблон отключен',
        template_invalid: 'Недопустимый шаблон',
        event_passed: 'Время приема уже наступило',
        event_already_sent: 'Напоминание уже отправлено',
        event_removed: 'Событие удалено',
        event_invalid: 'Некорректная дата или время события',
        provider_failed: 'Ошибка отправки в тестовом режиме',
        retry_scheduled: 'Повтор запланирован',
        event_inactive: 'Событие завершено или отменено',
        event_rescheduled: 'Дата события изменена',
    },

    INTERNAL_NOTIFICATION_TYPE_LABELS: {
        overdue: 'Просрочено',
        today: 'Сегодня',
        upcoming: 'Скоро',
        checklist: 'Чек-листы',
        data_quality: 'Качество данных',
        attention: 'Требует внимания',
        consilium_revision: 'Доработка консилиума',
    },

    INTERNAL_NOTIFICATION_TABS: [
        { value: 'all', label: 'Все' },
        { value: 'unread', label: 'Новые' },
        { value: 'overdue', label: 'Просрочено' },
        { value: 'today', label: 'Сегодня' },
        { value: 'upcoming', label: 'Скоро' },
        { value: 'checklist', label: 'Чек-листы' },
        { value: 'data_quality', label: 'Качество' },
        { value: 'attention', label: 'Внимание' },
        { value: 'consilium_revision', label: 'Консилиум' },
    ],

    icd10Localizations: {
        lip_oral_pharynx: {
            label: 'Губа, полость рта и глотка',
            diagnoses: [
                { code: 'C00.0', label: 'Злокачественное новообразование наружной поверхности верхней губы' },
                { code: 'C00.1', label: 'Злокачественное новообразование наружной поверхности нижней губы' },
                { code: 'C00.2', label: 'Злокачественное новообразование наружной поверхности губы неуточненной' },
                { code: 'C00.3', label: 'Злокачественное новообразование внутренней поверхности верхней губы' },
                { code: 'C00.4', label: 'Злокачественное новообразование внутренней поверхности нижней губы' },
                { code: 'C00.5', label: 'Злокачественное новообразование внутренней поверхности губы неуточненной' },
                { code: 'C00.6', label: 'Злокачественное новообразование спайки губы' },
                { code: 'C00.8', label: 'Злокачественное новообразование губы, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C00.9', label: 'Злокачественное новообразование губы неуточненной части' },
                { code: 'C01', label: 'Злокачественные новообразования основания языка' },
                { code: 'C02.0', label: 'Злокачественное новообразование спинки языка' },
                { code: 'C02.1', label: 'Злокачественное новообразование боковой поверхности языка' },
                { code: 'C02.2', label: 'Злокачественное новообразование нижней поверхности языка' },
                { code: 'C02.3', label: 'Злокачественное новообразование передних 2/3 языка неуточненной части' },
                { code: 'C02.4', label: 'Злокачественное новообразование язычной миндалины' },
                { code: 'C02.8', label: 'Злокачественное новообразование языка, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C02.9', label: 'Злокачественное новообразование языка неуточненной части' },
                { code: 'C03.0', label: 'Злокачественное новообразование десны верхней челюсти' },
                { code: 'C03.1', label: 'Злокачественное новообразование десны нижней челюсти' },
                { code: 'C03.9', label: 'Злокачественное новообразование десны неуточненной' },
                { code: 'C04.0', label: 'Злокачественное новообразование передней части дна полости рта' },
                { code: 'C04.1', label: 'Злокачественное новообразование боковой части дна полости рта' },
                { code: 'C04.8', label: 'Злокачественное новообразование дна полости рта, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C04.9', label: 'Злокачественное новообразование дна полости рта, неуточненное' },
                { code: 'C05.0', label: 'Злокачественное новообразование твердого неба' },
                { code: 'C05.1', label: 'Злокачественное новообразование мягкого неба' },
                { code: 'C05.2', label: 'Злокачественное новообразование язычка' },
                { code: 'C05.8', label: 'Злокачественное новообразование неба, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C05.9', label: 'Злокачественное новообразование неба, неуточненное' },
                { code: 'C06.0', label: 'Злокачественное новообразование слизистой оболочки щеки' },
                { code: 'C06.1', label: 'Злокачественное новообразование преддверия рта' },
                { code: 'C06.2', label: 'Злокачественное новообразование ретромолярной области' },
                { code: 'C06.8', label: 'Злокачественное новообразование других и неуточненных отделов рта, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C06.9', label: 'Злокачественное новообразование рта неуточненное' },
                { code: 'C07', label: 'Злокачественное новообразование околоушной слюнной железы' },
                { code: 'C08.0', label: 'Злокачественное новообразование поднижнечелюстной железы' },
                { code: 'C08.1', label: 'Злокачественное новообразование подъязычной железы' },
                { code: 'C08.8', label: 'Злокачественное новообразование больших слюнных желез, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C08.9', label: 'Злокачественное новообразование большой слюнной железы неуточненной' },
                { code: 'C09.0', label: 'Злокачественное новообразование миндаликовой ямочки' },
                { code: 'C09.1', label: 'Злокачественное новообразование дужки небной миндалины (передней) (задней)' },
                { code: 'C09.8', label: 'Злокачественное новообразование миндалины, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C09.9', label: 'Злокачественное новообразование миндалины неуточненной' },
                { code: 'C10.0', label: 'Злокачественное новообразование ямки надгортанника' },
                { code: 'C10.1', label: 'Злокачественное новообразование передней поверхности надгортанника' },
                { code: 'C10.2', label: 'Злокачественное новообразование боковой стенки ротоглотки' },
                { code: 'C10.3', label: 'Злокачественное новообразование задней стенки ротоглотки' },
                { code: 'C10.4', label: 'Злокачественное новообразование жаберных щелей' },
                { code: 'C10.8', label: 'Злокачественное новообразование ротоглотки, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C10.9', label: 'Злокачественное новообразование ротоглотки неуточненное' },
                { code: 'C11.0', label: 'Злокачественное новообразование верхней стенки носоглотки' },
                { code: 'C11.1', label: 'Злокачественное новообразование задней стенки носоглотки' },
                { code: 'C11.2', label: 'Злокачественное новообразование боковой стенки носоглотки' },
                { code: 'C11.3', label: 'Злокачественное новообразование передней стенки носоглотки' },
                { code: 'C11.8', label: 'Злокачественное новообразование носоглотки, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C11.9', label: 'Злокачественное новообразование носоглотки неуточненное' },
                { code: 'C12', label: 'Злокачественное новообразование грушевидного синуса' },
                { code: 'C13.0', label: 'Злокачественное новообразование заперстневидной области' },
                { code: 'C13.1', label: 'Злокачественное новообразование черпалонадгортанной складки нижней части глотки' },
                { code: 'C13.2', label: 'Злокачественное новообразование задней стенки нижней части глотки' },
                { code: 'C13.8', label: 'Злокачественное новообразование нижней части глотки, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C13.9', label: 'Злокачественное новообразование нижней части глотки неуточненное' },
                { code: 'C14.0', label: 'Злокачественное новообразование глотки неуточненное' },
                { code: 'C14.2', label: 'Злокачественное новообразование глоточного кольца Вальдейера [Waldeyer]' },
                { code: 'C14.8', label: 'Злокачественное новообразование губы, полости рта и глотки, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'D00.0', label: 'Карцинома in situ губы, полости рта и глотки' },
                { code: 'D37.0', label: 'Новообразование неопределённого или неизвестного характера губы, полости рта и глотки' },
                { code: 'D10.0', label: 'Доброкачественное новообразование губы' },
                { code: 'D10.1', label: 'Доброкачественное новообразование языка' },
                { code: 'D10.2', label: 'Доброкачественное новообразование дна полости рта' },
                { code: 'D10.3', label: 'Доброкачественное новообразование других и неуточненных частей рта' },
                { code: 'D10.4', label: 'Доброкачественное новообразование миндалины' },
                { code: 'D10.5', label: 'Доброкачественное новообразование других частей ротоглотки' },
                { code: 'D10.6', label: 'Доброкачественное новообразование носоглотки' },
                { code: 'D10.7', label: 'Доброкачественное новообразование гортаноглотки' },
                { code: 'D10.9', label: 'Доброкачественное новообразование глотки неуточненной локализации' },
                { code: 'D11.0', label: 'Доброкачественное новообразование околоушной слюнной железы' },
                { code: 'D11.7', label: 'Доброкачественное новообразование других больших слюнных желез' },
                { code: 'D11.9', label: 'Доброкачественное новообразование большой слюнной железы неуточненное' },
            ]
        },
        esophagus_stomach_intestine: {
            label: 'Пищевод, желудок и кишечник',
            diagnoses: [
                { code: 'C15.0', label: 'Злокачественное новообразование шейного отдела пищевода' },
                { code: 'C15.1', label: 'Злокачественное новообразование грудного отдела пищевода' },
                { code: 'C15.2', label: 'Злокачественное новообразование абдоминального отдела пищевода' },
                { code: 'C15.3', label: 'Злокачественное новообразование верхней трети пищевода' },
                { code: 'C15.4', label: 'Злокачественное новообразование средней трети пищевода' },
                { code: 'C15.5', label: 'Злокачественное новообразование нижней трети пищевода' },
                { code: 'C15.8', label: 'Злокачественное новообразование пищевода, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C15.9', label: 'Злокачественное новообразование пищевода неуточненное' },
                { code: 'C16.0', label: 'Злокачественное новообразование кардии' },
                { code: 'C16.1', label: 'Злокачественное новообразование дна желудка' },
                { code: 'C16.2', label: 'Злокачественное новообразование тела желудка' },
                { code: 'C16.3', label: 'Злокачественное новообразование преддверия привратника' },
                { code: 'C16.4', label: 'Злокачественное новообразование привратника' },
                { code: 'C16.5', label: 'Злокачественное новообразование малой кривизны желудка неуточненной части' },
                { code: 'C16.6', label: 'Злокачественное новообразование большой кривизны желудка неуточненной части' },
                { code: 'C16.8', label: 'Злокачественное новообразование желудка, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C16.9', label: 'Злокачественное новообразование желудка неуточненной локализации' },
                { code: 'C17.0', label: 'Злокачественное новообразование двенадцатиперстной кишки' },
                { code: 'C17.1', label: 'Злокачественное новообразование тощей кишки' },
                { code: 'C17.2', label: 'Злокачественное новообразование подвздошной кишки' },
                { code: 'C17.3', label: 'Злокачественное новообразование дивертикула Меккеля [Meckel]' },
                { code: 'C17.8', label: 'Злокачественное новообразование тонкого кишечника, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C17.9', label: 'Злокачественное новообразование тонкого кишечника неуточненной локализации' },
                { code: 'C18.0', label: 'Злокачественное новообразование слепой кишки' },
                { code: 'C18.1', label: 'Злокачественное новообразование червеобразного отростка' },
                { code: 'C18.2', label: 'Злокачественное новообразование восходящей ободочной кишки' },
                { code: 'C18.3', label: 'Злокачественное новообразование печеночного изгиба' },
                { code: 'C18.4', label: 'Злокачественное новообразование поперечной ободочной кишки' },
                { code: 'C18.5', label: 'Злокачественное новообразование селезеночного изгиба' },
                { code: 'C18.6', label: 'Злокачественное новообразование нисходящей ободочной кишки' },
                { code: 'C18.7', label: 'Злокачественное новообразование сигмовидной кишки' },
                { code: 'C18.8', label: 'Злокачественное новообразование ободочной кишки, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C18.9', label: 'Злокачественное новообразование ободочной кишки неуточненной локализации' },
                { code: 'C19', label: 'Злокачественное новообразование ректосигмоидного соединения' },
                { code: 'C20', label: 'Злокачественное новообразование прямой кишки' },
                { code: 'C21.0', label: 'Злокачественное новообразование заднего прохода неуточненной локализации' },
                { code: 'C21.1', label: 'Злокачественное новообразование анального канала' },
                { code: 'C21.2', label: 'Злокачественное новообразование клоакогенной зоны' },
                { code: 'C21.8', label: 'Злокачественное новообразование прямой кишки, заднего прохода [ануса] и анального канала, выходящее за пределы вышеуказанных локализаций' },
                { code: 'C26.0', label: 'Злокачественное новообразование кишечного тракта неуточненной части' },
                { code: 'C26.1', label: 'Злокачественное новообразование селезенки' },
                { code: 'C26.8', label: 'Злокачественное новообразование органов пищеварения, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C26.9', label: 'Злокачественное новообразование неточно обозначенных локализаций в пределах пищеварительной системы' },
                { code: 'D00.1', label: 'Карцинома in situ пищевода' },
                { code: 'D00.2', label: 'Карцинома in situ желудка' },
                { code: 'D01.0', label: 'Карцинома in situ ободочной кишки' },
                { code: 'D01.1', label: 'Карцинома in situ ректосигмоидного соединения' },
                { code: 'D01.2', label: 'Карцинома in situ прямой кишки' },
                { code: 'D01.3', label: 'Карцинома in situ заднего прохода [ануса] и анального канала' },
                { code: 'D01.4', label: 'Карцинома in situ других и неуточненных частей кишечника' },
                { code: 'D01.7', label: 'Карцинома in situ других уточненных органов пищеварения' },
                { code: 'D01.9', label: 'Карцинома in situ органов пищеварения неуточненных' },
                { code: 'D37.1', label: 'Новообразование неопределённого или неизвестного характера желудка' },
                { code: 'D37.3', label: 'Новообразование неопределённого или неизвестного характера аппендикса' },
                { code: 'D37.4', label: 'Новообразование неопределённого или неизвестного характера ободочной кишки' },
                { code: 'D37.5', label: 'Новообразование неопределённого или неизвестного характера прямой кишки' },
                { code: 'D12.0', label: 'Доброкачественное новообразование слепой кишки' },
                { code: 'D12.1', label: 'Доброкачественное новообразование червеобразного отростка' },
                { code: 'D12.2', label: 'Доброкачественное новообразование восходящей ободочной кишки' },
                { code: 'D12.3', label: 'Доброкачественное новообразование поперечной ободочной кишки' },
                { code: 'D12.4', label: 'Доброкачественное новообразование нисходящей ободочной кишки' },
                { code: 'D12.5', label: 'Доброкачественное новообразование сигмовидной кишки' },
                { code: 'D12.6', label: 'Доброкачественное новообразование ободочной кишки неуточненной части' },
                { code: 'D12.7', label: 'Доброкачественное новообразование ректосигмоидного соединения' },
                { code: 'D12.8', label: 'Доброкачественное новообразование прямой кишки' },
                { code: 'D12.9', label: 'Доброкачественное новообразование заднего прохода [ануса] и анального канала' },
                { code: 'D13.0', label: 'Доброкачественное новообразование пищевода' },
                { code: 'D13.1', label: 'Доброкачественное новообразование желудка' },
                { code: 'D13.2', label: 'Доброкачественное новообразование двенадцатиперстной кишки' },
                { code: 'D13.3', label: 'Доброкачественное новообразование других и неуточненных отделов тонкого кишечника' },
                { code: 'D13.9', label: 'Доброкачественное новообразование неточно обозначенных локализаций в пределах пищеварительной системы' },
            ]
        },
        liver_biliary_pancreas: {
            label: 'Печень, желчевыводящие пути и поджелудочная железа',
            diagnoses: [
                { code: 'C22.0', label: 'Печеночноклеточный рак' },
                { code: 'C22.1', label: 'Рак внутрипеченочного желчного протока' },
                { code: 'C22.2', label: 'Гепатобластома' },
                { code: 'C22.3', label: 'Ангиосаркома печени' },
                { code: 'C22.4', label: 'Другие саркомы печени' },
                { code: 'C22.7', label: 'Другие уточненные раки печени' },
                { code: 'C22.9', label: 'Злокачественное новообразование печени неуточненное' },
                { code: 'C23', label: 'Злокачественное новообразование желчного пузыря' },
                { code: 'C24.0', label: 'Злокачественное новообразование внепеченочного желчного протока' },
                { code: 'C24.1', label: 'Злокачественное новообразование ампулы фатерова сосочка' },
                { code: 'C24.8', label: 'Злокачественное новообразование желчных путей, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C24.9', label: 'Злокачественное новообразование желчных путей неуточненное' },
                { code: 'C25.0', label: 'Злокачественное новообразование головки поджелудочной железы' },
                { code: 'C25.1', label: 'Злокачественное новообразование тела поджелудочной железы' },
                { code: 'C25.2', label: 'Злокачественное новообразование хвоста поджелудочной железы' },
                { code: 'C25.3', label: 'Злокачественное новообразование протока поджелудочной железы' },
                { code: 'C25.4', label: 'Злокачественное новообразование островковых клеток поджелудочной железы' },
                { code: 'C25.7', label: 'Злокачественное новообразование других частей поджелудочной железы' },
                { code: 'C25.8', label: 'Злокачественное новообразование поджелудочной железы, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C25.9', label: 'Злокачественное новообразование поджелудочной железы неуточненное' },
                { code: 'D01.5', label: 'Карцинома in situ печени, желчного пузыря и желчных протоков' },
                { code: 'D37.6', label: 'Новообразование неопределённого или неизвестного характера печени, желчного пузыря и желчных протоков' },
                { code: 'D13.4', label: 'Доброкачественное новообразование печени' },
                { code: 'D13.5', label: 'Доброкачественное новообразование внепеченочных желчных протоков' },
                { code: 'D13.6', label: 'Доброкачественное новообразование поджелудочной железы' },
                { code: 'D13.7', label: 'Доброкачественное новообразование островковых клеток поджелудочной железы' },
            ]
        },
        respiratory_thoracic: {
            label: 'Дыхательная система и органы грудной клетки',
            diagnoses: [
                { code: 'C30.0', label: 'Злокачественное новообразование полости носа' },
                { code: 'C30.1', label: 'Злокачественное новообразование среднего уха' },
                { code: 'C31.0', label: 'Злокачественное новообразование верхнечелюстной пазухи' },
                { code: 'C31.1', label: 'Злокачественное новообразование решетчатой пазухи' },
                { code: 'C31.2', label: 'Злокачественное новообразование лобной пазухи' },
                { code: 'C31.3', label: 'Злокачественное новообразование клиновидной пазухи' },
                { code: 'C31.8', label: 'Злокачественное новообразование придаточных пазух, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C31.9', label: 'Злокачественное новообразование придаточной пазухи неуточненное' },
                { code: 'C32.0', label: 'Злокачественное новообразование собственно голосового аппарата' },
                { code: 'C32.1', label: 'Злокачественное новообразование над собственно голосовым аппаратом' },
                { code: 'C32.2', label: 'Злокачественное новообразование под собственно голосовым аппаратом' },
                { code: 'C32.3', label: 'Злокачественное новообразование хрящей гортани' },
                { code: 'C32.8', label: 'Злокачественное новообразование гортани, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C32.9', label: 'Злокачественное новообразование гортани неуточненное' },
                { code: 'C33', label: 'Злокачественное новообразование трахеи' },
                { code: 'C34.0', label: 'Злокачественное новообразование главного бронха' },
                { code: 'C34.1', label: 'Злокачественное новообразование верхней доли, бронхов или легкого' },
                { code: 'C34.2', label: 'Злокачественное новообразование средней доли, бронхов или легкого' },
                { code: 'C34.3', label: 'Злокачественное новообразование нижней доли, бронхов или легкого' },
                { code: 'C34.8', label: 'Злокачественное новообразование бронхов или легкого, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C34.9', label: 'Злокачественное новообразование бронхов или легкого неуточненной локализации' },
                { code: 'C37', label: 'Злокачественное новообразование вилочковой железы' },
                { code: 'C38.0', label: 'Злокачественное новообразование сердца' },
                { code: 'C38.1', label: 'Злокачественное новообразование переднего средостения' },
                { code: 'C38.2', label: 'Злокачественное новообразование заднего средостения' },
                { code: 'C38.3', label: 'Злокачественное новообразование средостения неуточненной части' },
                { code: 'C38.4', label: 'Злокачественное новообразование плевры' },
                { code: 'C38.8', label: 'Злокачественное новообразование сердца, средостения и плевры, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C39.0', label: 'Злокачественное новообразование верхних дыхательных путей неуточненной части' },
                { code: 'C39.8', label: 'Злокачественное новообразование органов дыхания и внутригрудных органов, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C39.9', label: 'Злокачественное новообразование неточно обозначенных локализаций в пределах органов дыхания' },
                { code: 'D02.0', label: 'Карцинома in situ гортани' },
                { code: 'D02.1', label: 'Карцинома in situ трахеи' },
                { code: 'D02.2', label: 'Карцинома in situ бронха и легкого' },
                { code: 'D02.3', label: 'Карцинома in situ других частей органов дыхания' },
                { code: 'D02.4', label: 'Карцинома in situ органов дыхания неуточненных' },
                { code: 'D38.0', label: 'Новообразование неопределённого или неизвестного характера гортани' },
                { code: 'D38.1', label: 'Новообразование неопределённого или неизвестного характера трахеи, бронха и лёгкого' },
                { code: 'D14.0', label: 'Доброкачественное новообразование среднего уха, полости носа и придаточных пазух' },
                { code: 'D14.1', label: 'Доброкачественное новообразование гортани' },
                { code: 'D14.2', label: 'Доброкачественное новообразование трахеи' },
                { code: 'D14.3', label: 'Доброкачественное новообразование бронха и легкого' },
                { code: 'D14.4', label: 'Доброкачественное новообразование дыхательной системы неуточненной локализации' },
                { code: 'D15.0', label: 'Доброкачественное новообразование вилочковой железы [тимуса]' },
                { code: 'D15.1', label: 'Доброкачественное новообразование сердца' },
                { code: 'D15.2', label: 'Доброкачественное новообразование средостения' },
                { code: 'D15.7', label: 'Доброкачественное новообразование других уточненных органов грудной клетки' },
                { code: 'D15.9', label: 'Доброкачественное новообразование органов грудной клетки неуточненных' },
                { code: 'D19.0', label: 'Доброкачественное новообразование мезотелиальной ткани плевры' },
            ]
        },
        bone_cartilage: {
            label: 'Кости и суставные хрящи',
            diagnoses: [
                { code: 'C40.0', label: 'Злокачественное новообразование лопатки и длинных костей верхней конечности' },
                { code: 'C40.1', label: 'Злокачественное новообразование коротких костей верхней конечности' },
                { code: 'C40.2', label: 'Злокачественное новообразование длинных костей нижней конечности' },
                { code: 'C40.3', label: 'Злокачественное новообразование коротких костей нижней конечности' },
                { code: 'C40.8', label: 'Злокачественное новообразование костей и суставных хрящей конечностей, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C40.9', label: 'Злокачественное новообразование костей и суставных хрящей конечности неуточненной локализации' },
                { code: 'C41.0', label: 'Злокачественное новообразование костей черепа и лица' },
                { code: 'C41.1', label: 'Злокачественное новообразование нижней челюсти' },
                { code: 'C41.2', label: 'Злокачественное новообразование позвоночного столба' },
                { code: 'C41.3', label: 'Злокачественное новообразование ребер, грудины и ключицы' },
                { code: 'C41.4', label: 'Злокачественное новообразование костей таза, крестца и копчика' },
                { code: 'C41.8', label: 'Злокачественное новообразование костей и суставных хрящей других и неуточненных локализаций, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C41.9', label: 'Злокачественное новообразование костей и суставных хрящей неуточненное' },
                { code: 'D16.0', label: 'Доброкачественное новообразование лопатки и длинных костей верхней конечности' },
                { code: 'D16.1', label: 'Доброкачественное новообразование коротких костей верхней конечности' },
                { code: 'D16.2', label: 'Доброкачественное новообразование длинных костей нижней конечности' },
                { code: 'D16.3', label: 'Доброкачественное новообразование коротких костей нижней конечности' },
                { code: 'D16.4', label: 'Доброкачественное новообразование костей черепа и лица' },
                { code: 'D16.5', label: 'Доброкачественное новообразование нижней челюсти костной части' },
                { code: 'D16.6', label: 'Доброкачественное новообразование позвоночного столба' },
                { code: 'D16.7', label: 'Доброкачественное новообразование ребер, грудины и ключицы' },
                { code: 'D16.8', label: 'Доброкачественное новообразование тазовых костей, крестца и копчика' },
                { code: 'D16.9', label: 'Доброкачественное новообразование костей и суставных хрящей неуточненных' },
            ]
        },
        skin: {
            label: 'Кожа (включая меланому)',
            diagnoses: [
                { code: 'C43.0', label: 'Злокачественная меланома губы' },
                { code: 'C43.1', label: 'Злокачественная меланома века, включая спайку век' },
                { code: 'C43.2', label: 'Злокачественная меланома уха и наружного слухового прохода' },
                { code: 'C43.3', label: 'Злокачественная меланома других и неуточненных частей лица' },
                { code: 'C43.4', label: 'Злокачественная меланома волосистой части головы и шеи' },
                { code: 'C43.5', label: 'Злокачественная меланома туловища' },
                { code: 'C43.6', label: 'Злокачественная меланома верхней конечности, включая область плечевого сустава' },
                { code: 'C43.7', label: 'Злокачественная меланома нижней конечности, включая область тазобедренного сустава' },
                { code: 'C43.8', label: 'Злокачественная меланома кожи, выходящая за пределы одной и более вышеуказанных локализаций' },
                { code: 'C43.9', label: 'Злокачественная меланома кожи неуточненная' },
                { code: 'C44.0', label: 'Другие злокачественные новообразования кожи губы' },
                { code: 'C44.1', label: 'Другие злокачественные новообразования кожи века, включая спайку век' },
                { code: 'C44.2', label: 'Другие злокачественные новообразования кожи уха и наружного слухового прохода' },
                { code: 'C44.3', label: 'Другие злокачественные новообразования кожи других и неуточненных частей лица' },
                { code: 'C44.4', label: 'Другие злокачественные новообразования кожи волосистой части головы и шеи' },
                { code: 'C44.5', label: 'Другие злокачественные новообразования кожи туловища' },
                { code: 'C44.6', label: 'Другие злокачественные новообразования кожи верхней конечности, включая область плечевого пояса' },
                { code: 'C44.7', label: 'Другие злокачественные новообразования кожи нижней конечности, включая тазобедренную область' },
                { code: 'C44.8', label: 'Другие злокачественные новообразования кожи, выходящие за пределы одной и более вышеуказанных локализаций' },
                { code: 'C44.9', label: 'Другие злокачественные новообразования кожи неуточненной области' },
                { code: 'D03.0', label: 'Меланома in situ губы' },
                { code: 'D03.1', label: 'Меланома in situ века, включая спайку век' },
                { code: 'D03.2', label: 'Меланома in situ уха и наружного слухового прохода' },
                { code: 'D03.3', label: 'Меланома in situ других и неуточненных частей лица' },
                { code: 'D03.4', label: 'Меланома in situ волосистой части головы и шеи' },
                { code: 'D03.5', label: 'Меланома in situ туловища' },
                { code: 'D03.6', label: 'Меланома in situ верхней конечности, включая область плечевого пояса' },
                { code: 'D03.7', label: 'Меланома in situ нижней конечности, включая тазобедренную область' },
                { code: 'D03.8', label: 'Меланома in situ других локализаций' },
                { code: 'D03.9', label: 'Меланома in situ неуточненной локализации' },
                { code: 'D04.0', label: 'Карцинома in situ кожи губы' },
                { code: 'D04.1', label: 'Карцинома in situ кожи века, включая спайку век' },
                { code: 'D04.2', label: 'Карцинома in situ кожи уха и наружного слухового прохода' },
                { code: 'D04.3', label: 'Карцинома in situ кожи других и неуточненных частей лица' },
                { code: 'D04.4', label: 'Карцинома in situ кожи волосистой части головы и шеи' },
                { code: 'D04.5', label: 'Карцинома in situ кожи туловища' },
                { code: 'D04.6', label: 'Карцинома in situ кожи верхней конечности, включая область плечевого пояса' },
                { code: 'D04.7', label: 'Карцинома in situ кожи нижней конечности, включая тазобедренную область' },
                { code: 'D04.8', label: 'Карцинома in situ кожи других локализаций' },
                { code: 'D04.9', label: 'Карцинома in situ кожи неуточненной локализации' },
                { code: 'D22.0', label: 'Меланоформный невус губы' },
                { code: 'D22.1', label: 'Меланоформный невус века, включая спайку век' },
                { code: 'D22.2', label: 'Меланоформный невус уха и наружного слухового прохода' },
                { code: 'D22.3', label: 'Меланоформный невус других и неуточненных частей лица' },
                { code: 'D22.4', label: 'Меланоформный невус волосистой части головы и шеи' },
                { code: 'D22.5', label: 'Меланоформный невус туловища' },
                { code: 'D22.6', label: 'Меланоформный невус верхней конечности, включая область плечевого пояса' },
                { code: 'D22.7', label: 'Меланоформный невус нижней конечности, включая тазобедренную область' },
                { code: 'D22.9', label: 'Меланоформный невус неуточненный' },
                { code: 'D23.0', label: 'Другие доброкачественные новообразования кожи губы' },
                { code: 'D23.1', label: 'Другие доброкачественные новообразования кожи века, включая спайку век' },
                { code: 'D23.2', label: 'Другие доброкачественные новообразования кожи уха и наружного слухового прохода' },
                { code: 'D23.3', label: 'Другие доброкачественные новообразования кожи других и неуточненных частей лица' },
                { code: 'D23.4', label: 'Другие доброкачественные новообразования кожи волосистой части головы и шеи' },
                { code: 'D23.5', label: 'Другие доброкачественные новообразования кожи туловища' },
                { code: 'D23.6', label: 'Другие доброкачественные новообразования кожи верхней конечности, включая область плечевого сустава' },
                { code: 'D23.7', label: 'Другие доброкачественные новообразования кожи нижней конечности, включая область тазобедренного сустава' },
                { code: 'D23.9', label: 'Другие доброкачественные новообразования кожи неуточненной локализации' },
            ]
        },
        soft_tissue_peritoneum: {
            label: 'Мягкие ткани, брюшина и забрюшинное пространство',
            diagnoses: [
                { code: 'C45.0', label: 'Мезотелиома плевры' },
                { code: 'C45.1', label: 'Мезотелиома брюшины' },
                { code: 'C45.2', label: 'Мезотелиома перикарда' },
                { code: 'C45.7', label: 'Мезотелиома других локализаций' },
                { code: 'C45.9', label: 'Мезотелиома неуточненная' },
                { code: 'C46.0', label: 'Саркома Капоши кожи' },
                { code: 'C46.1', label: 'Саркома Капоши мягких тканей' },
                { code: 'C46.2', label: 'Саркома Капоши неба' },
                { code: 'C46.3', label: 'Саркома Капоши лимфатических узлов' },
                { code: 'C46.7', label: 'Саркома Капоши других локализаций' },
                { code: 'C46.8', label: 'Саркома Капоши множественных органов' },
                { code: 'C46.9', label: 'Саркома Капоши неуточненной локализации' },
                { code: 'C47.0', label: 'Злокачественное новообразование периферических нервов головы, лица и шеи' },
                { code: 'C47.1', label: 'Злокачественное новообразование периферических нервов верхней конечности, включая область плечевого пояса' },
                { code: 'C47.2', label: 'Злокачественное новообразование периферических нервов нижней конечности, включая тазобедренную область' },
                { code: 'C47.3', label: 'Злокачественное новообразование периферических нервов грудной клетки' },
                { code: 'C47.4', label: 'Злокачественное новообразование периферических нервов живота' },
                { code: 'C47.5', label: 'Злокачественное новообразование периферических нервов таза' },
                { code: 'C47.6', label: 'Злокачественное новообразование периферических нервов туловища неуточненное' },
                { code: 'C47.8', label: 'Злокачественное новообразование периферических нервов и вегетативной нервной системы, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C47.9', label: 'Злокачественное новообразование периферических нервов и вегетативной нервной системы неуточненной локализации' },
                { code: 'C48.0', label: 'Злокачественное новообразование забрюшинного пространства' },
                { code: 'C48.1', label: 'Злокачественное новообразование уточненных частей брюшины' },
                { code: 'C48.2', label: 'Злокачественное новообразование брюшины неуточненной части' },
                { code: 'C48.8', label: 'Злокачественное новообразование забрюшинного пространства и брюшины, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C49.0', label: 'Злокачественное новообразование соединительной и мягких тканей головы, лица и шеи' },
                { code: 'C49.1', label: 'Злокачественное новообразование соединительной и мягких тканей верхней конечности, включая область плечевого пояса' },
                { code: 'C49.2', label: 'Злокачественное новообразование соединительной и мягких тканей нижней конечности, включая тазобедренную область' },
                { code: 'C49.3', label: 'Злокачественное новообразование соединительной и мягких тканей грудной клетки' },
                { code: 'C49.4', label: 'Злокачественное новообразование соединительной и мягких тканей живота' },
                { code: 'C49.5', label: 'Злокачественное новообразование соединительной и мягких тканей таза' },
                { code: 'C49.6', label: 'Злокачественное новообразование соединительной и мягких тканей туловища неуточненной локализации' },
                { code: 'C49.8', label: 'Злокачественное новообразование соединительной и мягких тканей, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C49.9', label: 'Злокачественное новообразование соединительной и мягких тканей неуточненной локализации' },
                { code: 'D17.0', label: 'Доброкачественное новообразование жировой ткани кожи и подкожной клетчатки головы, лица и шеи' },
                { code: 'D17.1', label: 'Доброкачественное новообразование жировой ткани кожи и подкожной клетчатки туловища' },
                { code: 'D17.2', label: 'Доброкачественное новообразование жировой ткани кожи и подкожной клетчатки конечностей' },
                { code: 'D17.3', label: 'Доброкачественное новообразование жировой ткани кожи и подкожной клетчатки других и неуточненных локализаций' },
                { code: 'D17.4', label: 'Доброкачественное новообразование жировой ткани органов грудной клетки' },
                { code: 'D17.5', label: 'Доброкачественное новообразование жировой ткани внутрибрюшных органов' },
                { code: 'D17.6', label: 'Доброкачественное новообразование жировой ткани семенного канатика' },
                { code: 'D17.7', label: 'Доброкачественное новообразование жировой ткани других локализаций' },
                { code: 'D17.9', label: 'Доброкачественное новообразование жировой ткани неуточненной локализации' },
                { code: 'D18.0', label: 'Гемангиома любой локализации' },
                { code: 'D18.1', label: 'Лимфангиома любой локализации' },
                { code: 'D19.1', label: 'Доброкачественное новообразование мезотелиальной ткани брюшины' },
                { code: 'D19.7', label: 'Доброкачественное новообразование мезотелиальной ткани других локализаций' },
                { code: 'D19.9', label: 'Доброкачественное новообразование мезотелиальной ткани неуточненной локализации' },
                { code: 'D20.0', label: 'Доброкачественное новообразование мягких тканей забрюшинного пространства' },
                { code: 'D20.1', label: 'Доброкачественное новообразование брюшины' },
                { code: 'D21.0', label: 'Доброкачественное новообразование соединительной и других мягких тканей головы, лица и шеи' },
                { code: 'D21.1', label: 'Доброкачественное новообразование соединительной и других мягких тканей верхней конечности, включая область плечевого пояса' },
                { code: 'D21.2', label: 'Доброкачественное новообразование соединительной и других мягких тканей нижней конечности, включая тазобедренную область' },
                { code: 'D21.3', label: 'Доброкачественное новообразование соединительной и других мягких тканей грудной клетки' },
                { code: 'D21.4', label: 'Доброкачественное новообразование соединительной и других мягких тканей живота' },
                { code: 'D21.5', label: 'Доброкачественное новообразование соединительной и других мягких тканей таза' },
                { code: 'D21.6', label: 'Доброкачественное новообразование соединительной и других мягких тканей туловища неуточненной части' },
                { code: 'D21.9', label: 'Доброкачественное новообразование соединительной и других мягких тканей неуточненной локализации' },
                { code: 'D36.1', label: 'Доброкачественное новообразование периферических нервов и вегетативной нервной системы' },
                { code: 'D48.5', label: 'Новообразование неопределённого или неизвестного характера кожи' },
            ]
        },
        breast: {
            label: 'Молочная железа',
            diagnoses: [
                { code: 'C50.0', label: 'Злокачественное новообразование соска и ареолы молочной железы' },
                { code: 'C50.1', label: 'Злокачественное новообразование центральной части молочной железы' },
                { code: 'C50.2', label: 'Злокачественное новообразование верхневнутреннего квадранта молочной железы' },
                { code: 'C50.3', label: 'Злокачественное новообразование нижневнутреннего квадранта молочной железы' },
                { code: 'C50.4', label: 'Злокачественное новообразование верхненаружного квадранта молочной железы' },
                { code: 'C50.5', label: 'Злокачественное новообразование нижненаружного квадранта молочной железы' },
                { code: 'C50.6', label: 'Злокачественное новообразование подмышечной задней части молочной железы' },
                { code: 'C50.8', label: 'Злокачественное новообразование молочной железы, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C50.9', label: 'Злокачественное новообразование молочной железы неуточненной части' },
                { code: 'D05.0', label: 'Дольковая карцинома in situ молочной железы' },
                { code: 'D05.1', label: 'Внутрипротоковая карцинома in situ молочной железы' },
                { code: 'D05.7', label: 'Другая карцинома in situ молочной железы' },
                { code: 'D05.9', label: 'Карцинома in situ молочной железы неуточненная' },
                { code: 'D48.6', label: 'Новообразование неопределённого или неизвестного характера молочной железы' },
                { code: 'D24', label: 'Доброкачественное новообразование молочной железы' },
            ]
        },
        female_genital: {
            label: 'Женские половые органы',
            diagnoses: [
                { code: 'C51.0', label: 'Злокачественное новообразование большой срамной губы' },
                { code: 'C51.1', label: 'Злокачественное новообразование малой срамной губы' },
                { code: 'C51.2', label: 'Злокачественное новообразование клитора' },
                { code: 'C51.8', label: 'Злокачественное новообразование вульвы, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C51.9', label: 'Злокачественное новообразование вульвы неуточненной части' },
                { code: 'C52', label: 'Злокачественное новообразование влагалища' },
                { code: 'C53.0', label: 'Злокачественное новообразование внутренней части шейки матки' },
                { code: 'C53.1', label: 'Злокачественное новообразование наружной части шейки матки' },
                { code: 'C53.8', label: 'Злокачественное новообразование шейки матки, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C53.9', label: 'Злокачественное новообразование шейки матки неуточненной части' },
                { code: 'C54.0', label: 'Злокачественное новообразование перешейка матки' },
                { code: 'C54.1', label: 'Злокачественное новообразование эндометрия' },
                { code: 'C54.2', label: 'Злокачественное новообразование миометрия' },
                { code: 'C54.3', label: 'Злокачественное новообразование дна матки' },
                { code: 'C54.8', label: 'Злокачественное новообразование тела матки, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C54.9', label: 'Злокачественное новообразование тела матки неуточненной локализации' },
                { code: 'C55', label: 'Злокачественное новообразование матки неуточненной локализации' },
                { code: 'C56', label: 'Злокачественное новообразование яичника' },
                { code: 'C57.0', label: 'Злокачественное новообразование фаллопиевой трубы' },
                { code: 'C57.1', label: 'Злокачественное новообразование широкой связки матки' },
                { code: 'C57.2', label: 'Злокачественное новообразование круглой связки матки' },
                { code: 'C57.3', label: 'Злокачественное новообразование параметрия' },
                { code: 'C57.4', label: 'Злокачественное новообразование придатков матки неуточненных' },
                { code: 'C57.7', label: 'Злокачественное новообразование других уточненных женских половых органов' },
                { code: 'C57.8', label: 'Злокачественное новообразование женских половых органов, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C57.9', label: 'Злокачественное новообразование женских половых органов неуточненной локализации' },
                { code: 'C58', label: 'Злокачественное новообразование плаценты' },
                { code: 'D06.0', label: 'Карцинома in situ внутренней части шейки матки' },
                { code: 'D06.1', label: 'Карцинома in situ наружной части шейки матки' },
                { code: 'D06.7', label: 'Карцинома in situ других частей шейки матки' },
                { code: 'D06.9', label: 'Карцинома in situ шейки матки неуточненной части' },
                { code: 'D07.0', label: 'Карцинома in situ эндометрия' },
                { code: 'D07.1', label: 'Карцинома in situ вульвы' },
                { code: 'D07.2', label: 'Карцинома in situ влагалища' },
                { code: 'D07.3', label: 'Карцинома in situ других и неуточненных женских половых органов' },
                { code: 'D39.0', label: 'Новообразование неопределённого или неизвестного характера матки' },
                { code: 'D39.1', label: 'Новообразование неопределённого или неизвестного характера яичника' },
                { code: 'D25.0', label: 'Подслизистая лейомиома матки' },
                { code: 'D25.1', label: 'Интрамуральная лейомиома матки' },
                { code: 'D25.2', label: 'Субсерозная лейомиома матки' },
                { code: 'D25.9', label: 'Лейомиома матки неуточненная' },
                { code: 'D26.0', label: 'Другие доброкачественные новообразования шейки матки' },
                { code: 'D26.1', label: 'Другие доброкачественные новообразования тела матки' },
                { code: 'D26.7', label: 'Другие доброкачественные новообразования других частей матки' },
                { code: 'D26.9', label: 'Другие доброкачественные новообразования матки неуточненной части' },
                { code: 'D27', label: 'Доброкачественное новообразование яичника' },
                { code: 'D28.0', label: 'Доброкачественное новообразование вульвы' },
                { code: 'D28.1', label: 'Доброкачественное новообразование влагалища' },
                { code: 'D28.2', label: 'Доброкачественное новообразование маточных труб и связок' },
                { code: 'D28.7', label: 'Доброкачественное новообразование других уточненных женских половых органов' },
                { code: 'D28.9', label: 'Доброкачественное новообразование женских половых органов неуточненной локализации' },
            ]
        },
        male_genital: {
            label: 'Мужские половые органы',
            diagnoses: [
                { code: 'C60.0', label: 'Крайней плоти' },
                { code: 'C60.1', label: 'Головки полового члена' },
                { code: 'C60.2', label: 'Тела полового члена' },
                { code: 'C60.8', label: 'Поражение полового члена, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C60.9', label: 'Полового члена неуточненной локализации' },
                { code: 'C61', label: 'Злокачественное новообразование предстательной железы' },
                { code: 'C62.0', label: 'Неопустившегося яичка' },
                { code: 'C62.1', label: 'Опущенного яичка' },
                { code: 'C62.9', label: 'Яичка неуточненное' },
                { code: 'C63.0', label: 'Придатка яичка' },
                { code: 'C63.1', label: 'Семенного канатика' },
                { code: 'C63.2', label: 'Мошонки' },
                { code: 'C63.7', label: 'Других уточнённых мужских половых органов' },
                { code: 'C63.8', label: 'Поражение мужских половых органов, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C63.9', label: 'Мужских половых органов неуточненной локализации' },
                { code: 'D07.4', label: 'Карцинома in situ полового члена' },
                { code: 'D07.5', label: 'Карцинома in situ предстательной железы' },
                { code: 'D07.6', label: 'Карцинома in situ других и неуточненных мужских половых органов' },
                { code: 'D40.0', label: 'Новообразование неопределённого или неизвестного характера предстательной железы' },
                { code: 'D29.0', label: 'Доброкачественное новообразование полового члена' },
                { code: 'D29.1', label: 'Доброкачественное новообразование предстательной железы' },
                { code: 'D29.2', label: 'Доброкачественное новообразование яичка' },
                { code: 'D29.3', label: 'Доброкачественное новообразование придатка яичка' },
                { code: 'D29.4', label: 'Доброкачественное новообразование мошонки' },
                { code: 'D29.7', label: 'Доброкачественное новообразование других мужских половых органов' },
                { code: 'D29.9', label: 'Доброкачественное новообразование мужских половых органов неуточненной локализации' },
            ]
        },
        urinary: {
            label: 'Мочевыделительная система',
            diagnoses: [
                { code: 'C64', label: 'Злокачественное новообразование почки, кроме почечной лоханки' },
                { code: 'C65', label: 'Злокачественное новообразование почечных лоханок' },
                { code: 'C66', label: 'Злокачественное новообразование мочеточника' },
                { code: 'C67.0', label: 'Треугольника мочевого пузыря' },
                { code: 'C67.1', label: 'Купола мочевого пузыря' },
                { code: 'C67.2', label: 'Боковой стенки мочевого пузыря' },
                { code: 'C67.3', label: 'Передней стенки мочевого пузыря' },
                { code: 'C67.4', label: 'Задней стенки мочевого пузыря' },
                { code: 'C67.5', label: 'Шейки мочевого пузыря' },
                { code: 'C67.6', label: 'Мочеточникового отверстия' },
                { code: 'C67.7', label: 'Первичного мочевого протока (урахуса)' },
                { code: 'C67.8', label: 'Поражение мочевого пузыря, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C67.9', label: 'Мочевого пузыря неуточненной части' },
                { code: 'C68.0', label: 'Уретры' },
                { code: 'C68.1', label: 'Парауретральных желез' },
                { code: 'C68.8', label: 'Поражение мочевых органов, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C68.9', label: 'Мочевых органов неуточненное' },
                { code: 'D09.0', label: 'Карцинома in situ мочевого пузыря' },
                { code: 'D09.1', label: 'Карцинома in situ других и неуточненных мочевых органов' },
                { code: 'D41.0', label: 'Новообразование неопределённого или неизвестного характера почки' },
                { code: 'D41.1', label: 'Новообразование неопределённого или неизвестного характера почечной лоханки' },
                { code: 'D41.2', label: 'Новообразование неопределённого или неизвестного характера мочеточника' },
                { code: 'D41.4', label: 'Новообразование неопределённого или неизвестного характера мочевого пузыря' },
                { code: 'D30.0', label: 'Доброкачественное новообразование почки' },
                { code: 'D30.1', label: 'Доброкачественное новообразование почечных лоханок' },
                { code: 'D30.2', label: 'Доброкачественное новообразование мочеточника' },
                { code: 'D30.3', label: 'Доброкачественное новообразование мочевого пузыря' },
                { code: 'D30.4', label: 'Доброкачественное новообразование мочеиспускательного канала' },
                { code: 'D30.7', label: 'Доброкачественное новообразование других мочевых органов' },
                { code: 'D30.9', label: 'Доброкачественное новообразование мочевых органов неуточненных' },
            ]
        },
        eye: {
            label: 'Глаз и придаточный аппарат',
            diagnoses: [
                { code: 'C69.0', label: 'Конъюнктивы' },
                { code: 'C69.1', label: 'Роговицы' },
                { code: 'C69.2', label: 'Сетчатки' },
                { code: 'C69.3', label: 'Сосудистой оболочки' },
                { code: 'C69.4', label: 'Ресничного [цилиарного] тела' },
                { code: 'C69.5', label: 'Слёзной железы и протока' },
                { code: 'C69.6', label: 'Глазницы' },
                { code: 'C69.8', label: 'Поражение глаза и его придаточного аппарата, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C69.9', label: 'Глаза неуточненной части' },
                { code: 'D09.2', label: 'Карцинома in situ глаза' },
                { code: 'D31.0', label: 'Доброкачественное новообразование конъюнктивы' },
                { code: 'D31.1', label: 'Доброкачественное новообразование роговицы' },
                { code: 'D31.2', label: 'Доброкачественное новообразование сетчатки' },
                { code: 'D31.3', label: 'Доброкачественное новообразование сосудистой оболочки' },
                { code: 'D31.4', label: 'Доброкачественное новообразование ресничного тела' },
                { code: 'D31.5', label: 'Доброкачественное новообразование слезной железы и протока' },
                { code: 'D31.6', label: 'Доброкачественное новообразование глазницы неуточненной части' },
                { code: 'D31.9', label: 'Доброкачественное новообразование глаза неуточненной части' },
            ]
        },
        nervous_system: {
            label: 'Нервная система (головной и спинной мозг, нервы)',
            diagnoses: [
                { code: 'C70.0', label: 'Оболочек головного мозга' },
                { code: 'C70.1', label: 'Оболочек спинного мозга' },
                { code: 'C70.9', label: 'Мозговых оболочек неуточненных' },
                { code: 'C71.0', label: 'Большого мозга, кроме долей и желудочков' },
                { code: 'C71.1', label: 'Лобной доли' },
                { code: 'C71.2', label: 'Височной доли' },
                { code: 'C71.3', label: 'Теменной доли' },
                { code: 'C71.4', label: 'Затылочной доли' },
                { code: 'C71.5', label: 'Желудочка мозга' },
                { code: 'C71.6', label: 'Мозжечка' },
                { code: 'C71.7', label: 'Ствола мозга' },
                { code: 'C71.8', label: 'Поражение, выходящее за пределы одной и более вышеуказанных локализаций головного мозга' },
                { code: 'C71.9', label: 'Головного мозга неуточненной локализации' },
                { code: 'C72.0', label: 'Спинного мозга' },
                { code: 'C72.1', label: 'Конского хвоста' },
                { code: 'C72.2', label: 'Обонятельного нерва' },
                { code: 'C72.3', label: 'Зрительного нерва' },
                { code: 'C72.4', label: 'Слухового нерва' },
                { code: 'C72.5', label: 'Других и неуточненных черепных нервов' },
                { code: 'C72.8', label: 'Поражение головного мозга и других отделов центральной нервной системы, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C72.9', label: 'Центральной нервной системы неуточненного отдела' },
                { code: 'D32.0', label: 'Доброкачественное новообразование оболочек головного мозга' },
                { code: 'D32.1', label: 'Доброкачественное новообразование оболочек спинного мозга' },
                { code: 'D32.9', label: 'Доброкачественное новообразование оболочек мозга неуточненных' },
                { code: 'D33.0', label: 'Доброкачественное новообразование головного мозга над мозговым наметом' },
                { code: 'D33.1', label: 'Доброкачественное новообразование головного мозга под мозговым наметом' },
                { code: 'D33.2', label: 'Доброкачественное новообразование головного мозга неуточненное' },
                { code: 'D33.3', label: 'Доброкачественное новообразование черепных нервов' },
                { code: 'D33.4', label: 'Доброкачественное новообразование спинного мозга' },
                { code: 'D33.7', label: 'Доброкачественное новообразование других уточненных частей центральной нервной системы' },
                { code: 'D33.9', label: 'Доброкачественное новообразование центральной нервной системы неуточненной локализации' },
            ]
        },
        endocrine: {
            label: 'Эндокринные железы',
            diagnoses: [
                { code: 'C73', label: 'Злокачественное новообразование щитовидной железы' },
                { code: 'C74.0', label: 'Коры надпочечника' },
                { code: 'C74.1', label: 'Мозгового слоя надпочечника' },
                { code: 'C74.9', label: 'Надпочечника неуточненной части' },
                { code: 'C75.0', label: 'Паращитовидной [околощитовидной] железы' },
                { code: 'C75.1', label: 'Гипофиза' },
                { code: 'C75.2', label: 'Краниофарингеального протока' },
                { code: 'C75.3', label: 'Шишковидной железы' },
                { code: 'C75.4', label: 'Каротидного гломуса' },
                { code: 'C75.5', label: 'Аортального гломуса и других параганглиев' },
                { code: 'C75.8', label: 'Поражение более, чем одной эндокринной железы, неуточненное' },
                { code: 'C75.9', label: 'Эндокринной железы неуточненной' },
                { code: 'D09.3', label: 'Карцинома in situ щитовидной и других эндокринных желез' },
                { code: 'D44.0', label: 'Новообразование неопределённого или неизвестного характера щитовидной железы' },
                { code: 'D34', label: 'Доброкачественное новообразование щитовидной железы' },
                { code: 'D35.0', label: 'Доброкачественное новообразование надпочечника' },
                { code: 'D35.1', label: 'Доброкачественное новообразование паращитовидной [околощитовидной] железы' },
                { code: 'D35.2', label: 'Доброкачественное новообразование гипофиза' },
                { code: 'D35.3', label: 'Доброкачественное новообразование краниофарингеального протока' },
                { code: 'D35.4', label: 'Доброкачественное новообразование шишковидной железы' },
                { code: 'D35.5', label: 'Доброкачественное новообразование каротидного гломуса' },
                { code: 'D35.6', label: 'Доброкачественное новообразование аортального гломуса и других параганглиев' },
                { code: 'D35.7', label: 'Доброкачественное новообразование других уточненных эндокринных желез' },
                { code: 'D35.8', label: 'Доброкачественное новообразование более чем одной эндокринной железы' },
                { code: 'D35.9', label: 'Доброкачественное новообразование эндокринной железы неуточненной' },
            ]
        },
        lymphoid_hematopoietic: {
            label: 'Лимфоидная, кроветворная и родственные ткани (лимфомы, лейкозы, миелома)',
            diagnoses: [
                { code: 'C81.0', label: 'Лимфоидное преобладание' },
                { code: 'C81.1', label: 'Нодулярный склероз' },
                { code: 'C81.2', label: 'Смешанно-клеточный вариант' },
                { code: 'C81.3', label: 'Лимфоидное истощение' },
                { code: 'C81.7', label: 'Другие формы болезни Ходжкина' },
                { code: 'C81.9', label: 'Болезнь Ходжкина неуточненная' },
                { code: 'C82.0', label: 'Мелкоклеточная с расщеплёнными ядрами, фолликулярная' },
                { code: 'C82.1', label: 'Смешанная, мелкоклеточная с расщеплёнными ядрами и крупноклеточная, фолликулярная' },
                { code: 'C82.2', label: 'Крупноклеточная, фолликулярная' },
                { code: 'C82.7', label: 'Другие типы фолликулярной неходжкинской лимфомы' },
                { code: 'C82.9', label: 'Фолликулярная неходжкинская лимфома неуточненная' },
                { code: 'C83.0', label: 'Мелкоклеточная (диффузная)' },
                { code: 'C83.1', label: 'Мелкоклеточная с расщеплёнными ядрами (диффузная)' },
                { code: 'C83.2', label: 'Смешанная мелко- и крупноклеточная (диффузная)' },
                { code: 'C83.3', label: 'Крупноклеточная (диффузная)' },
                { code: 'C83.4', label: 'Иммунобластная (диффузная)' },
                { code: 'C83.5', label: 'Лимфобластная (диффузная)' },
                { code: 'C83.6', label: 'Недифференцированная (диффузная)' },
                { code: 'C83.7', label: 'Опухоль Беркитта' },
                { code: 'C83.8', label: 'Другие типы диффузных неходжкинских лимфом' },
                { code: 'C83.9', label: 'Диффузная неходжкинская лимфома неуточненная' },
                { code: 'C84.0', label: 'Грибовидный микоз' },
                { code: 'C84.1', label: 'Болезнь Сезари' },
                { code: 'C84.2', label: 'Лимфома T-зоны' },
                { code: 'C84.3', label: 'Лимфоэпителиоидная лимфома' },
                { code: 'C84.4', label: 'Периферическая T-клеточная лимфома' },
                { code: 'C84.5', label: 'Другие и неуточненные T-клеточные лимфомы' },
                { code: 'C85.0', label: 'Лимфосаркома' },
                { code: 'C85.1', label: 'B-клеточная лимфома неуточненная' },
                { code: 'C85.7', label: 'Другие уточнённые типы неходжкинской лимфомы' },
                { code: 'C85.9', label: 'Неходжкинская лимфома неуточненного типа' },
                { code: 'C88.0', label: 'Макроглобулинемия Вальденстрема' },
                { code: 'C88.1', label: 'Болезнь альфа-тяжёлых цепей' },
                { code: 'C88.2', label: 'Болезнь гамма-тяжёлых цепей' },
                { code: 'C88.3', label: 'Иммунопролиферативная болезнь тонкого кишечника' },
                { code: 'C88.7', label: 'Другие злокачественные иммунопролиферативные болезни' },
                { code: 'C88.9', label: 'Злокачественные иммунопролиферативные болезни неуточненные' },
                { code: 'C90.0', label: 'Множественная миелома' },
                { code: 'C90.1', label: 'Плазмоклеточный лейкоз' },
                { code: 'C90.2', label: 'Плазмоцитома экстрамедуллярная' },
                { code: 'C91.0', label: 'Острый лимфобластный лейкоз' },
                { code: 'C91.1', label: 'Хронический лимфоцитарный лейкоз' },
                { code: 'C91.2', label: 'Подострый лимфоцитарный лейкоз' },
                { code: 'C91.3', label: 'Пролимфоцитарный лейкоз' },
                { code: 'C91.4', label: 'Волосатоклеточный лейкоз' },
                { code: 'C91.5', label: 'T-клеточный лейкоз взрослых' },
                { code: 'C91.7', label: 'Другой уточнённый лимфоидный лейкоз' },
                { code: 'C91.9', label: 'Лимфоидный лейкоз неуточненный' },
                { code: 'C92.0', label: 'Острый миелоидный лейкоз' },
                { code: 'C92.1', label: 'Хронический миелоидный лейкоз' },
                { code: 'C92.2', label: 'Подострый миелоидный лейкоз' },
                { code: 'C92.3', label: 'Миелоидная саркома' },
                { code: 'C92.4', label: 'Острый промиелоцитарный лейкоз' },
                { code: 'C92.5', label: 'Острый миеломоноцитарный лейкоз' },
                { code: 'C92.7', label: 'Другой миелоидный лейкоз' },
                { code: 'C92.9', label: 'Миелоидный лейкоз неуточненный' },
                { code: 'C93.0', label: 'Острый моноцитарный лейкоз' },
                { code: 'C93.1', label: 'Хронический моноцитарный лейкоз' },
                { code: 'C93.2', label: 'Подострый моноцитарный лейкоз' },
                { code: 'C93.7', label: 'Другой моноцитарный лейкоз' },
                { code: 'C93.9', label: 'Моноцитарный лейкоз неуточненный' },
                { code: 'C94.0', label: 'Острая эритремия и эритролейкоз' },
                { code: 'C94.1', label: 'Хроническая эритремия' },
                { code: 'C94.2', label: 'Острый мегакариобластный лейкоз' },
                { code: 'C94.3', label: 'Тучноклеточный лейкоз' },
                { code: 'C94.4', label: 'Острый панмиелоз' },
                { code: 'C94.5', label: 'Острый миелофиброз' },
                { code: 'C94.7', label: 'Другой уточнённый лейкоз' },
                { code: 'C95.0', label: 'Острый лейкоз неуточненного клеточного типа' },
                { code: 'C95.1', label: 'Хронический лейкоз неуточненного клеточного типа' },
                { code: 'C95.2', label: 'Подострый лейкоз неуточненного клеточного типа' },
                { code: 'C95.7', label: 'Другой лейкоз неуточненного клеточного типа' },
                { code: 'C95.9', label: 'Лейкоз неуточненный' },
                { code: 'C96.0', label: 'Болезнь Леттерера-Сиве' },
                { code: 'C96.1', label: 'Злокачественный гистиоцитоз' },
                { code: 'C96.2', label: 'Злокачественная тучноклеточная опухоль' },
                { code: 'C96.3', label: 'Истинная гистиоцитарная лимфома' },
                { code: 'C96.7', label: 'Другие уточнённые злокачественные новообразования лимфоидной, кроветворной и родственных им тканей' },
                { code: 'C96.9', label: 'Злокачественное новообразование лимфоидной, кроветворной и родственных им тканей неуточненное' },
                { code: 'D36.0', label: 'Доброкачественное новообразование лимфатических узлов' },
            ]
        },
        ill_defined_multiple: {
            label: 'Неуточненная / множественная локализация',
            diagnoses: [
                { code: 'C76.0', label: 'Головы, лица и шеи' },
                { code: 'C76.1', label: 'Грудной клетки' },
                { code: 'C76.2', label: 'Живота' },
                { code: 'C76.3', label: 'Таза' },
                { code: 'C76.4', label: 'Верхней конечности' },
                { code: 'C76.5', label: 'Нижней конечности' },
                { code: 'C76.7', label: 'Других неуточненных локализаций' },
                { code: 'C76.8', label: 'Поражение других и неточно обозначенных локализаций, выходящее за пределы одной и более вышеуказанных локализаций' },
                { code: 'C80.0', label: 'Злокачественное новообразование неизвестной первичной локализации, так обозначенное' },
                { code: 'C80.9', label: 'Злокачественное новообразование неуточненное' },
                { code: 'C97', label: 'Злокачественное новообразование самостоятельных (первичных) множественных локализаций' },
                { code: 'D09.7', label: 'Карцинома in situ других уточненных локализаций' },
                { code: 'D09.9', label: 'Карцинома in situ неуточненной локализации' },
                { code: 'D36.7', label: 'Доброкачественное новообразование других уточненных локализаций' },
                { code: 'D36.9', label: 'Доброкачественное новообразование неуточненной локализации' },
            ]
        },
        uncertain_unknown_behavior: {
            label: 'Новообразования неопределённого или неизвестного характера',
            diagnoses: [
                { code: 'D37.0', label: 'Новообразование неопределённого или неизвестного характера губы, полости рта и глотки' },
                { code: 'D37.1', label: 'Новообразование неопределённого или неизвестного характера желудка' },
                { code: 'D37.2', label: 'Новообразование неопределённого или неизвестного характера тонкого кишечника' },
                { code: 'D37.3', label: 'Новообразование неопределённого или неизвестного характера аппендикса' },
                { code: 'D37.4', label: 'Новообразование неопределённого или неизвестного характера ободочной кишки' },
                { code: 'D37.5', label: 'Новообразование неопределённого или неизвестного характера прямой кишки' },
                { code: 'D37.6', label: 'Новообразование неопределённого или неизвестного характера печени, желчного пузыря и желчных протоков' },
                { code: 'D37.7', label: 'Новообразование неопределённого или неизвестного характера других органов пищеварения' },
                { code: 'D37.9', label: 'Новообразование неопределённого или неизвестного характера органа пищеварения неуточнённого' },
                { code: 'D38.0', label: 'Новообразование неопределённого или неизвестного характера гортани' },
                { code: 'D38.1', label: 'Новообразование неопределённого или неизвестного характера трахеи, бронха и лёгкого' },
                { code: 'D38.2', label: 'Новообразование неопределённого или неизвестного характера плевры' },
                { code: 'D38.3', label: 'Новообразование неопределённого или неизвестного характера средостения' },
                { code: 'D38.4', label: 'Новообразование неопределённого или неизвестного характера вилочковой железы' },
                { code: 'D38.5', label: 'Новообразование неопределённого или неизвестного характера других органов дыхания' },
                { code: 'D38.6', label: 'Новообразование неопределённого или неизвестного характера органа дыхания неуточнённого' },
                { code: 'D39.0', label: 'Новообразование неопределённого или неизвестного характера матки' },
                { code: 'D39.1', label: 'Новообразование неопределённого или неизвестного характера яичника' },
                { code: 'D39.2', label: 'Новообразование неопределённого или неизвестного характера плаценты' },
                { code: 'D39.7', label: 'Новообразование неопределённого или неизвестного характера других женских половых органов' },
                { code: 'D39.9', label: 'Новообразование неопределённого или неизвестного характера женского полового органа неуточнённого' },
                { code: 'D40.0', label: 'Новообразование неопределённого или неизвестного характера предстательной железы' },
                { code: 'D40.1', label: 'Новообразование неопределённого или неизвестного характера яичка' },
                { code: 'D40.7', label: 'Новообразование неопределённого или неизвестного характера других мужских половых органов' },
                { code: 'D40.9', label: 'Новообразование неопределённого или неизвестного характера мужского полового органа неуточнённого' },
                { code: 'D41.0', label: 'Новообразование неопределённого или неизвестного характера почки' },
                { code: 'D41.1', label: 'Новообразование неопределённого или неизвестного характера почечной лоханки' },
                { code: 'D41.2', label: 'Новообразование неопределённого или неизвестного характера мочеточника' },
                { code: 'D41.3', label: 'Новообразование неопределённого или неизвестного характера уретры' },
                { code: 'D41.4', label: 'Новообразование неопределённого или неизвестного характера мочевого пузыря' },
                { code: 'D41.7', label: 'Новообразование неопределённого или неизвестного характера других мочевых органов' },
                { code: 'D41.9', label: 'Новообразование неопределённого или неизвестного характера мочевого органа неуточнённого' },
                { code: 'D42.0', label: 'Новообразование неопределённого или неизвестного характера мозговых оболочек' },
                { code: 'D42.1', label: 'Новообразование неопределённого или неизвестного характера спинномозговых оболочек' },
                { code: 'D42.9', label: 'Новообразование неопределённого или неизвестного характера оболочек центральной нервной системы неуточнённых' },
                { code: 'D43.0', label: 'Новообразование неопределённого или неизвестного характера головного мозга над намётом' },
                { code: 'D43.1', label: 'Новообразование неопределённого или неизвестного характера головного мозга под намётом' },
                { code: 'D43.2', label: 'Новообразование неопределённого или неизвестного характера головного мозга неуточнённой локализации' },
                { code: 'D43.3', label: 'Новообразование неопределённого или неизвестного характера черепных нервов' },
                { code: 'D43.4', label: 'Новообразование неопределённого или неизвестного характера спинного мозга' },
                { code: 'D43.7', label: 'Новообразование неопределённого или неизвестного характера других частей центральной нервной системы' },
                { code: 'D43.9', label: 'Новообразование неопределённого или неизвестного характера центральной нервной системы неуточнённой' },
                { code: 'D44.0', label: 'Новообразование неопределённого или неизвестного характера щитовидной железы' },
                { code: 'D44.1', label: 'Новообразование неопределённого или неизвестного характера надпочечника' },
                { code: 'D44.2', label: 'Новообразование неопределённого или неизвестного характера паращитовидной железы' },
                { code: 'D44.3', label: 'Новообразование неопределённого или неизвестного характера гипофиза' },
                { code: 'D44.4', label: 'Новообразование неопределённого или неизвестного характера краниофарингеального протока' },
                { code: 'D44.5', label: 'Новообразование неопределённого или неизвестного характера шишковидной железы' },
                { code: 'D44.6', label: 'Новообразование неопределённого или неизвестного характера каротидного тела' },
                { code: 'D44.7', label: 'Новообразование неопределённого или неизвестного характера аортального тела' },
                { code: 'D44.8', label: 'Новообразование неопределённого или неизвестного характера нескольких эндокринных желез' },
                { code: 'D44.9', label: 'Новообразование неопределённого или неизвестного характера эндокринной железы неуточнённой' },
                { code: 'D45', label: 'Истинная полицитемия' },
                { code: 'D46', label: 'Миелодиспластические синдромы' },
                { code: 'D47.0', label: 'Опухоли тучных клеток неопределённого или неизвестного характера' },
                { code: 'D47.1', label: 'Хроническое миелопролиферативное заболевание' },
                { code: 'D47.2', label: 'Моноклональная гаммапатия неопределённого значения' },
                { code: 'D47.3', label: 'Эссенциальная тромбоцитемия' },
                { code: 'D47.7', label: 'Другие уточнённые новообразования лимфоидной, кроветворной и родственных им тканей неопределённого или неизвестного характера' },
                { code: 'D47.9', label: 'Новообразование лимфоидной, кроветворной и родственных им тканей неопределённого или неизвестного характера неуточнённое' },
                { code: 'D48.0', label: 'Новообразование неопределённого или неизвестного характера костей и суставных хрящей' },
                { code: 'D48.1', label: 'Новообразование неопределённого или неизвестного характера соединительной и мягких тканей' },
                { code: 'D48.2', label: 'Новообразование неопределённого или неизвестного характера периферических нервов и вегетативной нервной системы' },
                { code: 'D48.3', label: 'Новообразование неопределённого или неизвестного характера забрюшинного пространства' },
                { code: 'D48.4', label: 'Новообразование неопределённого или неизвестного характера брюшины' },
                { code: 'D48.5', label: 'Новообразование неопределённого или неизвестного характера кожи' },
                { code: 'D48.6', label: 'Новообразование неопределённого или неизвестного характера молочной железы' },
                { code: 'D48.7', label: 'Новообразование неопределённого или неизвестного характера других уточнённых локализаций' },
                { code: 'D48.9', label: 'Новообразование неопределённого или неизвестного характера неуточнённой локализации' },
            ]
        },
    },

    // Регламентные сроки указаны для приоритета "Обычный".
    // Для "Высокий" применяется коэффициент 0.7, для "Срочно" — 0.5.
    nosologyData: {
        prostate: {
            label: 'Предстательная железа',
            stage1Days: 10, stage2Standard: 4, stage2StageIV: 11,
            checklistRequired: ['Направление на биопсию', 'Выполнение биопсии', 'Гистологическое исследование', 'Оценка результатов гистологии'],
            checklistOptional: ['ИГХ-исследование', 'Сцинтиграфия костей (ПСА>20, Глисон 4+3, подозрение на метастазы)', 'КТ ОБП (при неинформативности УЗИ)', 'Оценка функционального статуса']
        },
        breast: {
            label: 'Молочная железа',
            stage1Days: 9, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['УЗИ молочной железы и лимфатических узлов', 'Биопсия молочной железы и/или л/у (или пункция)', 'Гистологическое исследование', 'Общий анализ крови', 'Биохимический анализ крови', 'Коагулограмма', 'Анализы на ВИЧ, гепатит В и С', 'УЗИ ОБП и малого таза', 'ЭКГ', 'КТ или рентген ОГК'],
            checklistOptional: ['Сцинтиграфия костей (боли в костях, повышенная ЩФ)', 'КТ/МРТ ОБП с контрастом', 'ПЭТ/КТ (по показаниям)', 'Оценка функционального статуса']
        },
        stomach: {
            label: 'Желудок',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['КТ ОГК, ОБП, ОМТ с контрастом', 'Гистологическое исследование'],
            checklistOptional: ['Колоноскопия (если не выполнялась в течение года)', 'Оценка функционального статуса'],
            checklistRequiredStage2: ['Дообследование по функциональному статусу (при необходимости)', 'ИГХ/МГИ исследования (по показаниям)']
        },
        colon: {
            label: 'Толстая кишка',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['КТ ОГК, ОБП, ОМТ с контрастом', 'МРТ ОМТ с контрастом (при поражении ректосигмоида/прямой кишки)', 'Маркеры крови СА19.9, РЭА', 'Общий анализ крови', 'Коагулограмма', 'Анализы на ВИЧ, RW, гепатиты В и С', 'ЭКГ', 'Гистологическое исследование'],
            checklistOptional: ['ИГХ/МГИ', 'Сцинтиграфия костей (подозрение на метастазы)', 'Консультация акушера-гинеколога (жен., ЗНО прямой кишки)', 'Соскоб с шейки матки (жен.)', 'Маркер крови SCC (жен., ЗНО прямой кишки)', 'Гастроскопия', 'МРТ ОБП']
        },
        ovary: {
            label: 'Яичники',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['ЭКГ', 'МРТ ОМТ с контрастом', 'КТ ОГК и ОБП с контрастом', 'Колоноскопия + гастроскопия', 'УЗИ вен нижних конечностей', 'УЗИ молочных желез/маммография'],
            checklistOptional: ['Забор асцитической жидкости для цитологии'],
            checklistRequiredStage2: ['Цитологическое исследование (если делался забор асцитической жидкости)', 'Функциональная оценка статуса']
        },
        uterus: {
            label: 'Тело матки',
            stage1Days: 10, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['МРТ ОМТ с контрастом', 'КТ ОГК, ОБП с контрастом', 'Колоноскопия + гастроскопия', 'Биохимический анализ крови', 'Коагулограмма'],
            checklistOptional: ['Анализ крови на маркер СА-125']
        },
        skin: {
            label: 'Кожа',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['Общий анализ крови', 'Анализы на ВИЧ, гепатиты В и С', 'Коагулограмма', 'Биохимический анализ крови', 'Забор материала на цитологию', 'Биопсия', 'Гистологическое исследование'],
            checklistOptional: ['УЗИ регионарных лимфатических узлов', 'Пункция регионарных лимфатических узлов', 'ЭКГ', 'Дерматоскопия'],
            checklistOptionalStage2: ['КТ или МРТ поражённой области с контрастом', 'УЗИ регионарных лимфатических узлов', 'Пункция регионарных лимфатических узлов']
        },
        lung12: {
            label: 'Легкое',
            stage1Days: 14, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['КТ ОГК и ОБП с контрастом', 'Анализ на ВИЧ', 'Гепатит В и С', 'Общий анализ крови', 'Биохимический анализ крови', 'Коагулограмма', 'ЭКГ', 'ФВД', 'Консультация терапевта/пульмонолога', 'ЭГДС', 'Колоноскопия'],
            checklistOptional: ['УЗДГ вен нижних конечностей', 'МРТ головного мозга с контрастом (подозрение на метастазы в ГМ)', 'ПЭТ/КТ или сцинтиграфия костей', 'МРТ ОБП', 'УЗИ ОБП и лимфоузлов']
        },
        lung34: {
            label: 'Легкое',
            stage1Days: 14, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['Рентген ОГК или КТ ОГК (солидный очаг >9мм)', 'КТ ОГК и ОБП с контрастом', 'ВИЧ, гепатит В и С', 'Общий анализ крови', 'Биохимический анализ', 'Коагулограмма', 'ЭКГ', 'ФВД', 'Консультация терапевта/пульмонолога', 'Направление на бронхоскопию', 'УЗИ лимфоузлов', 'ЭГДС + колоноскопия', 'УЗДГ вен нижних конечностей', 'УЗИ ОБП и лимфоузлов', 'Консультации профильных специалистов', 'Гистология (после бронхоскопии)', 'Гистологическое исследование', 'ИГХ и генетические исследования'],
            checklistOptional: ['МРТ ГМ с контрастом', 'ПЭТ/КТ или сцинтиграфия костей', 'УЗДГ сосудов/артерий', 'Дообследование функционального статуса']
        },
        melanoma: {
            label: 'Меланома',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['Общий анализ крови', 'Биохимический анализ крови', 'Коагулограмма', 'ЭКГ', 'УЗИ регионарных лимфатических узлов', 'Гистологическое исследование', 'При >5мм: КТ ОГК/ОБП/ОМТ с контрастом, МРТ ГМ с контрастом, пункция л/у', 'При <5мм: эксцизионная панч-биопсия'],
            checklistOptional: ['Пересмотр гистологических препаратов', 'КТ ОГК/ОБП/ОМТ с контрастом', 'МРТ головного мозга с контрастом', 'Пункция лимфатических узлов', 'ПЭТ/КТ']
        },
        bladder: {
            label: 'Мочевой пузырь',
            stage1Days: 10, stage2Standard: 4, stage2StageIV: 11,
            checklistRequired: ['Цистоскопия с биопсией/ТУР', 'Гистологическое исследование'],
            checklistOptional: ['Сцинтиграфия костей (боли в костях, повышенная ЩФ, подозрение на метастазы)']
        },
        headneckConfirmed: {
            label: 'Голова и шея (диагноз подтвержден)',
            stage1Days: 10, stage2Standard: 7, stage2StageIV: 7,
            checklistRequired: ['УЗИ лимфатических узлов', 'ЭГДС', 'КТ органов грудной клетки', 'КТ ОБП/ЗП/ОМТ с контрастом (или УЗИ)', 'ЭКГ', 'Направление на биопсию', 'Выполнение биопсии', 'Гистологическое исследование'],
            checklistOptional: ['Пункция лимфатических узлов', 'Эхо-КГ', 'УЗДГ брахиоцефальных сосудов', 'МРТ головы и шеи с контрастом (гортань/гортаноглотка)', 'ПЭТ/КТ (гортаноглотка, гортань, Т3-4, N1-3)', 'ИГХ/МГИ']
        },
        headneckSuspected: {
            label: 'Голова и шея (подозрение на ЗНО)',
            stage1Days: 10, stage2Standard: 4, stage2StageIV: 11,
            checklistRequired: ['Биопсия образования', 'Гистологическое исследование', 'УЗИ лимфатических узлов', 'ЭГДС', 'КТ органов грудной клетки', 'КТ ОБП/ОМТ с контрастом (или УЗИ)'],
            checklistOptional: ['Пункция лимфоузлов', 'УЗДГ БЦС', 'Эхо-КГ', 'ПЭТ/КТ (гортаноглотка, гортань, Т3-4, N1-3)', 'МРТ головы и шеи с контрастом (гортань/гортаноглотка)']
        },
        liver: {
            label: 'Печень',
            stage1Days: 14, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['Онкомаркер СА-19-9', 'Онкомаркер АФП', 'Онкомаркер РЭА', 'КТ ОГК и ОМТ с контрастом'],
            checklistOptional: ['МРТ головного мозга с контрастом (подозрение на метастазы)', 'ЭХО-КГ', 'УЗИ вен нижних конечностей', 'УЗИ брахиоцефальных артерий (старше 50 лет)']
        },
        pancreas: {
            label: 'Поджелудочная железа',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['Онкомаркер СА-19,9', 'EUS + биопсия (или транскутанная биопсия)', 'Цитологическое исследование', 'Гистологическое исследование'],
            checklistOptional: ['Доп. биохимический анализ (альбумин, гамма-ГТ, АЛТ, АСТ, билирубин)', 'МГИ']
        },
        thyroidSuspected: {
            label: 'Щитовидная железа (подозрение на ЗНО)',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['Пункция узла щитовидной железы и/или лимфоузла', 'Цитологическое исследование', 'Гистологическое исследование', 'ЭГДС', 'КТ ОГК с контрастом', 'КТ ОБП/ОМТ с контрастом (или УЗИ)', 'ЭКГ'],
            checklistOptional: ['Эхо-КГ', 'КТ/МРТ шеи с контрастом', 'Сцинтиграфия костей', 'Сцинтиграфия щитовидной железы']
        },
        thyroidConfirmed: {
            label: 'Щитовидная железа (диагноз подтвержден)',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 11,
            checklistRequired: ['ЭГДС', 'КТ ОГК с контрастом', 'КТ ОБП/ОМТ с контрастом (или УЗИ)', 'ЭКГ'],
            checklistOptional: ['КТ/МРТ шеи с контрастом', 'Эхо-КГ', 'Сцинтиграфия костей', 'Сцинтиграфия щитовидной железы']
        },
        cervixInvasive: {
            label: 'Шейка матки (инвазивный рак)',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 11,
            checklistRequired: ['МРТ ОМТ с контрастом', 'КТ ОГК', 'УЗИ ОБП', 'УЗИ ЗП', 'Колоноскопия', 'Гастроскопия', 'УЗИ вен нижних конечностей', 'Анализ крови на SCC'],
            checklistOptional: ['КТ ОБП с контрастом', 'Сцинтиграфия костей (если невозможно ПЭТ/КТ)', 'ПЭТ/КТ']
        },
        cervixCytology: {
            label: 'Шейка матки (подтверждено по цитологии)',
            stage1Days: 10, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['МРТ ОМТ с контрастом', 'КТ ОГК', 'УЗИ ОБП', 'УЗИ ЗП', 'Колоноскопия', 'Гастроскопия', 'УЗИ вен нижних конечностей', 'Анализ крови на SCC'],
            checklistOptional: ['КТ ОБП с контрастом', 'Сцинтиграфия костей (если невозможно ПЭТ/КТ)', 'ПЭТ/КТ']
        },
        kidney: {
            label: 'Почка',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['Гистологическое исследование'],
            checklistOptional: ['МРТ головного мозга с контрастом (неврологическая симптоматика)', 'ЭГДС', 'Колоноскопия', 'Динамическая нефросцинтиграфия', 'Сцинтиграфия костей (боли в костях, повышенная ЩФ, подозрение на метастазы)']
        },
        upperUrinary: {
            label: 'Верхние мочевые пути',
            stage1Days: 7, stage2Standard: 4, stage2StageIV: 7,
            checklistRequired: ['Цистоскопия', 'Гистологическое исследование'],
            checklistOptional: ['ЭГДС', 'Колоноскопия', 'Динамическая нефросцинтиграфия', 'Цитологическое исследование мочи', 'Сцинтиграфия костей (боли в костях, повышенная ЩФ, подозрение на метастазы)']
        }
    },

    getPriorityFactor(priority) {
        if (priority === 'urgent') return 0.5;
        if (priority === 'high') return 0.7;
        return 1.0;
    },

    allDiagnosisOptions() {
        return Object.entries(this.icd10Localizations).flatMap(([localization, item]) =>
            item.diagnoses.map(d => ({ ...d, localization, localizationLabel: item.label }))
        );
    },

    filterDiagnosisOptions(localization, query) {
        const q = String(query || '').trim().toLowerCase();
        const selectedLocalization = this.icd10Localizations[localization];
        const source = selectedLocalization
            ? ((selectedLocalization && selectedLocalization.diagnoses) || []).map(d => ({
                ...d,
                localization,
                localizationLabel: selectedLocalization.label,
            }))
            : this.allDiagnosisOptions();
        const filtered = q
            ? source.filter(d =>
                d.code.toLowerCase().includes(q) ||
                d.label.toLowerCase().includes(q) ||
                d.localizationLabel.toLowerCase().includes(q)
            )
            : source;
        return filtered.slice(0, 120);
    },

    diagnosisOptionNodes(localization, query, selected) {
        const items = this.filterDiagnosisOptions(localization, query);
        if (!items.length) return [option('', 'Ничего не найдено', !selected)];
        return [
            option('', 'Выберите диагноз', !selected),
            ...items.map(d => option(d.code, `${d.code} — ${d.label}`, d.code === selected)),
        ];
    },

    suggestedNosologyForDiagnosis(code) {
        const normalized = String(code || '').trim().toUpperCase();
        const exact = {
            'D00.0': 'headneckConfirmed',
            'D00.2': 'stomach',
            'D01.0': 'colon',
            'D01.1': 'colon',
            'D01.2': 'colon',
            'D01.5': 'liver',
            'D02.0': 'headneckConfirmed',
            'D02.2': 'lung12',
            'D07.0': 'uterus',
            D05: 'breast',
            D06: 'cervixCytology',
            'D07.5': 'prostate',
            'D09.0': 'bladder',
            'D09.1': 'upperUrinary',
            'D09.3': 'thyroidConfirmed',
            'D37.0': 'headneckConfirmed',
            'D37.1': 'stomach',
            'D37.3': 'colon',
            'D37.4': 'colon',
            'D37.5': 'colon',
            'D37.6': 'liver',
            'D38.0': 'headneckConfirmed',
            'D38.1': 'lung12',
            'D39.0': 'uterus',
            'D39.1': 'ovary',
            'D40.0': 'prostate',
            'D41.0': 'kidney',
            'D41.1': 'upperUrinary',
            'D41.2': 'upperUrinary',
            'D41.4': 'bladder',
            'D44.0': 'thyroidSuspected',
            'D48.5': 'skin',
            'D48.6': 'breast',
        };
        if (exact[normalized]) return exact[normalized];
        const prefixes = [
            ['C61', 'prostate'], ['C50', 'breast'], ['C16', 'stomach'],
            ['C18', 'colon'], ['C19', 'colon'], ['C20', 'colon'], ['C21', 'colon'],
            ['C56', 'ovary'], ['C54', 'uterus'], ['C55', 'uterus'],
            ['C44', 'skin'], ['C43', 'melanoma'], ['C34', 'lung12'],
            ['C67', 'bladder'], ['C22', 'liver'], ['C25', 'pancreas'],
            ['C73', 'thyroidSuspected'], ['C53', 'cervixInvasive'],
            ['C64', 'kidney'], ['C65', 'upperUrinary'], ['C66', 'upperUrinary'],
            ['C00', 'headneckConfirmed'], ['C01', 'headneckConfirmed'], ['C02', 'headneckConfirmed'],
            ['C03', 'headneckConfirmed'], ['C04', 'headneckConfirmed'], ['C05', 'headneckConfirmed'],
            ['C06', 'headneckConfirmed'], ['C07', 'headneckConfirmed'], ['C08', 'headneckConfirmed'],
            ['C09', 'headneckConfirmed'], ['C10', 'headneckConfirmed'], ['C11', 'headneckConfirmed'],
            ['C12', 'headneckConfirmed'], ['C13', 'headneckConfirmed'], ['C14', 'headneckConfirmed'],
            ['C30', 'headneckConfirmed'], ['C31', 'headneckConfirmed'], ['C32', 'headneckConfirmed'],
        ];
        const byPrefix = prefixes.find(([prefix]) => normalized === prefix || normalized.startsWith(`${prefix}.`) || normalized.startsWith(prefix));
        if (byPrefix) return byPrefix[1];
        if (normalized.startsWith('D03.')) return 'melanoma';
        if (normalized.startsWith('D04.')) return 'skin';
        if (normalized.startsWith('D05.')) return 'breast';
        if (normalized.startsWith('D06.')) return 'cervixCytology';
        return '';
    },

    clientPathForLocalization(localization) {
        const groupedPaths = {
            lip_oral_pharynx: ['headneckConfirmed', 'headneckSuspected'],
            esophagus_stomach_intestine: ['stomach', 'colon'],
            liver_biliary_pancreas: ['liver', 'pancreas'],
            respiratory_thoracic: ['lung12', 'lung34'],
            bone_cartilage: [],
            skin: ['skin', 'melanoma'],
            soft_tissue_peritoneum: [],
            breast: ['breast'],
            female_genital: ['ovary', 'uterus', 'cervixInvasive', 'cervixCytology'],
            male_genital: ['prostate'],
            urinary: ['kidney', 'upperUrinary', 'bladder'],
            eye: [],
            nervous_system: [],
            endocrine: ['thyroidSuspected', 'thyroidConfirmed'],
            lymphoid_hematopoietic: [],
            ill_defined_multiple: [],
            uncertain_unknown_behavior: [
                'headneckConfirmed', 'stomach', 'colon', 'liver', 'uterus', 'ovary',
                'prostate', 'kidney', 'upperUrinary', 'bladder', 'thyroidSuspected',
                'skin', 'breast',
            ],
        };
        const profiles = groupedPaths[localization] || [];
        return profiles.find(profile => this.nosologyData[profile]) || '';
    },

    clientPathStatusNode(nosology) {
        if (nosology && this.nosologyData[nosology]) {
            return el('div', { class: 'client-path-status client-path-status--ok' }, [
                el('strong', { text: 'Клиентский путь определён' }),
                el('span', { text: 'Сроки будут рассчитываться автоматически.' }),
            ]);
        }
        return el('div', { class: 'client-path-status client-path-status--info' }, [
            el('strong', { text: 'Для данной локализации клиентский путь не настроен.' }),
            el('span', { text: 'Сроки для данной локализации рассчитываться не будут.' }),
        ]);
    },

    updateClientPathStatus() {
        const target = $('clientPathStatus');
        if (!target) return;
        const nosology = this.clientPathForLocalization($('diagnosisLocalization').value);
        target.replaceChildren(this.clientPathStatusNode(nosology));
    },

    stageNames: {
        'primary-appointment': 'Первичный прием',
        'exam': 'На обследовании',
        'appointment': 'Записан на прием',
        'consult': 'Направлен на ОК',
        'treatment-prep': 'Направлен на лечение',
        'treatment': 'Проходит лечение',
        'completed': 'Завершил лечение',
        'dispensary-observation': 'Диспансерное наблюдение',
        'diagnosis-not-confirmed': 'Диагноз не подтверждён',
    },

    stageOrder: ['primary-appointment', 'exam', 'appointment', 'consult', 'treatment-prep', 'treatment', 'completed'],
    terminalStages: ['completed', 'dispensary-observation', 'diagnosis-not-confirmed'],
    stageFilterOrder: ['primary-appointment', 'exam', 'appointment', 'consult', 'treatment-prep', 'treatment', 'completed', 'dispensary-observation', 'diagnosis-not-confirmed'],

    stageShortLabels: {
        'primary-appointment': 'Первичный приём',
        exam: 'Обследование',
        appointment: 'Приём',
        consult: 'Онкоконсилиум',
        'treatment-prep': 'Направление',
        treatment: 'Лечение',
        completed: 'Завершено',
        'dispensary-observation': 'Наблюдение',
        'diagnosis-not-confirmed': 'Не подтверждён',
    },


    PRIORITY_LABELS: { urgent: 'Срочно', high: 'Высокий', normal: 'Обычный' },
    TREATMENT_LABELS: { surgery: 'Хирургическое лечение', radiation: 'Лучевая терапия', chemo: 'Химиотерапия', hormone: 'Гормонотерапия' },
    TREATMENT_OPTIONS: ['', 'surgery', 'radiation', 'chemo', 'hormone'],
    CONSILIUM_DECISION_LABELS: {
        treatment_strategy_defined: 'Определение тактики лечения',
        treatment_strategy_changed: 'Изменение тактики лечения',
        dispensary_observation: 'Диспансерное наблюдение',
    },
    PGI_RESULT_LABELS: {
        '': 'Не указано',
        confirmed: 'Подтверждено',
        not_confirmed: 'Не подтверждено',
    },

    /* ---------------------------------------------------------------- Запуск */

    /** Подсказка интерфейсу; сервер проверяет каждое действие заново. */
    can(permission) {
        return !!(this.user && this.user.permissions && this.user.permissions[permission]);
    },

    isReadOnly() {
        return this.can('readOnly');
    },

    setIdleDeadline(value, remaining) {
        const deadline = Date.now() + (Number.isFinite(remaining) ? remaining * 1000 : Date.parse(value) - Date.now());
        if (!Number.isFinite(deadline)) return;
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => { if (this.user && !this.sessionExpired) this.expireSession(); }, Math.max(0, deadline - Date.now()));
    },

    async reportInteractiveActivity(event) {
        if (!event.isTrusted || !this.user || this.sessionExpired || this.sessionReconciling) return;
        const now = performance.now();
        if (this.activityPending || (this.lastActivitySent !== undefined && now - this.lastActivitySent < 30000)) return;
        this.activityPending = true;
        this.lastActivitySent = now;
        try { await apiPost('/api/auth/activity', {}); }
        catch (error) { /* apiFetch applies the existing session/context lock; drafts stay in memory. */ }
        finally { this.activityPending = false; }
    },

    async init() {
        for (const type of ['input', 'keydown', 'pointerdown']) {
            document.addEventListener(type, event => { void this.reportInteractiveActivity(event); }, {capture: true, passive: true});
        }
        this.applyTheme(localStorage.getItem('theme') || 'dark');
        this.bindStaticControls();
        try {
            const me = await apiGetJson('/api/auth/me');
            if (me && me.authenticated) {
                this.user = me.user;
                if (this.user.mustChangePassword) this.showForcePasswordForm();
                else await this.enterApp();
            }
        } catch (e) {
            this.showLoginFailure(e);
        }
    },

    showLoginFailure(error) {
        $('loginScreen').classList.remove('is-hidden');
        $('appScreen').classList.add('is-hidden');
        $('loginError').textContent = error.message;
        $('loginError').classList.remove('is-hidden');
    },

    showForcePasswordForm() {
        $('loginScreen').classList.remove('is-hidden');
        $('appScreen').classList.add('is-hidden');
        $('loginForm').classList.add('is-hidden');
        $('forcePasswordForm').classList.remove('is-hidden');
        $('forceCurrentPassword').focus();
    },

    async enterApp() {
        $('loginScreen').classList.add('is-hidden');
        $('appScreen').classList.remove('is-hidden');
        this.applyRoleUI();
        await this.loadPatients();
        await this.loadActivity();
        await this.loadDoctors();
        await this.loadHeadOptions();
        this.fillStaticSelects();
        await this.updateUnresolvedBanner();
        await this.refreshAIStatus();
        await this.refreshInternalNotificationSummary();
        if (!this.internalNotifications.pollTimer) {
            this.internalNotifications.pollTimer = window.setInterval(() => {
                if (document.visibilityState === 'visible' && this.user) {
                    this.refreshInternalNotificationSummary();
                }
            }, 30000);
        }
        this.showView('patients');
        browserNavigation.reset();
        if (this.can('importData')) this.maybeOfferLegacyMigration();
        this.appReady = true;
    },

    /** Скрыть недоступные разделы и действия по правам роли. Скрытие кнопок —
     *  только удобство: backend отклоняет запрещённые запросы в любом случае. */
    applyRoleUI() {
        const u = this.user || { fullName: '', roleLabel: '', departments: [], permissions: {} };
        $('profileName').textContent = u.fullName || '';
        $('profileRole').textContent = u.roleLabel || '';
        const depts = u.departments || [];
        const deptsEl = $('profileDepartments');
        const toggle = $('profileDeptsToggle');
        const list = $('profileDeptsList');
        list.classList.add('is-hidden');
        toggle.setAttribute('aria-expanded', 'false');
        if (depts.length === 0) {
            deptsEl.textContent = '';
            toggle.classList.add('is-hidden');
        } else if (depts.length === 1) {
            deptsEl.textContent = depts[0].name;
            toggle.classList.add('is-hidden');
        } else {
            // Компактно: «2 подразделения» с раскрытием полного списка
            deptsEl.textContent = '';
            toggle.textContent = `${depts.length} ${this.pluralize(depts.length, 'подразделение', 'подразделения', 'подразделений')}`;
            toggle.classList.remove('is-hidden');
            list.replaceChildren(frag(depts.map(d => el('li', { text: d.name }))));
        }

        const chair = u.roleId === 'consilium_chair';
        const navVisibility = this.navigationVisibility();
        for (const item of document.querySelectorAll('.nav__item')) {
            const view = item.dataset.view;
            if (view in navVisibility) item.classList.toggle('is-hidden', !navVisibility[view]);
        }

        $('readOnlyChip').classList.toggle('is-hidden', !this.isReadOnly());
        $('openAddBtn').classList.toggle('is-hidden', !this.can('createPatients'));
        $('openConsiliumBookingBtn').classList.add('is-hidden');
        $('openConsiliumHistoryBtn').classList.toggle('is-hidden',!this.can('accessConsilium'));
        $('openConsiliumArchiveBtn').classList.toggle('is-hidden', !this.can('bookConsilium'));
        $('appScreen').classList.toggle('can-collapse-sidebar', chair);
        if (!chair) $('appScreen').classList.remove('is-sidebar-collapsed');
        const chairDesktop = chair && window.matchMedia('(min-width: 861px)').matches;
        const sidebarCollapsed = $('appScreen').classList.contains('is-sidebar-collapsed');
        $('sidebarToggle').setAttribute('aria-expanded', chairDesktop && !sidebarCollapsed ? 'true' : 'false');
        $('sidebarToggle').setAttribute('aria-label', chairDesktop
            ? (sidebarCollapsed ? 'Развернуть меню' : 'Свернуть меню')
            : 'Меню');
        $('consiliumChairCalendar').classList.remove('is-hidden');
        $('consiliumChairDateActions').classList.toggle('is-hidden', !chair);
        $('consiliumDoctorDateActions').classList.toggle('is-hidden', chair);
        $('consiliumScheduleEditor').classList.remove('is-hidden');
        $('consiliumScheduleManagement').classList.toggle('is-hidden', !chair);
        $('consiliumChairScheduleToolbar').classList.toggle('is-hidden', !chair);
        $('consiliumDoctorScheduleToolbar').classList.toggle('is-hidden', chair);
        // WP2.3-B3: задним числом — слот создает только председатель, запись
        // оформляет только заведующий отделением (сервер проверяет то же).
        $('consiliumBackdatedSlotBtn').classList.toggle('is-hidden', u.roleId !== 'consilium_chair');
        $('consiliumBackdatedApptBtn').classList.toggle('is-hidden', u.roleId !== 'department_head');
        $('consiliumChairScheduleWrap').classList.toggle('is-hidden', !chair);
        $('consiliumDoctorScheduleWrap').classList.toggle('is-hidden', chair);
        $('consiliumCalendarLabel').textContent = 'День и консилиумная группа';
        $('consiliumCalendarHint').textContent = 'Выберите один день и нужную группу для просмотра сетки свободных и занятых слотов.';
        // WP2.3-B2: вычисляемой недели нет — слоты создает только председатель.
        $('consiliumScheduleDescription').textContent = chair
            ? 'Создайте слоты на сегодня или будущую дату. Время указывается по Москве.'
            : 'Выберите дату, на которую председатель создал расписание. Время указывается по Москве.';
        $('consiliumSubtitle').textContent = chair
            ? 'Все пациенты клиники, записанные на консилиум, в хронологическом порядке'
            : 'Пациенты вашей области, записанные на рассмотрение консилиумной группой';
        $('consiliumScheduleNote').textContent = chair
            ? 'Врачи и заведующие записывают пациентов только в созданные вами слоты, время которых еще не наступило.'
            : 'Запись возможна только в свободные слоты председателя, время которых еще не наступило.';
        $('triggerImportBtn').classList.toggle('is-hidden', !this.can('importData'));
        $('openExportBtn').classList.toggle('is-hidden', !this.can('exportData'));
        $('openDataSheetBtn').classList.toggle(
            'is-hidden', !(this.can('importData') || this.can('exportData')));
    },

    pluralize(n, one, few, many) {
        const mod10 = n % 10, mod100 = n % 100;
        if (mod10 === 1 && mod100 !== 11) return one;
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
        return many;
    },

    async loadDoctors() {
        this.doctors = [];
        if (!this.can('createPatients') || ['doctor', 'consilium_chair'].includes(this.user.roleId)) return;
        try {
            const data = await apiGetJson('/api/users/doctors');
            this.doctors = data.doctors || [];
        } catch (e) {
            // Селект просто останется пустым; создание отклонит сервер.
        }
    },

    /* --------------------------------------------------------------- Данные */

    patientPageQuery(cursor = null, extra = {}) {
        const p = new URLSearchParams({view: 'page', limit: '50', sort: this.sortOrder || 'updated-newest', ...extra});
        for (const [key, value] of Object.entries({q: this.searchQuery, stage: this.stageFilter, head: this.headFilter, deadline: this.deadlineFilter, attention: this.attentionFilter, attention_reason: this.attentionReasonFilter})) if (value) p.set(key, value);
        if (this.includeTerminal && !p.has('include_terminal')) p.set('include_terminal', 'true');
        if (cursor) p.set('cursor', cursor);
        return p;
    },

    setPatientListState(state, message = '') {
        this.patientListState = state;
        const busy = state === 'loading';
        $('view-patients').setAttribute('aria-busy', String(busy));
        $('patientListLoading').hidden = !busy;
        $('patientListError').hidden = state !== 'error';
        $('patientListErrorText').textContent = message;
        $('patientRegistrySummary').hidden = state !== 'ready';
        $('patientRegistryResults').hidden = state !== 'ready';
        $('patientRegistryResults').inert = busy || state === 'error';
        if (state !== 'ready') $('patientRegistryCount').textContent = '—';
        else if (this.patientPage) $('patientRegistryCount').textContent = String(this.patientPage.summary.total);
    },

    async loadPatients(cursor = null, restarted = false) {
        const version = this.beginRead('patients');
        const query = String(this.patientPageQuery());
        this.setPatientListState('loading');
        this.renderPatientFilterChips();
        try {
            const params = new URLSearchParams(query);
            if (cursor) params.set('cursor', cursor);
            const path = '/api/patients?' + params;
            let data;
            try { data = await apiGetJson(path); }
            catch (error) {
                if (!this.isCurrentRead('patients', version)) return;
                if (!restarted && [409, 410].includes(error.status) && ['PATIENT_QUERY_CHANGED', 'CURSOR_EXPIRED'].includes(error.data?.code)) {
                    ui.toast('Список изменился. Выдача обновлена; фильтры, выбранная карточка и черновики сохранены.', 'warning');
                    // Exactly one controlled restart, never a retry loop.
                    data = await apiGetJson('/api/patients?' + query);
                    if (await this.reconcileSelectedDetails(version)) {
                        throw Object.assign(new Error('Доступ к карточке изменился. Обновите список.'),
                            {status: 409, data: {code: 'PATIENT_QUERY_CHANGED'}});
                    }
                    if (this.isCurrentRead('patients', version)) { this.pageTrail = [null]; this.pageIndex = 0; }
                } else throw error;
            }
            if (!this.isCurrentRead('patients', version) || query !== String(this.patientPageQuery())) return;
            if (!cursor) { this.pageTrail = [null]; this.pageIndex = 0; }
            this.patientRows = data.patients; this.patientPage = data; this.patientListDirty=false;
            this.releasedRegistryQuery = query;
            this.renderPatientPagination();
            this.setPatientListState('ready');
        } catch (error) {
            if (this.isCurrentRead('patients', version) && !error.obsolete) this.setPatientListState('error', error.message);
            throw error;
        }
    },

    async reconcileSelectedDetails(version) {
        const ids=[...new Set([this.currentPatientId,...[...(this.sessionFieldDrafts||new Map()).values()].map(d=>d.patientId)].filter(Boolean))];
        const fresh=[];
        for(let i=0;i<ids.length;i+=50){const data=await apiGetJson('/api/patients/resolve?ids='+encodeURIComponent(ids.slice(i,i+50).join(',')));fresh.push(...data.patients);}
        if(!this.isCurrentRead('patients',version))return;
        const allowed=new Set(fresh.map(p=>p.id));
        this.sessionFieldDrafts=this.collectSessionFieldDrafts(this.user,fresh,allowed);
        this.patientDetails=new Map(fresh.map(p=>[p.id,p]));
        if (this.currentPatientId && !allowed.has(this.currentPatientId)) this.forgetDeniedPatient(this.currentPatientId, {refreshRegistry: false});
        this.renderSessionFieldDrafts();
        return ids.some(id => !allowed.has(id));
    },

    async changePatientPage(direction) {
        if (this.pageLoading || !this.patientPage) return;
        let index = this.pageIndex + direction;
        if (index < 0 || (direction > 0 && !this.patientPage.page.hasNext)) return;
        if (direction > 0) this.pageTrail[index] = this.patientPage.page.nextCursor;
        const epoch = this.sessionEpoch;
        const navigation = browserNavigation.generation;
        const paging = {};
        this.pageLoading = paging;
        // The loading state makes the pager inert. Move focus out before that,
        // and only complete the handoff if the user stays on the anchor.
        const anchor = $('patientRegistryTitle');
        let ownsPagerFocus = document.hasFocus() && !ui.topModal() &&
            $('patientPagination')?.contains(document.activeElement);
        const releaseFocus = () => { ownsPagerFocus = false; };
        if (ownsPagerFocus) {
            anchor.tabIndex = -1;
            anchor.focus({preventScroll: true});
            ownsPagerFocus = document.activeElement === anchor;
            if (ownsPagerFocus) anchor.addEventListener('focusout', releaseFocus, {once: true});
        }

        const request = this.loadPatients(this.pageTrail[index]);
        const read = this.readVersions.patients;
        const current = () => epoch === this.sessionEpoch && navigation === browserNavigation.generation &&
            this.currentView === 'patients' && !this.sessionReconciling && this.isCurrentRead('patients', read);
        const ownsFocus = () => ownsPagerFocus && document.hasFocus() && document.activeElement === anchor && !ui.topModal();
        try {
            await request;
            if (!current() || this.patientListState !== 'ready') return;
            if (this.patientPage?.page.offset === index * 50) this.pageIndex = index;
            this.renderPatients(); this.renderPatientPagination();
            if (ownsFocus()) $('patientPageStatus')?.focus();
        } catch (error) {
            if (!current() || error.obsolete) return;
            ui.toast(error.message, 'danger');
            const retry = $('retryPatientListBtn');
            if (error.status === 409 && error.data?.code === 'PATIENT_QUERY_CHANGED' &&
                this.patientListState === 'error' && ownsFocus() && retry && !retry.disabled &&
                !retry.closest('[hidden], [inert], .is-hidden') && retry.getClientRects().length) {
                retry.setAttribute('aria-describedby', 'patientListErrorText');
                retry.focus();
            }
        } finally {
            anchor.removeEventListener('focusout', releaseFocus);
            if (this.pageLoading === paging) this.pageLoading = false;
        }
    },

    renderPatientPagination() {
        if (!$('patientsTable') || !this.patientPage) return;
        let host = $('patientPagination');
        if (!host) { host = el('div', {id:'patientPagination', class:'pagination', 'aria-label':'Страницы пациентов'}); $('patientsTable').closest('.table-wrap').after(host); }
        const page = this.patientPage.page;
        host.replaceChildren(frag([
            el('button', {type:'button', class:'btn btn--ghost', text:'Предыдущая страница', disabled:this.pageIndex===0, on:{click:()=>this.changePatientPage(-1)}}),
            el('span', {id:'patientPageStatus', tabindex:'-1', role:'status', 'aria-live':'polite', text:page.total ? `${page.offset+1}–${Math.min(page.offset+page.limit,page.total)} из ${page.total}` : 'Нет результатов'}),
            el('button', {type:'button', class:'btn btn--ghost', text:'Следующая страница', disabled:!page.hasNext, on:{click:()=>this.changePatientPage(1)}}),
        ]));
    },

    async loadHeadOptions(options = {}) {
        const data = await apiFetch('/api/patients/head-options', options);
        this.headOptions = data.heads || [];
    },

    /** Журнал аудита даёт человекочитаемую подпись «что изменилось» в списке. */
    async loadActivity() {
        this.activityByPatient = {};
        if (!this.can('viewAudit')) return;
        try {
            const data = await apiGetJson('/api/audit?limit=200');
            const labels = {
                patient_created: 'Пациент добавлен',
                patient_updated: 'Обновлены данные',
                patient_deleted: 'Пациент удалён',
                patient_event_deleted: 'Удалено событие маршрута',
                patient_event_restored: 'Восстановлено событие маршрута',
                import_committed: 'Импорт данных',
                migration_committed: 'Перенос данных',
            };
            for (const event of data.events) {
                if (!event.patient_id || this.activityByPatient[event.patient_id]) continue;
                let label = labels[event.event_type] || 'Изменение';
                if (event.detail && event.detail.startsWith('stage=')) label = 'Изменён этап лечения';
                this.activityByPatient[event.patient_id] = label;
            }
        } catch (e) {
            // Журнал недоступен — подпись просто не покажем.
        }
    },

    replacePatientInCache(updated) {
        if (!updated) return;
        this.patientDetails.set(updated.id, updated);
        const needed=new Set([this.currentPatientId,updated.id,$('consiliumPatient')?.value]);
        for(const id of this.patientDetails.keys())if(!needed.has(id))this.patientDetails.delete(id);
        this.patientListDirty=true;
        // A detail response is never appended as another page or counted as a registry.
        if (this.user) this.refreshInternalNotificationSummary();
    },

    getPatient(id) {
        return this.patientDetails.get(id) || null;
    },

    /* ------------------------------------------------------------ Навигация */

    navigationVisibility() {
        const role = this.user?.roleId;
        const chair = role === 'consilium_chair';
        return {
            patients: true,
            myDay: role === 'doctor',
            pulse: ['developer', 'department_head', 'deputy_chief_oncology', 'caop_head'].includes(role),
            // Видимость — подсказка; сервер проверяет каждый эндпоинт консилиума.
            consilium: this.can('accessConsilium'),
            calendar: !chair,
            notifications: !chair,
            analytics: true,
            checklists: !chair,
            quality: !chair,
            data: !chair && (this.can('importData') || this.can('exportData')),
            staff: this.can('manageUsers'),
            structure: this.can('manageDepartments'),
            duplicates: this.can('viewDuplicateRegistry'),
            audit: this.can('viewAudit'),
            settings: !chair,
        };
    },

    updateCardSourceAction() {
        const back = $('backToF1');
        const labels = {analytics: 'К аналитике', pulse: 'К пульсу клиники', myDay: 'К моему дню',
            calendar: 'К расписанию', notifications: 'К уведомлениям'};
        const label = labels[this.f1CardOrigin];
        back.hidden = this.currentView !== 'patient' || !label || !this.navigationVisibility()[this.f1CardOrigin];
        back.textContent = back.hidden ? '' : label;
    },

    showView(view, {cardOrigin} = {}) {
        if (view==='create' && !this.can('createPatients')) view='patients';
        if (this.currentView === 'create' && view !== 'create' && this.addFormActive && !this.sessionExpired) {
            void this.requestCloseAddModal(view);
            return;
        }
        this.capturePatientEdits();
        if (view === 'consilium' && !this.can('accessConsilium')) view = 'patients';
        if ((view === 'pulse' || view === 'myDay') && !this.navigationVisibility()[view]) view = 'patients';
        if(this.ai?.request){const active=view==='patient'?this.currentPatientId:null;if(active!==this.ai.request.active){this.cancelAIRequest();this.ai.messages=[];this.ai.references=[];this.ai.lastError='Контекст экрана изменился. Предыдущий ответ не используется; запрос не повторяется автоматически.';this.renderAIDrawer();}}
        const previousView = this.currentView;
        this.currentView = view;
        if (view !== 'patient') this.f1CardOrigin = null;
        else if (cardOrigin !== undefined) this.f1CardOrigin = cardOrigin;
        else if (previousView !== 'patient') {
            this.f1CardOrigin = previousView === 'pulse' || previousView === 'myDay' ? previousView : null;
        }
        this.updateCardSourceAction();
        if (previousView === 'analytics' && view !== 'analytics') this.clearAnalyticsRelease();
        if (previousView === 'pulse' && view !== 'pulse') f1Management.clear(this);
        if (previousView === 'myDay' && view !== 'myDay') f1Doctor.clear(this);
        if (this.qualityV1 && previousView !== view) {
            if (previousView === 'quality') this.qualityV1.workspace.clear(false);
            if (previousView === 'patient') {
                this.qualityV1.card?.clear(true);
                this.qualityV1.card = null;
            }
        }
        for (const section of document.querySelectorAll('.view')) {
            section.classList.toggle('is-hidden', section.id !== `view-${view}`);
        }
        for (const item of document.querySelectorAll('.nav__item')) {
            const active = item.dataset.view === view;
            item.classList.toggle('is-active', active);
            if (active) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        }
        $('appScreen').classList.remove('is-nav-open');
        $('sidebarScrim').hidden = true;
        $('sidebarToggle').setAttribute('aria-expanded', 'false');

        if (view === 'patients') {
            const source = $('backToRegistrySource');
            source.hidden = !this.registrySource || !this.navigationVisibility()[this.registrySource];
            source.textContent = source.hidden ? '' : this.registrySource === 'pulse' ? 'К пульсу клиники' : 'К моему дню';
            this.renderPatients();
            if (this.patientListDirty) void this.reloadPatientsAndRender(this.pageTrail[this.pageIndex]);
        }
        if (view === 'consilium') {
            if (previousView !== 'consilium' && !this.can('consiliumChair')) {
                this.consilium.loaded = false;
            }
            this.renderConsilium();
        }
        if (view === 'calendar') {
            const schedule = this.workspaceListState('events');
            $('eventsWorkspaceQuery').value = schedule.query;
            const back = $('backToScheduleSource');
            back.hidden = schedule.source !== 'myDay' || !this.navigationVisibility().myDay;
            back.textContent = back.hidden ? '' : 'К моему дню';
            $('scheduleNotifications').hidden = !this.navigationVisibility().notifications;
            void this.renderCalendar(schedule.trail[schedule.index]);
        }
        if (view === 'checklists') this.renderChecklistsView();
        if (view === 'notifications') {
            this.renderNotificationsPage();
        }
        if (view === 'analytics') this.renderAnalytics();
        if (view === 'pulse') f1Management.render(this);
        if (view === 'myDay') f1Doctor.render(this);
        if (view === 'quality') this.renderDataQuality();
        if (view === 'duplicates') this.renderDuplicates();
        if (view === 'audit') this.renderAudit();
        if (view === 'settings') this.renderSettings();
        if (view === 'data') this.renderMigrationPanel();
        if (view === 'staff') this.renderStaff();
        if (view === 'structure') this.renderStructure();
        window.scrollTo(0, 0);
    },

    navigateView(screen) {
        return browserNavigation.navigate({screen});
    },

    registrySettings() {
        const {searchQuery, stageFilter, headFilter, deadlineFilter, attentionFilter, attentionReasonFilter,
            sortOrder, includeTerminal} = this;
        return {searchQuery, stageFilter, headFilter, deadlineFilter, attentionFilter, attentionReasonFilter,
            sortOrder, includeTerminal};
    },

    registryContext(patientId = null) {
        const current = this.patientListState === 'ready' && this.releasedRegistryQuery === String(this.patientPageQuery());
        return {settings: this.registrySettings(), source: this.registrySource, patientId,
            index: current ? this.pageIndex : 0, trail: current ? this.pageTrail.slice(0, this.pageIndex + 1) : [null]};
    },

    openWorkingRegistry(source, filters, allowed) {
        if (source !== this.currentView || !['pulse', 'myDay'].includes(source)) return false;
        return browserNavigation.navigate({screen: 'patients', registry: {source, index: 0, trail: [null], settings: {
            searchQuery: '', stageFilter: filters.stage || null, headFilter: null, deadlineFilter: filters.deadline || null,
            attentionFilter: filters.attention || null, attentionReasonFilter: null,
            sortOrder: filters.sort || 'updated-newest', includeTerminal: filters.include_terminal === 'true',
        }}}, {allowed});
    },

    openPatient(id, tab = 'overview', options) {
        return browserNavigation.navigate({screen: 'patient', tab, patientId: id}, options);
    },

    /* ----------------------------------------------------------------- Тема */

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        const toggle = $('themeToggle');
        if (toggle) {
            // Надпись называет результат нажатия, а доступное имя — само действие.
            const target = theme === 'dark' ? 'светлую' : 'тёмную';
            toggle.textContent = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
            toggle.setAttribute('aria-label', `Переключить на ${target} тему`);
            toggle.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
        }
        const select = $('themeSelect');
        if (select) select.value = theme;
    },

    toggleTheme() {
        const next = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
        localStorage.setItem('theme', next);
        this.applyTheme(next);
    },

    /* ------------------------------------------------------------ Авторизация */

    clearScheduleAndInbox() {
        if (this.workspacePages) delete this.workspacePages.events;
        $('calendarPanel').replaceChildren();
        $('calendarPanel').removeAttribute('aria-busy');
        this.closeInternalNotificationsDrawer({restoreFocus: false});
        this.internalNotifications.fullItems = [];
        this.internalNotifications.summary = null;
        this.internalReady.full = false;
        this.internalSummaryReady = false;
        this.internalNotificationReturnId = null;
        $('internalNotificationsFullList').replaceChildren();
        this.updateInternalNotificationsBadge();
    },

    expireSession(accessChanged = false) {
        f1Management.clear(this, true);
        f1Doctor.clear(this, true);
        this.clearQualityV1(accessChanged);
        this.clearAnalyticsRelease();
        this.analytics.pendingDetails = null;
        if (this.sessionExpired || !this.user) return;
        browserNavigation.invalidate();
        this.sessionExpired = true;
        this.sessionEpoch = (this.sessionEpoch || 0) + 1;
        this.clearScheduleAndInbox();
        this.draftOwnerId = this.user.id;
        document.body.classList.add('session-locked');
        $('loginScreen').classList.remove('is-hidden');
        $('loginForm').classList.remove('is-hidden');
        $('forcePasswordForm').classList.add('is-hidden');
        $('password').value = '';
        $('username').value = this.user.username || $('username').value;
        $('loginError').textContent = apiErrorMessage(401);
        $('loginError').classList.remove('is-hidden');
        $('username').focus();
    },

    async serverIdentity() {
        try {
            const response = await fetch('/api/auth/me', {credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30000)});
            if (!response.ok) {
                const error = new Error(apiErrorMessage(response.status)); error.status = response.status; throw error;
            }
            return await response.json();
        } catch (error) {
            if (error.status) throw error;
            throw new Error(['TimeoutError', 'AbortError'].includes(error.name)
                ? 'Время ожидания проверки входа истекло. Повторите позже.' : 'Не удалось проверить вход. Проверьте соединение с сервером.');
        }
    },

    accessSignature(user) {
        return user.accessContext || JSON.stringify([user.id, user.roleId, user.permissions, user.departments]);
    },

    discardSessionAndReload() {
        f1Management.clear(this, true);
        f1Doctor.clear(this, true);
        this.clearQualityV1(true);
        this.clearAnalyticsRelease();
        document.body.classList.add('session-locked');
        browserNavigation.invalidate();
        this.sessionExpired = true;
        this.sessionEpoch = (this.sessionEpoch || 0) + 1;
        this.discardingSession = true;
        this.clearScheduleAndInbox();
        location.reload();
    },

    async checkSessionIdentity(epoch) {
        let me;
        try { me = await this.serverIdentity(); }
        catch (error) {
            if (epoch !== (this.sessionEpoch || 0)) return false;
            this.expireSession();
            throw error;
        }
        if (epoch !== (this.sessionEpoch || 0)) return false;
        if (!me.authenticated) { this.expireSession(); return false; }
        if (me.user.id !== this.user.id) { this.discardSessionAndReload(); return false; }
        if (this.accessSignature(me.user) !== this.accessSignature(this.user)) { this.expireSession(true); return false; }
        return !this.sessionExpired;
    },

    async resumeSession(expected, previousHistory) {
        // До этого барьера DOM и данные остаются закрытыми, даже если cookie уже действительна.
        const epoch = this.sessionEpoch || 0;
        const me = await this.serverIdentity();
        if (epoch !== (this.sessionEpoch || 0)) return;
        if (!me.authenticated) { this.expireSession(); return; }
        if (me.user.id !== expected.id || (this.draftOwnerId && me.user.id !== this.draftOwnerId)) {
            this.discardSessionAndReload(); return;
        }
        const user = me.user;
        const page = await apiFetch('/api/patients?' + this.patientPageQuery(), {reconcileUser: user});
        const wanted = [...new Set([this.currentPatientId, ...[...(this.sessionFieldDrafts || new Map()).values()].map(d => d.patientId)].filter(Boolean))];
        const fresh = [];
        for (let i=0; i<wanted.length; i+=50) {
            const resolved = await apiFetch('/api/patients/resolve?ids=' + encodeURIComponent(wanted.slice(i,i+50).join(',')), {reconcileUser:user});
            fresh.push(...resolved.patients);
        }
        const heads = await apiFetch('/api/patients/head-options', {reconcileUser:user});
        if(!Array.isArray(page.patients)||!page.page||!page.summary||!Array.isArray(heads.heads))throw new Error('Не удалось проверить структуру рабочего пространства. Повторите вход.');
        const listSettings = this.registrySettings();
        const doctors = user.permissions.createPatients && !['doctor', 'consilium_chair'].includes(user.roleId)
            ? (await apiFetch('/api/users/doctors', {reconcileUser: user})).doctors || [] : [];
        const final = await this.serverIdentity();
        if (epoch !== (this.sessionEpoch || 0)) return;
        if (!final.authenticated || final.user.id !== user.id || this.accessSignature(final.user) !== this.accessSignature(user)) {
            throw new Error('Вход или полномочия снова изменились. Повторите вход.');
        }
        const allowed = new Set(fresh.map(patient => patient.id));
        // Каждый повторный вход сбрасывает производные кэши, а не только текущий список.
        if (previousHistory && !browserNavigation.matchesSnapshot(previousHistory, user) && this.currentView === 'patient') {
            this.currentView = 'patients';
            this.currentPatientId = null;
        }
        const rebuiltEpoch = this.rebuildAuthorizedWorkspace(user, fresh, allowed, doctors, page, heads.heads, listSettings);
        if (this.sessionEpoch !== rebuiltEpoch || this.sessionExpired) return;
        this.sessionReconciling = false;
        document.body.classList.remove('session-locked');
        if (this.qualityV1) {
            if (this.currentView === 'patient') this.renderPatientQualityBlock(this.currentPatientId);
            else if (this.qualityV1.reopenWorkspace) this.showView('quality');
            this.qualityV1.reopenWorkspace = false;
        }
        if (!browserNavigation.resume(previousHistory)) {
            browserNavigation.reset(this.currentView === 'patient'
                ? {screen: 'patient', tab: this.currentTab, patientId: this.currentPatientId}
                : {screen: this.currentView});
        }
        $('loginScreen').classList.add('is-hidden');
        $('appScreen').classList.remove('is-hidden');
        ui.toast('Доступ проверен. Проверьте черновик и сохраните самостоятельно.', 'warning');
    },

    rebuildAuthorizedWorkspace(user, fresh, allowed, doctors, page, heads, listSettings) {
        const drafts = this.collectSessionFieldDrafts(user, fresh, allowed);
        const sameOwner=this.user?.id===user.id;
        const sameQualityAccess = sameOwner && this.accessSignature(this.user) === this.accessSignature(user);
        const qualitySetup = this.qualityV1 && {
            endpoint: this.qualityV1.endpoint,
            filters: sameQualityAccess ? {...this.qualityV1.workspace.filters} : {},
            facets: sameQualityAccess ? new Map(this.qualityV1.workspace.selectedFacets) : new Map(),
            reopenWorkspace: this.currentView === 'quality' && user.roleId !== 'consilium_chair',
        };
        const notificationInputs={owner:user.id,patientId:this.currentPatientId,patient:sameOwner&&allowed.has(this.currentPatientId)&&user.permissions.editPatients?this.notificationInputSnapshot('patient'):[],outbound:sameOwner&&user.permissions.manageNotificationTemplates?this.notificationInputSnapshot('outbound'):[]};
        const createDraft = !$('addModal').hidden && user.permissions.createPatients
            ? [...$('addForm').querySelectorAll('input, select, textarea')].map(node => [node.id, node.value, node.checked]) : null;
        const createKey = this.addPatientKey;
        const createSentBody = this.addPatientSentBody;
        const createUncertain = this.addPatientUncertain;
        const createConfirmation = this.addPatientDuplicateConfirmation;
        const patientId = this.currentView === 'patient' && allowed.has(this.currentPatientId) ? this.currentPatientId : null;
        const tab = this.currentTab;
        const prompt = patientId && ui.openModals.includes('promptModal') ? $('promptModal') : null;
        const epoch = (this.sessionEpoch || 0) + 1;
        clearInterval(this.internalNotifications.pollTimer);
        this.globalControls.abort();
        for (const key of ['pendingConfirmCancel', 'pendingPromptCancel', 'pendingChoiceCancel', 'pendingTextPromptCancel', 'pendingRegistryReasonCancel']) {
            if (key === 'pendingPromptCancel' && prompt) continue;
            if (ui[key]) ui[key]();
            ui[key] = null;
        }
        ui.openModals = []; ui.returnFocusTargets.clear();
        // Новая копия исходной разметки не содержит данных, а старые узлы и слушатели отбрасываются.
        document.body.replaceChildren(...pristineWorkspace.map(node => node.cloneNode(true)));
        for (const [key, value] of Object.entries(this)) if (typeof value !== 'function') delete this[key];
        Object.assign(this, structuredClone(pristineAppState), {user, sessionEpoch: epoch, sessionReconciling: true});
        if (qualitySetup) {
            this.mountQualityV1(qualitySetup.endpoint, qualitySetup.filters, qualitySetup.facets);
            this.qualityV1.reopenWorkspace = qualitySetup.reopenWorkspace;
        }
        this.notificationReauthDraft={...notificationInputs,epoch};
        this.bindStaticControls();
        this.patientRows = page.patients; this.patientPage = page;
        this.setPatientListState('ready');
        this.patientDetails = new Map(fresh.map(p=>[p.id,p]));
        this.headOptions = heads; Object.assign(this, listSettings);
        this.doctors = doctors;
        this.applyRoleUI();
        this.fillStaticSelects();
        this.syncRegistryControls();
        this.showView('patients');
        this.appReady = true;
        this.internalNotifications.pollTimer = window.setInterval(() => {
            if (document.visibilityState === 'visible' && this.user) this.refreshInternalNotificationSummary();
        }, 30000);
        // Обновление необязательных сводок не разрушает черновик при сетевой ошибке.
        this.refreshAIStatus();
        this.refreshInternalNotificationSummary();
        this.loadActivity();
        this.sessionFieldDrafts = drafts;
        this.renderSessionFieldDrafts();
        if (patientId) {
            this.currentPatientId = patientId;
            this.currentTab = tab;
            this.showView('patient');
            this.renderPatientView();
        }
        if (prompt) {
            $('promptModal').replaceWith(prompt);
            ui.openModals.push('promptModal');
            $('promptOkBtn').disabled = !this.can('editPatients');
            prompt.querySelectorAll('input').forEach(node => { node.disabled = !this.can('editPatients'); });
        }
        if (createDraft) {
            this.openAddModal();
            this.addPatientKey = createKey;
            this.addPatientSentBody = createSentBody;
            this.addPatientUncertain = createUncertain;
            this.addPatientDuplicateConfirmation = createConfirmation;
            for (const [id, value, checked] of createDraft) {
                const node = $(id);
                if (!node) continue;
                node.value = value;
                node.checked = checked;
            }
            this.updateStageFields();
            this.updateClientPathStatus();
            this.setAddPatientPending(false);
        }
        return epoch;
    },

    async reconcilePeerSession({preserveHistory = false} = {}) {
        if (!this.user || this.sessionReconciling) return;
        const previousHistory = preserveHistory ? browserNavigation.snapshot() || {} : null;
        this.expireSession();
        try {
            const me = await this.serverIdentity();
            if (!me.authenticated) return;
            if (me.user.id !== this.user.id) { this.discardSessionAndReload(); return; }
            await this.resumeSession(me.user, previousHistory);
        } catch (error) { this.showLoginFailure(error); }
    },

    async login(username, password) {
        authChannel?.postMessage('changing');
        let result;
        try {
            result = await apiPost('/api/auth/login', { username, password });
            if (result.stage === 'webauthn') {
                const epoch = this.sessionEpoch || 0;
                const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
                const encode = value => value == null ? null : btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                const publicKey = {...result.publicKey, challenge: decode(result.publicKey.challenge),
                    allowCredentials: result.publicKey.allowCredentials.map(c => ({...c, id: decode(c.id)}))};
                const credential = await navigator.credentials.get({publicKey});
                if (!credential || epoch !== (this.sessionEpoch || 0)) throw new Error('Повторите вход.');
                result = await apiPost('/api/auth/mfa/authenticate', {
                    id: credential.id, rawId: encode(credential.rawId), type: credential.type,
                    response: {clientDataJSON: encode(credential.response.clientDataJSON),
                        authenticatorData: encode(credential.response.authenticatorData),
                        signature: encode(credential.response.signature), userHandle: encode(credential.response.userHandle)},
                    clientExtensionResults: credential.getClientExtensionResults()
                });
            }
        }
        finally { authChannel?.postMessage('changed'); }
        if (this.sessionExpired && result.user.id !== this.draftOwnerId) { this.discardSessionAndReload(); return; }
        if (result.user.mustChangePassword) { this.user = result.user; this.showForcePasswordForm(); return; }
        if (this.sessionExpired) await this.resumeSession(result.user);
        else { this.user = result.user; await this.enterApp(); }
    },

    async submitForcedPasswordChange(currentPassword, newPassword) {
        const changed = await apiPost('/api/auth/change-password', { currentPassword, newPassword });
        if (changed.reauthenticationRequired) { this.expireSession(); return; }
        const me = await this.serverIdentity();
        if (this.sessionExpired) await this.resumeSession(me.user);
        else {
            this.user = me.user;
            $('forcePasswordForm').classList.add('is-hidden');
            $('loginForm').classList.remove('is-hidden');
            await this.enterApp();
        }
    },

    async logout() {
        authChannel?.postMessage('changing');
        this.expireSession();
        try {
            await apiPost('/api/auth/logout');
        } catch (e) {
            // Даже при сетевой ошибке сбрасываем клиентское состояние.
        }
        authChannel?.postMessage('changed');
        this.patientRows = []; this.patientDetails.clear(); this.patientPage = null;
        this.ai.messages = [];
        this.ai.references = [];
        this.ai.patientContextId = null;
        this.ai.patientContextLabel = '';
        location.reload();
    },

    /* ------------------------------------------- Перенос старых данных браузера */

    maybeOfferLegacyMigration() {
        if (!this.patientPage || this.patientPage.summary.total > 0) return;
        let legacy;
        try {
            legacy = JSON.parse(localStorage.getItem('patients') || 'null');
        } catch (e) {
            return;
        }
        if (!Array.isArray(legacy) || legacy.length === 0) return;
        this.legacyCount = legacy.length;
        this.renderMigrationPanel();
        ui.toast(`Найдены данные прежней версии (${legacy.length}). Раздел «Импорт / Экспорт» → «Перенос данных».`, 'warning');
    },

    renderMigrationPanel() {
        const panel = $('migrationPanel');
        if (!panel) return;
        const raw = localStorage.getItem('patients');
        let legacy = null;
        try {
            legacy = JSON.parse(raw || 'null');
        } catch (e) {
            legacy = null;
        }

        if (!Array.isArray(legacy) || legacy.length === 0) {
            panel.replaceChildren(frag([
                el('h2', { class: 'panel__title', text: 'Перенос данных прежней версии' }),
                el('p', { class: 'panel__text', text: 'В этом браузере не найдено данных от старой версии приложения — переносить нечего.' }),
            ]));
            return;
        }

        panel.replaceChildren(frag([
            el('h2', { class: 'panel__title', text: 'Перенос данных прежней версии' }),
            el('p', { class: 'panel__text' }, [
                `В этом браузере найдены данные пациентов от версии, которая хранила их локально: `,
                el('strong', { text: `${legacy.length} зап.` }),
                '. Перенос не выполняется автоматически, а локальная копия не удаляется без отдельного подтверждения.',
            ]),
            el('button', {
                type: 'button', class: 'btn btn--primary', text: 'Проверить и перенести на сервер',
                on: { click: () => this.runLegacyMigration() },
            }),
        ]));
    },

    async runLegacyMigration() {
        const raw = localStorage.getItem('patients');
        if (!raw) return;
        // Стадия 1 — проверка и подготовка переноса. Ошибка здесь: перенос не выполнялся.
        let body;
        try {
            const preview = await apiPost('/api/migrate/localstorage/preview', { raw });
            if (!preview.valid) {
                ui.toast('Локальные данные не прошли проверку и не были перенесены.', 'danger');
                return;
            }
            const proceed = await ui.confirm({
                title: 'Перенести данные на сервер?',
                text: `Будет перенесено записей: ${preview.totalRecords}. Локальная копия при этом сохранится.`,
                okLabel: 'Перенести',
                danger: false,
            });
            if (!proceed) return;
            body = { raw, mode: 'add' };
            const historical = preview.historicalDecisions;
            if (historical && historical.required) {
                // Решения ОК в локальных данных — только с отдельным подтверждением переноса.
                const transfer = await ui.confirm({
                    title: `Перенести исторические решения ОК (${historical.decisions})?`,
                    text: historical.message,
                    okLabel: 'Перенести решения',
                    danger: false,
                });
                if (!transfer) return;
                body.historicalDecisionsConfirmation = {
                    confirmed: true, fileSha256: historical.fileSha256, mode: 'add',
                    action: 'import_historical_consilium_decisions', decisions: historical.decisions,
                };
            }
        } catch (e) {
            ui.toast('Перенос не выполнен: ' + e.message, 'danger');
            return;
        }

        // Стадия 2 — отправка. WP2.4-B: ключ этой операции; потерянный ответ безопасно
        // повторяется с ним же. Без подтвержденного ответа ключ сохраняется.
        const bodyText = JSON.stringify(body);
        if (!this.migrationKey || this.migrationSentBody !== bodyText) this.migrationKey = newIdempotencyKey();
        this.migrationSentBody = bodyText;
        if (this.migrationPending) return;
        this.migrationPending = true;
        try {
            await apiPostIdempotent('/api/migrate/localstorage/commit', body, this.migrationKey);
        } catch (e) {
            ui.toast('Перенос не выполнен: ' + e.message, 'danger');
            return;
        } finally {
            this.migrationPending = false;
        }

        // Стадия 3 — сервер подтвердил перенос: операция закрыта. Дальше ни обновление
        // экрана, ни диалог, ни хранилище браузера не выдаются за ошибку переноса и
        // не ведут к повторному переносу (B-02, B-03).
        this.migrationKey = null;
        this.migrationSentBody = null;
        ui.toast('Данные перенесены на сервер.', 'good');
        await this.refreshAfterSavedOperation('Перенос сохранен', async () => {
            await this.loadPatients();
            await this.loadActivity();
        });
        await this.removeLegacyLocalCopy();
        await this.refreshAfterSavedOperation('Перенос сохранен', async () => this.renderMigrationPanel());
    },

    // B-03: необязательное удаление локальной копии после подтвержденного переноса —
    // только с отдельного согласия пользователя; сбой диалога или хранилища браузера
    // сообщается как невыполненное удаление, перенос остается сохраненным.
    async removeLegacyLocalCopy() {
        try {
            const removeLocal = await ui.confirm({
                title: 'Удалить локальную копию?',
                text: 'Перенос завершён. Удалить исходные данные из хранилища этого браузера? Их можно оставить как резервную копию.',
                okLabel: 'Удалить копию',
            });
            if (!removeLocal) return;
            localStorage.removeItem('patients');
            localStorage.removeItem('user');
        } catch (e) {
            ui.toast('Перенос сохранён, но не удалось удалить локальную копию. Повторять перенос не нужно.', 'warning');
        }
    },

    // B-02: обновление экрана после операции, которую сервер уже подтвердил.
    // Его сбой сообщается отдельно и не предлагает выполнить операцию заново.
    async refreshAfterSavedOperation(savedLabel, refresh) {
        try {
            await refresh();
            return true;
        } catch (e) {
            ui.toast(`${savedLabel}, но не удалось обновить отображение. Обновите страницу; повторять операцию не нужно.`, 'warning');
            return false;
        }
    },

    /* ------------------------------------------------- Предметная логика: этапы */

    getCurrentOccurrence(p) {
        return p.history && p.history.length ? p.history[p.history.length - 1] : null;
    },

    getStageLabel(occ) {
        if (!occ) return '';
        if (occ.stage === 'appointment') {
            const events = occ.events || [];
            const lastEvent = events[events.length - 1];
            if (lastEvent && lastEvent.actualDate) return 'Приём врача';
        }
        return this.stageNames[occ.stage];
    },

    getCurrentStageLabel(p) {
        if (Object.hasOwn(p, 'currentFact')) return p.stage === 'appointment' && p.currentFact ? 'Приём врача' : this.stageNames[p.stage] || p.stage;
        return this.getStageLabel(this.getCurrentOccurrence(p)) || this.stageNames[p.stage] || p.stage;
    },

    stageIndex(stage) {
        const index = this.stageOrder.indexOf(stage);
        return index === -1 ? 0 : index;
    },

    stageProgressClass(stage) {
        if (this.terminalStages.includes(stage)) return 'progress__bar--step7';
        return `progress__bar--step${this.stageIndex(stage) + 1}`;
    },

    stageToneClass(stage) {
        if (this.terminalStages.includes(stage)) return 'progress__bar--completed';
        if (stage === 'treatment' || stage === 'treatment-prep') return 'progress__bar--treatment';
        if (stage === 'consult') return 'progress__bar--consult';
        if (stage === 'appointment') return 'progress__bar--appointment';
        if (stage === 'exam') return 'progress__bar--exam';
        return '';
    },

    stageProgressPercent(stage) {
        if (this.terminalStages.includes(stage)) return 100;
        return Math.round((this.stageIndex(stage) + 1) / this.stageOrder.length * 100);
    },

    firstVisitTime(p) {
        const visit = (p.history || [])
            .filter(occ => occ.stage === 'primary-appointment')
            .flatMap(occ => occ.events || [])
            .find(ev => ev.actualDate);
        return visit ? new Date(`${visit.actualDate}T${visit.actualTime || '00:00'}`).getTime() || 0 : 0;
    },

    getPriorityFactor(priority) {
        if (priority === 'urgent') return 0.5;
        if (priority === 'high') return 0.7;
        return 1.0;
    },

    formatEventText(ev, isPending, treatmentTypeNames) {
        const parts = [];
        const typeName = ev.treatmentType ? (treatmentTypeNames[ev.treatmentType] || ev.treatmentType) : null;
        if (ev.noPlan) {
            parts.push(`факт ${ev.actualDate || '—'}${ev.actualTime ? ' ' + ev.actualTime : ''}`);
            return { text: parts.join(''), status: ev.actualDateUnverified ? 'факт из импорта не подтверждён' : 'состоялось' };
        }
        if (ev.date) parts.push(`план ${ev.date}${ev.time ? ' ' + ev.time : ''}`);
        else parts.push('план не указан');
        if (ev.actualDate) parts.push(`факт ${ev.actualDate}${ev.actualTime ? ' ' + ev.actualTime : ''}`);
        if (typeName) parts.push(typeName);
        if (ev.consiliumDecision) parts.push(`Решение: ${this.CONSILIUM_DECISION_LABELS[ev.consiliumDecision] || ev.consiliumDecision}`);
        // FIX1-P3: дата из будущего, пришедшая в исторической выгрузке, — не подтверждённый факт.
        const status = ev.actualDateUnverified ? 'факт из импорта не подтверждён'
            : ev.actualDate ? (ev.matchedPlan ? 'состоялось по плану' : 'состоялось с отклонением') : (isPending ? 'ожидается' : 'без отметки');
        return { text: parts.join(' · '), status };
    },

    getOccurrenceEffectiveDate(occ) {
        if (!occ) return null;
        const events = occ.events || [];
        for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i];
            if (ev.actualDate) return new Date(ev.actualDate);
        }
        return occ.enteredAt ? new Date(occ.enteredAt) : null;
    },

    addWorkingDays(startDate, days) {
        const d = new Date(startDate);
        const total = Math.max(1, Math.round(days));
        let count = 0;
        while (count < total) {
            d.setDate(d.getDate() + 1);
            const dow = d.getDay();
            if (dow !== 0 && dow !== 6) count++;
        }
        return d;
    },

    getStageDeadline(p, targetStageKey) {
        const nosology = this.nosologyData[p.nosology];
        if (!nosology) return null;
        const factor = this.getPriorityFactor(p.priority);

        if (targetStageKey === 'appointment') {
            const primaryOcc = (p.history || []).find(o => o.stage === 'primary-appointment');
            if (!primaryOcc) return null;
            const baseDate = this.getOccurrenceEffectiveDate(primaryOcc);
            if (!baseDate) return null;
            return this.addWorkingDays(baseDate, nosology.stage1Days * factor);
        }

        if (targetStageKey === 'consult') {
            const apptOcc = (p.history || []).find(o => o.stage === 'appointment');
            if (!apptOcc) return null;
            const baseDate = this.getOccurrenceEffectiveDate(apptOcc);
            if (!baseDate) return null;
            const stage2Base = nosology.stage2Standard;
            return this.addWorkingDays(baseDate, stage2Base * factor);
        }

        return null;
    },

    formatDeadlineDate(d) {
        return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    },

    getDaysUntil(dateStr) {
        if (!dateStr) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const eventDate = new Date(dateStr);
        eventDate.setHours(0, 0, 0, 0);
        return Math.floor((eventDate - today) / (1000 * 60 * 60 * 24));
    },

    getPatientDeadlineDays(p) {
        const occ = this.getCurrentOccurrence(p);
        const lastEvent = (occ && occ.events && occ.events.length) ? occ.events[occ.events.length - 1] : null;
        if (!lastEvent || !lastEvent.date) return null;
        return this.getDaysUntil(lastEvent.date);
    },

    getDateIndicatorCategory(days) {
        if (days === null) return 'nodate';
        if (days <= 3) return 'urgent';
        if (days <= 7) return 'soon';
        return 'ok';
    },

    getDateIndicatorText(days, timeStr = null) {
        if (days === null) return 'дата не установлена';
        const time = timeStr ? ` ${timeStr}` : '';
        if (days < 0) return `просрочено ${Math.abs(days)} дн.${time}`;
        if (days === 0) return `сегодня${time}`;
        return `${days} дн.${time}`;
    },

    dateChip(days, timeStr, extraLabel = '') {
        const category = this.getDateIndicatorCategory(days);
        const toneByCategory = { urgent: 'danger', soon: 'warning', ok: 'good', nodate: 'neutral' };
        return el('span', { class: `chip chip--${toneByCategory[category]}` }, [
            el('span', { class: 'chip__dot' }),
            this.getDateIndicatorText(days, timeStr) + extraLabel,
        ]);
    },

    formatElapsed(ms) {
        if (ms < 60000) return 'только что';
        const minutes = Math.floor(ms / 60000);
        if (minutes < 60) return `${minutes} мин`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} ч`;
        const days = Math.floor(hours / 24);
        if (days < 31) return `${days} дн`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months} мес`;
        return `${Math.floor(months / 12)} г`;
    },

    formatNotificationMoment(iso) {
        if (!iso) return '—';
        const moment = new Date(iso);
        if (Number.isNaN(moment.getTime())) return '—';
        return moment.toLocaleString('ru-RU', {timeZone: 'Europe/Moscow',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}) + ' МСК';
    },

    formatDateTime(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        if (sameDay) return `Сегодня, ${time}`;
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        if (d.toDateString() === yesterday.toDateString()) return `Вчера, ${time}`;
        return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    },

    initials(name) {
        return String(name || '')
            .trim().split(/\s+/).slice(0, 2)
            .map(part => part.charAt(0).toUpperCase())
            .join('');
    },

    buildTimelineNodes(p) {
        const template = this.stageOrder;
        const nodes = [];
        let templateIndex = 0;
        const history = p.history || [];
        const lastIdx = history.length - 1;

        history.forEach((occ, i) => {
            const isCurrent = i === lastIdx;
            const matches = templateIndex < template.length && occ.stage === template[templateIndex];
            nodes.push({
                stage: occ.stage,
                status: isCurrent ? 'current' : 'done',
                extra: !matches,
                occIndex: i,
            });
            if (matches) templateIndex++;
        });

        if (history.length && this.terminalStages.includes(history[lastIdx].stage)) return nodes;

        for (let j = templateIndex; j < template.length; j++) {
            nodes.push({ stage: template[j], status: 'future', templateIndex: j, isNext: j === templateIndex });
        }

        return nodes;
    },

    getFiltered() {
        return this.patientRows; // Already searched/filtered/sorted across the server scope.
    },

    generateSummary(p) {
        const lines = [];
        lines.push(`Пациент: ${p.name}, ${p.age} лет.`);
        lines.push(`Номер полиса ОМС: ${p.policyNumber || 'не указан'}.`);
        lines.push(`Диагноз (МКБ-10): ${p.diagnosis || 'не указан'}.`);
        if (p.nosology && this.nosologyData[p.nosology]) {
            lines.push(`Локализация/клиентский путь: ${this.nosologyData[p.nosology].label}.`);
        }
        lines.push(`Приоритет: ${this.PRIORITY_LABELS[p.priority] || p.priority}.`);
        lines.push(`Заведующий: ${p.head || 'не указан'}.`);
        lines.push(`Лечащий врач: ${p.doctor || 'не указан'}.`);
        lines.push('');
        lines.push(`Текущий этап: ${this.getCurrentStageLabel(p)}.`);
        lines.push('');
        lines.push('Хронология:');

        let prevEffectiveDate = null;
        (p.history || []).forEach((occ, i) => {
            const isCurrentOcc = i === p.history.length - 1;
            const enteredFormatted = new Date(occ.enteredAt).toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
            });
            const occEffectiveDate = this.getOccurrenceEffectiveDate(occ);

            let durationText = '';
            if (prevEffectiveDate && occEffectiveDate) {
                const days = Math.round((occEffectiveDate - prevEffectiveDate) / (1000 * 60 * 60 * 24));
                durationText = ` (по фактическим датам: ${days} дн. от предыдущего этапа)`;
            }
            lines.push(`${i + 1}. ${this.getStageLabel(occ)} — статус проставлен ${enteredFormatted}${durationText}`);
            if (occ.note) lines.push(`   Примечание: ${occ.note}`);

            const events = occ.events || [];
            events.forEach((ev, idx) => {
                const isLastEvent = idx === events.length - 1;
                const isPending = isCurrentOcc && isLastEvent && !ev.actualDate;
                const { text, status } = this.formatEventText(ev, isPending, this.TREATMENT_LABELS);
                const label = events.length > 1 ? `   – событие ${idx + 1}: ` : '   – ';
                lines.push(`${label}${text} — ${status}`);
                if (ev.consiliumDecision) {
                    lines.push(`     ОК — Решение: ${this.CONSILIUM_DECISION_LABELS[ev.consiliumDecision] || ev.consiliumDecision}`);
                }
            });

            if (occEffectiveDate) prevEffectiveDate = occEffectiveDate;
        });

        lines.push('');
        const remaining = this.buildTimelineNodes(p).filter(n => n.status === 'future').length;
        lines.push(remaining > 0 ? `Осталось этапов: ${remaining}.` : 'Лечение завершено, дальнейших этапов нет.');

        return lines.join('\n');
    },

    async copySummary(id) {
        const p = this.getPatient(id) || await this.refreshPatientRecord(id);
        const text = this.generateSummary(p);
        try {
            await navigator.clipboard.writeText(text);
            ui.toast('Сводка скопирована в буфер обмена.', 'good');
        } catch (e) {
            ui.toast('Не удалось скопировать. Текст сводки доступен во вкладке «Обзор».', 'warning');
        }
    },

    /* ============================================================ РЕНДЕР: СПИСОК */

    fillStaticSelects() {
        const createSelections=this.addFormActive ? [...$('addForm').querySelectorAll('select')].map(node=>[node.id,node.value]) : null;
        $('filterStage').replaceChildren(frag([
            option('', 'Все этапы', true),
            ...this.stageFilterOrder.map(s => option(s, this.stageNames[s])),
        ]));

        const heads = this.patientPage?.heads || [];
        $('filterHead').replaceChildren(frag([
            option('', 'Все заведующие', true),
            ...heads.map(h => option(h, h)),
        ]));

        $('filterDeadline').replaceChildren(frag([
            option('', 'Любой срок', true),
            option('overdue', 'Просрочено'),
            option('0-3', 'Ближайшие 3 дня'),
            option('4-7', '4–7 дней'),
            option('7+', 'Более 7 дней'),
            option('no-date', 'Дата не назначена'),
        ]));

        $('filterAttention').replaceChildren(frag([
            option('', 'Все пациенты', true),
            option('active', 'Требуют внимания'),
            option('none', 'Без активных проблем'),
        ]));
        $('filterAttentionReason').replaceChildren(frag([
            option('', 'Любая причина', true),
            ...Object.entries(this.ATTENTION_REASON_LABELS).map(([code, label]) => option(code, label)),
        ]));

        $('sortOrderSelect').replaceChildren(frag([
            option('updated-newest', 'Сначала изменённые', true),
            option('attention', 'Сначала требуют внимания'),
            option('newest', 'Сначала новые'),
            option('oldest', 'Сначала давние'),
            option('first-visit-oldest', 'Первый визит: сначала ранние'),
            option('first-visit-newest', 'Первый визит: сначала поздние'),
            option('name', 'По алфавиту'),
        ]));

        $('qualitySeverityFilter').replaceChildren(frag([
            option('', 'Любая серьёзность', true),
            option('critical', 'Критические ошибки'),
            option('warning', 'Предупреждения'),
            option('info', 'Информация'),
        ]));
        $('qualityCategoryFilter').replaceChildren(frag([
            option('', 'Любая категория', true),
            ...Object.entries(this.QUALITY_CATEGORY_LABELS).map(([key, label]) => option(key, label)),
        ]));
        $('qualityCodeFilter').replaceChildren(frag([
            option('', 'Любой тип проблемы', true),
            ...Object.entries(this.QUALITY_CODE_LABELS).map(([key, label]) => option(key, label)),
        ]));
        $('qualityDoctorFilter').replaceChildren(option('', 'Любой лечащий врач', true));
        $('qualityDepartmentFilter').replaceChildren(option('', 'Любое отделение', true));
        $('qualitySortSelect').replaceChildren(frag([
            option('severity', 'Сначала серьёзные', true),
            option('issues', 'Больше проблем выше'),
            option('completeness', 'Ниже заполненность выше'),
        ]));

        $('notificationsStatusFilter').replaceChildren(frag([
            option('', 'Любой статус', true),
            ...Object.entries(this.NOTIFICATION_STATUS_LABELS).map(([key, label]) => option(key, label)),
        ]));
        $('notificationsTemplateFilter').replaceChildren(option('', 'Любой шаблон', true));
        $('notificationsDoctorFilter').replaceChildren(option('', 'Любой лечащий врач', true));
        $('notificationsDepartmentFilter').replaceChildren(option('', 'Любое отделение', true));
        $('notificationsSortSelect').replaceChildren(frag([
            option('scheduled_asc', 'Ближайшие первыми', true),
            option('scheduled_desc', 'Поздние первыми'),
            option('status', 'По статусу'),
        ]));

        $('analyticsStageFilter').replaceChildren(frag([
            option('', 'Все этапы', true),
            ...this.stageFilterOrder.map(s => option(s, this.stageNames[s])),
        ]));
        $('analyticsNosologyFilter').replaceChildren(frag([
            option('', 'Любая локализация', true),
            ...this.analyticsLocalizationOptions().map(item => option(item.value, item.label)),
        ]));
        $('analyticsDoctorFilter').replaceChildren(option('', 'Любой лечащий врач', true));
        $('analyticsDepartmentFilter').replaceChildren(option('', 'Любое отделение', true));

        $('diagnosisLocalization').replaceChildren(frag([
            option('', 'Выберите локализацию', true),
            ...Object.keys(this.icd10Localizations).map(key => option(key, this.icd10Localizations[key].label)),
        ]));

        $('stage').replaceChildren(frag([
            option('', 'Выберите этап', true),
            ...this.stageFilterOrder.map(s => option(s, this.stageNames[s])),
        ]));

        $('head').replaceChildren(frag([
            option('', 'Выберите заведующего', true),
            ...this.headOptions.map(h => option(h.name, h.name)),
        ]));

        $('treatmentType').replaceChildren(frag(this.treatmentTypeOptions()));

        this.fillDoctorSelect();
        if (createSelections) {
            for (const [id,value] of createSelections) if ([...$(id).options].some(option=>option.value===value)) $(id).value=value;
            this.updateStageFields();this.updateClientPathStatus();this.setAddPatientPending(!!this.addPatientPending);
        }
    },

    treatmentTypeOptions(selected = '') {
        return this.TREATMENT_OPTIONS.map(value => option(value, value ? this.TREATMENT_LABELS[value] : 'Не указан', value === selected));
    },

    /** Селект «Лечащий врач» в форме создания зависит от роли:
     *  врач — всегда сам (фиксировано); заведующий — врачи его отделений;
     *  Разработчик — любой активный врач или «не сопоставлен». */
    fillDoctorSelect() {
        const select = $('doctor');
        const hint = $('doctorHint');
        if (!select) return;
        if (this.user && ['doctor', 'consilium_chair'].includes(this.user.roleId)) {
            select.replaceChildren(option(this.user.id, this.user.fullName, true));
            select.disabled = true;
            hint.textContent = this.user.roleId === 'consilium_chair'
                ? 'Пациент закрепляется за вами для персонального отслеживания.'
                : 'Пациент закрепляется за вами. Выбрать другого врача нельзя.';
            hint.classList.remove('is-hidden');
            return;
        }
        select.disabled = false;
        const options = [];
        if (this.can('changeTreatingDoctor')) {
            options.push(option('', '— Не сопоставлен (назначить позже) —', true));
            hint.textContent = 'Пациент без врача попадёт в список «Несопоставленные лечащие врачи».';
            hint.classList.remove('is-hidden');
        } else {
            options.push(option('', 'Выберите врача отделения', true));
            hint.textContent = 'Доступны только врачи отделений, которыми вы управляете.';
            hint.classList.remove('is-hidden');
        }
        options.push(...this.doctors.map(d => option(d.id, d.fullName)));
        select.replaceChildren(frag(options));
    },

    renderStats() {
        const total = this.patientPage?.summary.total ?? null;
        $('patientRegistryCount').textContent = total === null ? '—' : String(total);
        const {fresh=0, inTreatment=0, done=0} = this.patientPage?.summary || {};
        const share = (n) => total ? `${(n / total * 100).toFixed(1)}% от всех` : 'нет данных';

        const stat = (label, value, meta, metaClass) => el('div', { class: 'stat' }, [
            el('div', { class: 'stat__label', text: label }),
            el('div', { class: 'stat__value', text: total === null ? '—' : String(value) }),
            el('div', { class: metaClass ? `stat__meta ${metaClass}` : 'stat__meta', text: meta }),
        ]);

        $('statsRow').replaceChildren(frag([
            stat('Всего пациентов', total, total ? 'в работе и завершённые' : 'список пуст'),
            stat('Новых за неделю', fresh, fresh ? 'добавлены за 7 дней' : 'новых нет', fresh ? 'stat__meta--accent' : ''),
            stat('На лечении', inTreatment, share(inTreatment)),
            stat('Завершено', done, share(done), done ? 'stat__meta--good' : ''),
        ]));
    },

    /** Счётчик у мобильной кнопки «Фильтры»: сколько условий сейчас активно. */
    activeFilterCount() {
        return [this.stageFilter, this.headFilter, this.deadlineFilter, this.attentionFilter, this.attentionReasonFilter, this.includeTerminal].filter(Boolean).length;
    },

    updateFiltersButton() {
        const label = $('filtersBtnLabel');
        if (!label) return;
        const count = this.activeFilterCount();
        label.textContent = count ? `Фильтры · ${count}` : 'Фильтры';
        const button = $('openFiltersSheetBtn');
        button.setAttribute('aria-label', count
            ? `Фильтры и сортировка, активных фильтров: ${count}`
            : 'Фильтры и сортировка');
    },

    /** Панели-листы переиспользуют те же select-элементы, а не копию:
        обработчики и значения остаются едиными для обеих раскладок. */
    openFiltersSheet() {
        $('registryMoreFilters').open = true;
        $('filtersSheetBody').append($('toolbarFilters'));
        $('openFiltersSheetBtn').setAttribute('aria-expanded', 'true');
        ui.openModal('filtersSheet');
    },

    closeFiltersSheet() {
        ui.closeModal('filtersSheet');
        $('openFiltersSheetBtn').setAttribute('aria-expanded', 'false');
        const toolbar = document.querySelector('#view-patients .toolbar');
        toolbar.append($('toolbarFilters'));
        $('registryMoreFilters').open = false;
    },

    resetFilters() {
        this.stageFilter = null;
        this.headFilter = null;
        this.deadlineFilter = null;
        this.attentionFilter = null;
        this.attentionReasonFilter = null;
        $('filterStage').value = '';
        $('filterHead').value = '';
        $('filterDeadline').value = '';
        $('filterAttention').value = '';
        $('filterAttentionReason').value = '';
        this.includeTerminal = $('filterIncludeTerminal').checked = false;
        this.reloadPatientsAndRender();
    },

    syncRegistryControls() {
        for (const [id, value] of Object.entries({searchInput: this.searchQuery, filterStage: this.stageFilter,
            filterHead: this.headFilter, filterDeadline: this.deadlineFilter, filterAttention: this.attentionFilter,
            filterAttentionReason: this.attentionReasonFilter, sortOrderSelect: this.sortOrder})) $(id).value = value || '';
        $('filterIncludeTerminal').checked = this.includeTerminal;
    },

    async reloadPatientsAndRender(cursor = null) {
        const request = this.loadPatients(cursor);
        const read = this.readVersions.patients;
        try {
            await request;
            if (!this.isCurrentRead('patients', read)) return;
            this.fillStaticSelects();
            this.syncRegistryControls();
            this.renderPatients();
            const restore = this.registryFocus;
            if (restore?.read === read) {
                this.registryFocus = null;
                if (this.currentView === 'patients' && document.activeElement === restore.anchor && !ui.topModal()) {
                    const button = [...$('patientsBody').querySelectorAll('[data-registry-patient]')]
                        .find(node => node.dataset.registryPatient === restore.patientId);
                    button?.focus();
                }
            }
        } catch (e) {
            if (this.registryFocus?.read === read) this.registryFocus = null;
            if (this.isCurrentRead('patients', read) && !e.obsolete) ui.toast(`Не удалось обновить список пациентов: ${e.message}`, 'warning');
        }
    },

    /** Счётчик несопоставленных пациентов для Разработчика: баннер в списке
     *  с переходом к экрану сопоставления («Структура»). */
    async updateUnresolvedBanner() {
        const banner = $('unresolvedBanner');
        if (!banner) return;
        if (!this.can('changeTreatingDoctor')) {
            banner.classList.add('is-hidden');
            return;
        }
        // Считаем из уже загруженного scope-списка (Разработчик видит всех),
        // чтобы не делать лишний запрос при каждом рендере.
        const count = this.patientPage?.summary.unresolved || 0;
        if (!count) {
            banner.classList.add('is-hidden');
            return;
        }
        $('unresolvedBannerText').textContent =
            `Пациентов без сопоставленного лечащего врача: ${count}. `
            + 'Они не видны врачам и заведующим отделений.';
        banner.classList.remove('is-hidden');
    },

    renderPatientFilterChips() {
        const chips = [];
        if (this.searchQuery) chips.push({id:'searchInput', label:`Поиск: ${this.searchQuery}`, event:'input'});
        for (const [id, value, name] of [
            ['filterStage',this.stageFilter,'Этап'], ['filterHead',this.headFilter,'Заведующий'],
            ['filterDeadline',this.deadlineFilter,'Срок'], ['filterAttention',this.attentionFilter,'Внимание'],
            ['filterAttentionReason',this.attentionReasonFilter,'Причина'],
        ]) if (value) chips.push({id, label:`${name}: ${$(id).selectedOptions[0]?.textContent || value}`, event:'change'});
        $('patientFilterChips').replaceChildren(frag(chips.map(chip => el('button', {
            type:'button', class:'registry-chip', text:chip.label+' ×', 'aria-label':'Снять условие: '+chip.label,
            on:{click:()=>{ const field=$(chip.id);field.value='';field.dispatchEvent(new Event(chip.event,{bubbles:true})); }},
        }))));
        $('resetPatientFiltersBtn').classList.toggle('is-hidden', !this.activeFilterCount());
        const count=[this.deadlineFilter,this.attentionFilter,this.attentionReasonFilter,this.includeTerminal].filter(Boolean).length;
        $('registryMoreFilterCount').textContent = count ? `· ${count}` : '';
    },

    renderPatients() {
        if (this.sessionExpired || this.patientListState === 'error') return;
        this.renderStats();
        this.updateFiltersButton();
        this.renderPatientFilterChips();
        const filtered = this.getFiltered();
        const body = $('patientsBody');
        const empty = $('patientsEmpty');

        if (filtered.length === 0) {
            body.replaceChildren();
            empty.classList.remove('is-hidden');
            empty.textContent = (this.patientPage?.summary.total || 0) === 0
                ? (this.can('createPatients')
                    ? 'Пациентов пока нет. Нажмите «Новый пациент», чтобы добавить первого.'
                    : 'В вашей области видимости пока нет пациентов.')
                : 'По выбранным условиям никого не найдено. Измените фильтры или поиск.';
            return;
        }
        empty.classList.add('is-hidden');

        this.renderPatientPagination();
        body.replaceChildren(frag(filtered.map(p => {
            const stageLabel = this.getCurrentStageLabel(p);
            const percent = this.stageProgressPercent(p.stage);
            const activity = this.activityByPatient[p.id];
            const attention = p.attention || {};
            const attentionBadge = attention.active ? el('span', { class: 'chip chip--warning patient-attention-badge' }, [
                el('span', { class: 'chip__dot' }),
                `Требует внимания${attention.activeCount > 1 ? ' · ' + attention.activeCount : ''}`,
            ]) : null;

            return el('tr', {
                class: 'patient-row patient-row--interactive',

                on: {
                    click: () => this.openPatient(p.id),
                },
            }, [
                el('td', {}, el('div', { class: 'person' }, [
                    el('div', {}, [
                        el('button', {type:'button', class:'person__name patient-open', dataset:{registryPatient:p.id}, text:p.name, 'aria-label':`Открыть карточку: ${p.name}`, on:{click:event=>{event.stopPropagation();this.openPatient(p.id);}}}),
                        el('div', { class: 'person__meta', text: `${p.age} лет · ${p.diagnosis || 'диагноз не указан'}` }),
                        p.priority !== 'normal' ? el('span', {class:'registry-priority', text:p.priority === 'urgent' ? 'Срочно' : 'Высокий приоритет'}) : null,
                        attentionBadge,
                    ]),
                ])),
                el('td', { class: 'cell-stage' }, [
                    el('div', { class: 'cell-stage__name', text: stageLabel }),
                    el('div', { class: 'progress' }, [
                        el('div', { class: 'progress__track' },
                            el('div', { class: `progress__bar ${this.stageProgressClass(p.stage)} ${this.stageToneClass(p.stage)}` })),
                        el('span', { class: 'progress__value', text: `${percent}%` }),
                    ]),
                ]),
                el('td', { class: 'cell-deadline' }, el('span', {
                    class: p.currentFact || p.deadlineDays == null ? 'registry-deadline'
                        : `registry-deadline chip chip--${p.deadlineDays < 0 ? 'danger' : p.deadlineDays <= 3 ? 'warning' : 'good'}`,
                    text: p.currentFact ? 'Факт отмечен' : p.deadlineDays == null ? 'Дата не назначена'
                        : p.deadlineDays < 0 ? `Плановая дата прошла · ${Math.abs(p.deadlineDays)} дн.`
                        : p.deadlineDays === 0 ? 'Сегодня' : `Через ${p.deadlineDays} дн.`,
                })),
                el('td', { class: 'cell-when' }, [
                    el('div', { class: 'cell-when__time', text: this.formatDateTime(p.updatedAt || p.arrival) }),
                    activity ? el('div', { class: 'cell-when__what', text: activity }) : null,
                ]),
                el('td', { class: 'cell-head' }, el('div', { class: 'cell-head__content' }, [
                    el('div', {}, [
                        el('div', {class:'registry-doctor', text:p.treatingDoctorName || p.doctor || 'Врач не сопоставлен'}),
                        el('div', {class:'person__meta', text:`Заведующий: ${p.head || 'не указан'}`}),
                    ]),
                    el('span', { class: 'patient-row__chevron', 'aria-hidden': 'true', text: '›' }),
                ])),
            ]);
        })));
    },

    /* ========================================================== РЕНДЕР: КАРТОЧКА */

    renderPatientView() {
        if (this.sessionExpired) return;
        this.capturePatientEdits();
        const p = this.getPatient(this.currentPatientId);
        if (!p) {
            this.showView('patients');
            return;
        }
        $('crumbPatientName').textContent = p.name;
        this.renderPatientSide(p);
        this.renderTabs(p);
        this.renderTabPanel(p);
        this.applyReadOnlyToPatientView();
        this.renderPatientQualityBlock(p.id);
        if (this.currentTab === 'overview') {
            this.renderPatientAttentionBlock(p.id);
            this.renderPatientPortalAccessBlock(p.id);
        }
        if (this.currentTab === 'notifications') this.renderPatientNotificationsBlock(p.id);
    },

    /** Read-only роли: формы изменения не открываются. Backend всё равно
     *  отклонит запись — это только согласование интерфейса с правами. */
    applyReadOnlyToPatientView() {
        if (!this.isReadOnly()) return;
        for (const node of $('patientPanels').querySelectorAll('input, select, textarea')) {
            node.disabled = true;
        }
        for (const node of $('patientPanels').querySelectorAll('button')) {
            node.classList.add('is-hidden');
        }
    },

    statusChip(p) {
        if (p.stage === 'completed') return el('span', { class: 'chip chip--good' }, [el('span', { class: 'chip__dot' }), 'Завершил лечение']);
        if (p.stage === 'dispensary-observation') return el('span', { class: 'chip chip--good' }, [el('span', { class: 'chip__dot' }), 'Диспансерное наблюдение']);
        if (p.stage === 'diagnosis-not-confirmed') return el('span', { class: 'chip chip--neutral' }, [el('span', { class: 'chip__dot' }), 'Диагноз не подтверждён']);
        if (p.stage === 'treatment' || p.stage === 'treatment-prep') return el('span', { class: 'chip chip--teal' }, [el('span', { class: 'chip__dot' }), 'На лечении']);
        return el('span', { class: 'chip chip--accent' }, [el('span', { class: 'chip__dot' }), 'В процессе обследования']);
    },

    attentionReasonLabel(code) {
        return this.ATTENTION_REASON_LABELS[code] || code || 'Причина не указана';
    },

    async refreshPatientRecord(patientId, current = () => true) {
        const updated = await apiGetJson(`/api/patients/${encodeURIComponent(patientId)}`);
        if (current()) this.replacePatientInCache(updated);
        return updated;
    },

    renderPatientSide(p) {
        const percent = this.stageProgressPercent(p.stage);
        const nextNode = this.buildTimelineNodes(p).find(n => n.status === 'future' && n.isNext);
        const occurrence = p.history?.at(-1);
        const planned = occurrence?.stage === p.stage ? (occurrence.events || [])
            .filter(event => event.date && !event.actualDate)
            .sort((left, right) => (left.date + (left.time || '')).localeCompare(right.date + (right.time || '')))[0] : null;

        $('patientSide').replaceChildren(frag([
            el('div', { class: 'pcard' }, [
                el('div', { class: 'pcard__head' }, [
                    el('span', { class: `avatar avatar--lg avatar--${p.priority}`, text: this.initials(p.name) }),
                    el('div', {}, [
                        el('h1', { class: 'pcard__name', text: p.name }),
                        el('div', { class: 'pcard__meta', text: `${p.age} лет · приоритет: ${this.PRIORITY_LABELS[p.priority] || p.priority}` }),
                        el('div', {class:'pcard__diagnosis', text:`Диагноз: ${p.diagnosis || 'не указан'}`}),
                        p.phone ? el('div', { class: 'pcard__phone', text: p.phone }) : null,
                        el('div', { class: 'pcard__sub', text: `Полис ОМС: ${p.policyNumber || 'Не указан'}` }),
                    ]),
                ]),
                this.statusChip(p),
                this.renderPatientAttentionSummary(p),

                el('div', { class: 'pcard__block' }, [
                    el('div', { class: 'pcard__label', text: 'Этап лечения' }),
                    el('div', { class: 'pcard__value', text: this.getCurrentStageLabel(p) }),
                    el('div', { class: 'pcard__sub', text: planned
                        ? 'Плановая дата этапа: ' + planned.date.split('-').reverse().join('.') + (planned.time ? ' · ' + planned.time : '')
                        : 'Плановая дата этапа не указана' }),
                    el('div', { class: 'progress' }, [
                        el('div', { class: 'progress__track' },
                            el('div', { class: `progress__bar ${this.stageProgressClass(p.stage)} ${this.stageToneClass(p.stage)}` })),
                        el('span', { class: 'progress__value', text: `${percent}%` }),
                    ]),
                ]),

                el('div', { class: 'pcard__block' }, [
                    el('div', { class: 'pcard__label', text: 'Ответственные' }),
                    el('div', {
                        class: 'pcard__value',
                        text: p.treatingDoctorName || p.doctor || 'Врач не указан',
                    }),
                    !p.treatingDoctorUserId ? el('div', {
                        class: 'pcard__sub',
                        text: 'Учётная запись врача не сопоставлена',
                    }) : null,
                    el('div', { class: 'pcard__sub', text: p.head ? `Заведующий: ${p.head}` : 'Заведующий не указан' }),
                    this.can('changeTreatingDoctor') ? el('button', {
                        type: 'button', class: 'btn btn--ghost btn--sm', text: 'Сменить лечащего врача',
                        on: { click: () => this.openDoctorModal(p.id) },
                    }) : null,
                ]),

                el('div', { class: 'pcard__block' }, [
                    el('div', { class: 'pcard__label', text: 'Последняя активность' }),
                    el('div', { class: 'pcard__value', text: this.formatDateTime(p.updatedAt || p.arrival) }),
                    el('div', { class: 'pcard__sub', text: this.activityByPatient[p.id] || `Добавлен ${this.formatDateTime(p.arrival)}` }),
                ]),

                el('div', { class: 'pcard__actions' }, [
                    (nextNode && p.stage !== 'consult' && this.can('editPatients')) ? el('button', {
                        type: 'button', class: 'btn btn--primary',
                        text: `Перевести: ${this.stageNames[nextNode.stage]}`,
                        on: { click: () => this.advanceToStage(p.id, nextNode.stage, this.stageNames[nextNode.stage]) },
                    }) : null,
                    (p.stage === 'appointment' && this.can('editPatients')) ? el('button', {
                        type: 'button', class: 'btn btn--ghost',
                        text: 'Дополнительное обследование',
                        on: { click: () => this.advanceToStage(p.id, 'exam', this.stageNames.exam) },
                    }) : null,
                    ...(p.stage === 'consult' ? this.renderConsiliumDecisionActions(p.id) : []),
                    ((p.stage === 'exam' || p.stage === 'appointment' || p.stage === 'consult') && this.can('editPatients')) ? el('button', {
                        type: 'button', class: 'btn btn--quiet',
                        text: 'Диагноз не подтверждён',
                        on: { click: () => this.advanceToStage(p.id, 'diagnosis-not-confirmed', this.stageNames['diagnosis-not-confirmed']) },
                    }) : null,
                    el('button', {
                        type: 'button', class: 'btn btn--ghost', text: 'Скопировать сводку',
                        on: { click: () => this.copySummary(p.id) },
                    }),
                    el('button', {
                        type: 'button',
                        class: 'btn btn--ghost',
                        text: 'Спросить помощника',
                        'aria-label': `Спросить помощника по пациенту: ${p.name}`,
                        'data-ai-open':'true',on: { click: () => this.openAIDrawer(p.id) },
                    }),
                    this.can('deletePatients') ? el('button', {
                        type: 'button', class: 'btn btn--quiet', text: 'Удалить пациента',
                        on: { click: () => this.deletePatient(p.id) },
                    }) : null,
                ]),
            ]),
        ]));
        $('patientFacts').replaceChildren(...$('patientSide').querySelectorAll('.pcard > .pcard__block:not(.patient-attention-summary)'));
    },

    /**
     * Этап «Направлен на ОК»: ручная отметка решения ОК и перевод этапа — разные
     * действия (WP2.2-B). Отметка записывает решение в выбранное событие и этап не
     * меняет; перевод решения не записывает.
     */
    renderConsiliumDecisionActions(patientId) {
        const mark = this.can('markConsiliumDecision')
            ? Object.keys(this.CONSILIUM_DECISION_LABELS).map(code => el('button', {
                type: 'button',
                class: 'btn btn--ghost',
                text: `Отметить решение ОК: ${this.CONSILIUM_DECISION_LABELS[code]}`,
                on: { click: () => this.markConsiliumDecision(patientId, code) },
            }))
            : [];
        const move = this.can('editPatients') ? [
            el('button', {
                type: 'button',
                class: 'btn btn--primary',
                text: `Перевести: ${this.stageNames['treatment-prep']}`,
                on: { click: () => this.advanceToStage(patientId, 'treatment-prep', this.stageNames['treatment-prep']) },
            }),
            el('button', {
                type: 'button',
                class: 'btn btn--ghost',
                text: 'Направить на дообследование',
                on: { click: () => this.advanceToStage(patientId, 'exam', this.stageNames.exam) },
            }),
            el('button', {
                type: 'button',
                class: 'btn btn--ghost',
                text: `Перевести: ${this.stageNames['dispensary-observation']}`,
                on: { click: () => this.advanceToStage(patientId, 'dispensary-observation', this.stageNames['dispensary-observation']) },
            }),
        ] : [];
        return [...mark, ...move];
    },

    /**
     * Ручная отметка решения ОК в явно выбранном событии текущего этапа ОК.
     * Этап пациента не меняется; записанное решение не заменяется.
     */
    /** Кто и когда отметил решение ОК; для записей до обновления автор не известен. */
    consiliumDecisionAttribution(ev) {
        if (ev.consiliumDecisionSource === 'manual') {
            return `Отметил: ${ev.consiliumDecisionByName || 'сотрудник'}, ${this.formatDateTime(ev.consiliumDecisionAt)}`;
        }
        if (ev.consiliumDecisionSource === 'import') {
            return 'Историческое решение перенесено из файла импорта; автор и время решения неизвестны'
                + (ev.consiliumDecisionImportedAt
                    ? `. Импорт выполнил: ${ev.consiliumDecisionImportedByName || 'сотрудник'}, ${this.formatDateTime(ev.consiliumDecisionImportedAt)}`
                    : '');
        }
        return 'Решение записано до обновления системы; автор и время не зафиксированы';
    },

    async markConsiliumDecision(patientId, decision) {
        const p = this.getPatient(patientId);
        const occ = p ? this.getCurrentOccurrence(p) : null;
        if (!p || p.stage !== 'consult' || !occ) return false;
        const events = occ.events || [];
        if (!events.length) {
            ui.toast('Решение ОК отмечается в событии этапа. Сначала добавьте событие этапа «Направлен на ОК».', 'warning');
            return false;
        }
        const free = events.filter(ev => ev.id && !ev.consiliumDecision);
        if (!free.length) {
            ui.toast('Во всех событиях этапа решение ОК уже отмечено. Повторная запись не выполняется.', 'warning');
            return false;
        }
        const describe = (ev) => {
            const index = events.indexOf(ev) + 1;
            const plan = ev.date ? `план ${ev.date}${ev.time ? ' ' + ev.time : ''}` : 'без плановой даты';
            const fact = ev.actualDate ? `, факт ${ev.actualDate}${ev.actualTime ? ' ' + ev.actualTime : ''}` : '';
            return `Событие ${index}: ${plan}${fact}`;
        };
        let target = free[0];
        if (free.length > 1) {
            // Несколько событий без решения: событие выбирается явно, последнее не подставляется.
            const chosen = await ui.choose({
                title: 'Событие для решения ОК',
                text: `Решение «${this.CONSILIUM_DECISION_LABELS[decision]}» будет записано в выбранное событие этапа.`,
                label: 'Событие',
                options: free.map(ev => ({ value: ev.id, label: describe(ev) })),
                okLabel: 'Продолжить',
            });
            if (!chosen) return false;
            target = free.find(ev => ev.id === chosen);
        }
        const confirmed = await ui.confirm({
            title: 'Отметить решение ОК?',
            text: `${describe(target)}. Решение: «${this.CONSILIUM_DECISION_LABELS[decision]}». `
                + 'Этап пациента не изменится. Записанное решение изменить нельзя.',
            okLabel: 'Отметить',
            danger: false,
        });
        if (!confirmed) return false;
        const body = {
            decision,
            version: target.version,
            expectedStage: p.stage,
            expectedHistoryEntryId: occ.id,
        };
        try {
            let updated = null;
            // Сервер требует отдельного подтверждения, если в этом этапе ОК есть архивное
            // (удаленное) событие с решением; подтверждается именно набор событий из ответа.
            for (let attempt = 0; attempt < 3 && !updated; attempt += 1) {
                try {
                    updated = await apiPost(`/api/patients/${patientId}/events/${target.id}/consilium-decision`, body);
                } catch (e) {
                    if (!(e.status === 409 && e.data && e.data.code === 'ARCHIVED_DECISION_EXISTS')) throw e;
                    const archived = e.data.archivedEventIds || [];
                    const acknowledged = await ui.confirm({
                        title: 'В архиве этапа есть решение ОК',
                        text: `${e.message}${/[.!?]$/.test(e.message) ? '' : '.'} Архивных событий с решением: ${archived.length}. Их можно посмотреть в списке удаленных событий карточки.`,
                        okLabel: 'Подтверждаю, отметить новое решение',
                        danger: false,
                    });
                    if (!acknowledged) return false;
                    body.acknowledgedArchivedEventIds = archived;
                }
            }
            if (!updated) return false;
            this.replacePatientInCache(updated);
            await this.loadActivity();
            this.refreshCurrent();
            ui.toast('Решение ОК отмечено. Этап пациента не изменен.', 'good');
            return true;
        } catch (e) {
            ui.toast('Не удалось отметить решение ОК: ' + e.message, 'danger');
            await this.reloadPatientAfterConflict(patientId, e);
            return false;
        }
    },

    renderPatientAttentionSummary(p) {
        const attention = p.attention || {};
        const active = !!attention.active;
        return el('div', { class: `pcard__block patient-attention-summary ${active ? 'is-active' : ''}` }, [
            el('div', { class: 'pcard__label', text: 'Контроль внимания' }),
            active ? el('div', { class: 'pcard__value' }, [
                el('span', { class: 'chip chip--warning' }, [
                    el('span', { class: 'chip__dot' }),
                    `Требует внимания${attention.activeCount > 1 ? ' · ' + attention.activeCount : ''}`,
                ]),
            ]) : el('div', { class: 'pcard__value', text: 'Пациент не отмечен как требующий внимания' }),
            active && attention.primaryReasonLabel ? el('div', { class: 'pcard__sub', text: attention.primaryReasonLabel }) : null,
            this.can('editPatients') ? el('button', {
                type: 'button',
                class: 'btn btn--ghost btn--sm',
                text: 'Добавить проблему',
                on: { click: () => this.openAttentionModal(p.id) },
            }) : el('div', { class: 'pcard__sub', text: 'Режим просмотра — изменение данных недоступно' }),
        ]);
    },

    TABS: [
        { key: 'overview', label: 'Обзор' },
        { key: 'notifications', label: 'Уведомления' },
        { key: 'data', label: 'Данные' },
        { key: 'complaints', label: 'Комментарии' },
        { key: 'events', label: 'События и даты' },
        { key: 'checklist', label: 'Чек-лист' },
        { key: 'notes', label: 'Заметки' },
        { key: 'history', label: 'История' },
    ],

    renderTabs() {
        $('patientTabs').replaceChildren(frag(this.TABS.map(tab => el('button', {
            type: 'button',
            class: 'tab',
            role: 'tab',
            id: `tab-${tab.key}`,
            'aria-selected': this.currentTab === tab.key ? 'true' : 'false',
            tabindex:this.currentTab===tab.key?'0':'-1',
            'aria-controls': 'patientPanels',
            text: tab.label,
            on: {
                keydown:event=>{
                    const keys=['ArrowLeft','ArrowRight','Home','End'];if(!keys.includes(event.key))return;
                    event.preventDefault();const index=this.TABS.findIndex(t=>t.key===tab.key);
                    const next=event.key==='Home'?0:event.key==='End'?this.TABS.length-1:(index+(event.key==='ArrowRight'?1:-1)+this.TABS.length)%this.TABS.length;
                    $('tab-'+this.TABS[next].key).click();
                },
                click: () => this.openPatient(this.currentPatientId, tab.key),
            },
        }))));
    },

    renderTabPanel(p) {
        this.capturePatientEdits();
        const panels = $('patientPanels');
        const clinicalDirty = this.dirtyClinicalControls();
        if (clinicalDirty.length && panels.dataset.patientId === p.id) {
            this.currentTab = panels.dataset.tab;this.renderTabs();
            ui.toast('В форме есть несохраненный ввод. Сохраните поле или явно отмените ввод перед переходом.', 'warning');
            return;
        }
        const renderers = {
            overview: () => this.tabOverview(p),
            notifications: () => this.tabNotifications(p),
            data: () => this.tabData(p),
            complaints: () => this.tabComplaints(p),
            events: () => this.tabEvents(p),
            checklist: () => this.tabChecklist(p),
            notes: () => this.tabNotes(p),
            history: () => this.tabHistory(p),
        };
        panels.replaceChildren((renderers[this.currentTab] || renderers.overview)());
        panels.dataset.patientId=p.id;panels.dataset.tab=this.currentTab;
        panels.setAttribute('aria-labelledby','tab-'+this.currentTab);
        $('patientRoute').replaceChildren(panels.querySelector('.timeline') || this.renderTimeline(p));
        this.registerClinicalControls();
    },

    /* --- Вкладка «Обзор» ---------------------------------------------------- */

    tabOverview(p) {
        return el('div', { class: 'overview' }, [
            el('div', {}, [
                el('div', { class: 'panel panel--pad' }, [
                    this.renderTimeline(p),
                    el('h2', { class: 'section-title', text: 'Последние изменения' }),
                    this.renderFeed(p),
                ]),
            ]),
            el('div', {}, [
                this.patientAttentionCard(p),
                this.patientPortalAccessCard(p),
                this.can('accessConsilium') ? this.patientConsiliumCard(p.id) : null,
                el('div', { class: 'panel panel--pad', id: 'patientQualityBlock' }, [
                    el('h2', { class: 'section-title', text: 'Качество данных' }),
                    el('div', { class: 'empty', text: 'Загрузка…' }),
                ]),
                this.checklistSummaryCard(p),
                el('div', { class: 'panel panel--pad' }, [
                    el('h2', { class: 'section-title', text: 'Сводка для отчётности' }),
                    el('div', { class: 'summary', text: this.generateSummary(p) }),
                ]),
            ]),
        ]);
    },

    patientConsiliumCard(patientId) {
        const results = el('div', {id: 'patientConsiliumRecords', role: 'status'});
        const load = el('button', {
            id: 'loadPatientConsiliumBtn', class: 'btn btn--ghost btn--sm', type: 'button',
            text: 'Показать записи',
            on: {click: () => this.loadPatientConsiliumRecords(patientId, results, load)},
        });
        return el('section', {class: 'panel panel--pad', 'aria-labelledby': 'patientConsiliumTitle'}, [
            el('h2', {id: 'patientConsiliumTitle', class: 'section-title', text: 'Онкологический консилиум'}),
            load, results,
        ]);
    },

    async loadPatientConsiliumRecords(patientId, results, load) {
        if (load.disabled || !this.can('accessConsilium') || this.sessionExpired) return;
        const epoch = this.sessionEpoch;
        const current = () => results.isConnected && this.currentView === 'patient' && this.currentTab === 'overview' &&
            this.currentPatientId === patientId && this.sessionEpoch === epoch && !this.sessionExpired;
        load.disabled = true;
        results.textContent = 'Проверяем доступ…';
        try {
            const {appointments} = await apiGetJson('/api/consilium/appointments');
            if (!current()) return;
            const records = appointments.filter(item => item.patientId === patientId);
            results.replaceChildren(records.length ? el('ul', {class: 'f1-list'}, records.map(item =>
                el('li', {}, el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm',
                    text: [this.formatConsiliumDate(item.scheduledDate, item.scheduledTime), item.statusLabel].join(' · '),
                    on: {click: () => { if (current()) void this.openConsiliumDetails(item); }},
                })))) : el('p', {text: 'Доступных записей нет.'}));
        } catch {
            if (current()) results.textContent = 'Не удалось загрузить записи. Попробуйте обновить.';
        } finally {
            if (current()) {
                load.textContent = 'Обновить записи';
                load.disabled = false;
            }
        }
    },

    patientAttentionCard(p) {
        const activeCount = (p.attention && p.attention.activeCount) || 0;
        return el('div', { class: `panel panel--pad attention-panel ${activeCount ? 'attention-panel--active' : ''}` }, [
            el('div', { class: 'checkline' }, [
                el('h2', { class: 'section-title', text: 'Требует внимания' }),
                this.can('editPatients') ? el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: 'Добавить проблему',
                    on: { click: () => this.openAttentionModal(p.id) },
                }) : null,
            ]),
            el('div', { id: 'patientAttentionBlock' }, [
                el('div', { class: 'empty', text: activeCount ? 'Загрузка…' : 'Пациент не отмечен как требующий внимания' }),
            ]),
        ]);
    },

    attentionIssueNode(issue, writable) {
        const isEmergency = issue.reasonCode === 'emergency_hospitalization';
        return el('div', { class: `attention-issue ${isEmergency ? 'attention-issue--emergency' : ''}` }, [
            el('div', { class: 'attention-issue__head' }, [
                el('strong', { text: issue.reasonLabel || this.attentionReasonLabel(issue.reasonCode) }),
                el('span', { class: `chip ${issue.status === 'open' ? 'chip--warning' : 'chip--neutral'}` }, [
                    el('span', { class: 'chip__dot' }),
                    issue.status === 'open' ? 'Открыта' : 'Закрыта',
                ]),
            ]),
            issue.eventDate ? el('div', { class: 'person__meta', text: `Дата события: ${issue.eventDate}` }) : null,
            el('div', { class: 'person__meta', text: `Добавил: ${issue.createdByName || 'Сотрудник'} · ${this.formatDateTime(issue.createdAt)}` }),
            issue.comment ? el('p', { class: 'attention-issue__comment', text: issue.comment }) : null,
            issue.status === 'closed' ? el('div', { class: 'person__meta', text: `Закрыта: ${issue.closedByName || 'Сотрудник'} · ${this.formatDateTime(issue.closedAt)}` }) : null,
            issue.status === 'closed' && issue.resolutionComment ? el('p', { class: 'attention-issue__comment', text: issue.resolutionComment }) : null,
            issue.status === 'open' && writable ? el('button', {
                type: 'button',
                class: 'btn btn--ghost btn--sm',
                text: 'Закрыть',
                on: { click: () => this.openCloseAttentionIssueModal(issue.patientId, issue.id) },
            }) : null,
        ]);
    },

    /* --- Мобильное приложение пациента ------------------------------------- */

    patientPortalAccessCard(p) {
        return el('div', { class: 'panel panel--pad', id: 'patientPortalAccessBlock' }, [
            el('h2', { class: 'section-title', text: 'Мобильное приложение' }),
            el('div', { class: 'empty', text: 'Загрузка…' }),
        ]);
    },

    /** Состояние мобильного доступа и действия. Права приходят с сервера:
     *  кнопки скрываются по ним, но решение всё равно принимает backend. */
    async renderPatientPortalAccessBlock(patientId) {
        const target = $('patientPortalAccessBlock');
        if (!target) return;
        const title = el('h2', { class: 'section-title', text: 'Мобильное приложение' });
        try {
            const data = await apiGetJson(`/api/patients/${encodeURIComponent(patientId)}/portal-access`);
            const access = data.access || {};
            const rows = [];

            rows.push(el('div', { class: 'checkline' }, [
                el('span', { class: `chip ${this.portalAccessChipClass(access.status)}` }, [
                    el('span', { class: 'chip__dot' }),
                    access.statusLabel || 'Мобильный доступ не настроен',
                ]),
            ]));

            if (access.linked) {
                rows.push(el('div', { class: 'person__meta', text: `Адрес: ${access.emailMasked}` }));
                if (access.linkedByName) {
                    rows.push(el('div', {
                        class: 'person__meta',
                        text: `Привязал: ${access.linkedByName} · ${this.formatDateTime(access.linkedAt)}`,
                    }));
                }
                if (access.status === 'revoked' && access.revokedAt) {
                    rows.push(el('div', {
                        class: 'person__meta',
                        text: `Отключён: ${access.revokedByName || 'Сотрудник'} · ${this.formatDateTime(access.revokedAt)}`,
                    }));
                }
                if (access.lastLoginAt) {
                    rows.push(el('div', { class: 'person__meta', text: `Последний вход: ${this.formatDateTime(access.lastLoginAt)}` }));
                }
            } else {
                rows.push(el('div', { class: 'person__meta', text: 'Пациент не может войти в мобильное приложение' }));
            }

            const actions = [];
            if (data.canManage) {
                actions.push(el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: access.linked ? 'Изменить email' : 'Привязать email',
                    on: { click: () => this.linkPortalAccess(patientId, access.linked) },
                }));
            }
            if (data.canRevoke && access.linked && access.status !== 'revoked') {
                actions.push(el('button', {
                    type: 'button',
                    class: 'btn btn--quiet btn--sm',
                    text: 'Отключить доступ',
                    on: { click: () => this.revokePortalAccess(patientId) },
                }));
            }
            if (actions.length) rows.push(el('div', { class: 'checkline' }, actions));

            target.replaceChildren(frag([title, ...rows]));
        } catch (e) {
            target.replaceChildren(frag([
                title,
                el('div', { class: 'empty', text: `Не удалось загрузить состояние доступа: ${e.message}` }),
            ]));
        }
    },

    portalAccessChipClass(status) {
        if (status === 'active') return 'chip--good';
        if (status === 'linked') return 'chip--warning';
        if (status === 'revoked') return 'chip--danger';
        return 'chip--neutral';
    },

    /** Проверка формата до отправки: опечатка — самый частый исход этой формы,
     *  и оператор должен видеть подсказку, а не ответ валидатора. Сервер
     *  проверяет адрес заново, клиентская проверка защитой не является. */
    looksLikeEmail(value) {
        const address = (value || '').trim();
        if (!address || address.length > 254 || /\s/.test(address)) return false;
        return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/.test(address)
            && !address.startsWith('.') && !address.includes('..');
    },

    /** Человеческий текст вместо структурированного ответа API. Машинный
     *  клиент по-прежнему получает исходный 422 со списком полей. */
    portalAccessErrorText(error) {
        if (error && error.status === 409) return error.message;
        if (error && error.status === 422) return 'Введите корректный адрес электронной почты.';
        if (error && error.status === 429) return 'Слишком много попыток подряд. Подождите немного и повторите.';
        if (error && error.status === 403) return 'Недостаточно прав для этого действия.';
        const message = (error && error.message) || '';
        // Ответ валидатора начинается со списка полей — показывать его нельзя.
        if (message.startsWith('[') || message.startsWith('{')) return 'Не удалось сохранить адрес. Проверьте данные и повторите.';
        return message || 'Не удалось сохранить адрес.';
    },

    async linkPortalAccess(patientId, isChange) {
        const email = await ui.textPrompt({
            title: isChange ? 'Изменить email мобильного доступа' : 'Привязать email мобильного доступа',
            label: 'Email пациента',
        });
        if (!email) return;
        if (!this.looksLikeEmail(email)) {
            ui.toast('Введите корректный адрес электронной почты.', 'error');
            return;
        }
        try {
            await apiPut(`/api/patients/${encodeURIComponent(patientId)}/portal-access`, { email });
            ui.toast(isChange ? 'Адрес мобильного доступа изменён' : 'Мобильный доступ привязан', 'success');
            await this.renderPatientPortalAccessBlock(patientId);
        } catch (e) {
            ui.toast(this.portalAccessErrorText(e), 'error');
        }
    },

    async revokePortalAccess(patientId) {
        const confirmed = await ui.confirm({
            title: 'Отключить мобильный доступ?',
            text: 'Пациент потеряет доступ к приложению. Чтобы вернуть доступ, адрес нужно будет привязать заново.',
            okLabel: 'Отключить',
        });
        if (!confirmed) return;
        try {
            await apiDelete(`/api/patients/${encodeURIComponent(patientId)}/portal-access`);
            ui.toast('Мобильный доступ отключён', 'success');
            await this.renderPatientPortalAccessBlock(patientId);
        } catch (e) {
            ui.toast(this.portalAccessErrorText(e), 'error');
        }
    },

    async renderPatientAttentionBlock(patientId) {
        const target = $('patientAttentionBlock');
        if (!target) return;
        try {
            const data = await apiGetJson(`/api/patients/${encodeURIComponent(patientId)}/attention`);
            const active = data.active || [];
            const history = data.history || [];
            const writable = this.can('editPatients');
            target.replaceChildren(frag([
                active.length ? el('div', { class: 'attention-list' }, active.map(issue => this.attentionIssueNode(issue, writable))) :
                    el('div', { class: 'empty', text: 'Пациент не отмечен как требующий внимания' }),
                history.length ? el('details', { class: 'attention-history' }, [
                    el('summary', { text: `История внимания · ${history.length}` }),
                    el('div', { class: 'attention-list' }, history.map(issue => this.attentionIssueNode(issue, false))),
                ]) : null,
            ]));
        } catch (e) {
            target.replaceChildren(el('div', { class: 'empty', text: `Не удалось загрузить отметки внимания: ${e.message}` }));
        }
    },

    openAttentionModal(patientId) {
        this.attentionModalPatientId = patientId;
        $('attentionForm').reset();
        $('attentionFormError').classList.add('is-hidden');
        $('attentionReason').replaceChildren(frag([
            option('', 'Выберите причину', true),
            ...Object.entries(this.ATTENTION_REASON_LABELS).map(([code, label]) => option(code, label)),
        ]));
        this.updateAttentionEventDateRequirement();
        ui.openModal('attentionModal');
    },

    updateAttentionEventDateRequirement() {
        const required = $('attentionReason').value === 'emergency_hospitalization';
        $('attentionEventDate').required = required;
        const label = document.querySelector('label[for="attentionEventDate"]');
        if (label) label.textContent = required ? 'Дата события *' : 'Дата события';
    },

    openCloseAttentionIssueModal(patientId, issueId) {
        this.attentionCloseTarget = { patientId, issueId };
        $('attentionCloseForm').reset();
        $('attentionCloseFormError').classList.add('is-hidden');
        ui.openModal('attentionCloseModal');
    },

    async submitAttentionIssue(event) {
        event.preventDefault();
        const patientId = this.attentionModalPatientId;
        if (!patientId) return;
        const error = $('attentionFormError');
        error.classList.add('is-hidden');
        try {
            await apiPost(`/api/patients/${encodeURIComponent(patientId)}/attention`, {
                reasonCode: $('attentionReason').value,
                eventDate: $('attentionEventDate').value || null,
                comment: $('attentionComment').value,
            });
            ui.closeModal('attentionModal');
            const updated = await this.refreshPatientRecord(patientId);
            await this.loadPatients();
            this.replacePatientInCache(updated);
            this.renderPatientView();
            this.refreshInternalNotificationSummary();
            ui.toast('Проблема добавлена.', 'good');
        } catch (e) {
            error.textContent = e.message;
            error.classList.remove('is-hidden');
        }
    },

    async submitCloseAttentionIssue(event) {
        event.preventDefault();
        const target = this.attentionCloseTarget;
        if (!target) return;
        const error = $('attentionCloseFormError');
        error.classList.add('is-hidden');
        try {
            await apiPost(`/api/patients/${encodeURIComponent(target.patientId)}/attention/${encodeURIComponent(target.issueId)}/close`, {
                resolutionComment: $('attentionResolutionComment').value,
            });
            ui.closeModal('attentionCloseModal');
            const updated = await this.refreshPatientRecord(target.patientId);
            await this.loadPatients();
            this.replacePatientInCache(updated);
            this.renderPatientView();
            this.refreshInternalNotificationSummary();
            ui.toast('Проблема закрыта.', 'good');
        } catch (e) {
            error.textContent = e.message;
            error.classList.remove('is-hidden');
        }
    },

    renderTimeline(p) {
        const nodes = this.buildTimelineNodes(p);
        const selectedKey = this.selectedTimelineNodes[p.id] || null;

        return el('div', { class: 'timeline', tabindex:'0', role:'region', 'aria-label':'Этапы маршрута лечения' }, nodes.map((node, idx) => {
            const isNext = node.status === 'future' && node.isNext;
            const nodeKey = node.status === 'future' ? `future:${node.templateIndex}` : `occ:${node.occIndex}`;
            const stageLabel = this.stageNames[node.stage];
            const label = (node.occIndex !== undefined ? this.getStageLabel(p.history[node.occIndex]) : stageLabel)
                + (node.extra ? ' (доп.)' : '');

            const stateText = node.status === 'done' ? 'Завершён'
                : node.status === 'current' ? 'Текущий'
                : isNext ? 'Следующий' : 'Запланирован';

            const modifier = node.status === 'done' ? 'tl-step--done'
                : node.status === 'current' ? 'tl-step--current'
                : isNext ? 'tl-step--next' : 'tl-step--future';

            let deadlineText = null;
            if (p.nosology && (node.stage === 'appointment' || node.stage === 'consult')) {
                const dl = this.getStageDeadline(p, node.stage);
                if (dl) deadlineText = `до ${this.formatDeadlineDate(dl)}`;
            }

            const activate = isNext
                ? () => this.advanceToStage(p.id, node.stage, stageLabel)
                : () => this.selectTimelineNode(p.id, nodeKey);

            return el(this.isReadOnly() ? 'div' : 'button', {
                ...(this.isReadOnly() ? {role:'group'} : {type:'button'}),
                'data-route-click': !isNext && !this.isReadOnly() ? '' : null,
                class: `tl-step ${modifier} ${selectedKey === nodeKey ? 'is-selected' : ''}`,
                'aria-label': this.isReadOnly() ? `${stageLabel}: ${stateText}` : `${stageLabel}: ${stateText}. ${isNext ? 'Перевести пациента на этот этап' : 'Показать даты этапа'}`,
                on: this.isReadOnly() ? {} : { click: activate },
            }, [
                el('span', { class: 'tl-step__mark', text: node.status === 'done' ? '✓' : String(idx + 1) }),
                el('span', { class: 'tl-step__label', text: label }),
                el('span', { class: 'tl-step__state', text: stateText }),
                deadlineText ? el('span', { class: 'tl-step__deadline', text: deadlineText }) : null,
            ]);
        }));
    },

    /** Лента событий: этапы и их события в обратном хронологическом порядке. */
    renderFeed(p) {
        const entries = [];
        (p.history || []).forEach((occ, occIndex) => {
            entries.push({
                at: occ.enteredAt,
                tone: 'info',
                title: 'Изменение этапа',
                text: `Пациент переведён на этап: ${this.getStageLabel(occ)}`,
            });
            (occ.events || []).forEach(ev => {
                const { text } = this.formatEventText(ev, false, this.TREATMENT_LABELS);
                if (ev.actualDate) {
                    entries.push({
                        at: ev.setAt || ev.actualDate,
                        tone: ev.matchedPlan === false ? 'warning' : 'good',
                        title: 'Событие состоялось',
                        text: `${this.getStageLabel(occ)}: ${text}`,
                    });
                } else if (ev.date) {
                    entries.push({
                        at: ev.setAt || occ.enteredAt,
                        tone: 'info',
                        title: 'Запланировано событие',
                        text: `${this.getStageLabel(occ)}: ${text}`,
                    });
                }
            });
            if (occ.note) {
                entries.push({ at: occ.enteredAt, tone: 'warning', title: 'Заметка', text: occ.note });
            }
        });
        (p.diagnosisHistory || []).forEach(item => {
            entries.push({
                at: item.changedAt,
                tone: 'info',
                title: 'Изменение диагноза',
                text: `${item.oldDiagnosis || 'не указан'} → ${item.newDiagnosis || 'не указан'}`,
            });
        });

        if (!entries.length) {
            return el('div', { class: 'empty', text: 'Событий пока нет — они появятся после первых отметок дат.' });
        }

        entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

        return el('div', { class: 'feed' }, entries.slice(0, 12).map((entry, index) => {
            const d = new Date(entry.at);
            const dateText = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const timeText = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            return el('div', { class: 'feed__row' }, [
                el('div', { class: 'feed__when' }, [
                    el('div', { class: 'feed__date', text: dateText }),
                    el('div', { class: 'feed__time', text: timeText }),
                ]),
                el('div', { class: 'feed__rail' }, [
                    el('span', { class: `feed__dot feed__dot--${entry.tone}` }),
                    index < Math.min(entries.length, 12) - 1 ? el('span', { class: 'feed__line' }) : null,
                ]),
                el('div', { class: 'feed__card' }, [
                    el('div', { class: 'feed__title', text: entry.title }),
                    el('div', { class: 'feed__text', text: entry.text }),
                ]),
            ]);
        }));
    },

    checklistSummaryCard(p) {
        const occIndex = (p.history || []).length - 1;
        const occ = occIndex >= 0 ? p.history[occIndex] : null;
        const nosology = this.nosologyData[p.nosology];
        if (!occ || !nosology) return null;

        const required = (occ.stage === 'exam' ? nosology.checklistRequired : nosology.checklistRequiredStage2) || [];
        if (!required.length) return null;

        const checklist = occ.checklist || {};
        const doneCount = required.filter(item => checklist[item]).length;

        return el('div', { class: 'panel panel--pad' }, [
            el('div', { class: 'checkline' }, [
                el('h2', { class: 'section-title', text: 'Чек-лист этапа' }),
                el('span', { class: 'checkline__count', text: `${doneCount} из ${required.length}` }),
            ]),
            el('div', { class: 'progress' }, [
                el('div', { class: 'progress__track' },
                    el('div', { class: `progress__bar progress__bar--step${Math.max(1, Math.round(doneCount / required.length * 7))} progress__bar--completed` })),
            ]),
            el('div', {}, required.slice(0, 5).map(item => el('label', { class: 'checkbox' }, [
                el('input', {
                    type: 'checkbox', checked: !!checklist[item],
                    on: { change: (event) => this.updateChecklistItem(p.id, occIndex, item, event.target.checked) },
                }),
                el('span', { class: 'checkbox__text', text: item }),
            ]))),
            required.length > 5 ? el('button', {
                type: 'button', class: 'btn btn--quiet btn--sm', text: 'Открыть полный чек-лист', 'data-route-click': '',
                on: {
                    click: () => this.openPatient(p.id, 'checklist'),
                },
            }) : null,
        ]);
    },

    /* --- Вкладка «Данные» --------------------------------------------------- */

    field(label, control, hint) {
        const controls=control.matches?.('input,select,textarea')?[control]:[...control.querySelectorAll('input,select,textarea')];
        for(const [index,node] of controls.entries()) {
            if(!node.id)node.id='patient-field-'+newIdempotencyKey();
            if(!node.getAttribute('aria-label')&&!node.getAttribute('aria-labelledby'))node.setAttribute('aria-label',controls.length>1?`${label} ${index+1}`:label);
        }
        return el('div', { class: 'field' }, [
            el('label', { class: 'field__label', ...(controls.length===1?{for:controls[0].id}:{}) }, label),
            control,
            hint ? el('p', { class: 'field__hint', text: hint }) : null,
        ]);
    },

    patientInput(p, fieldName, type, value, transform) {
        const control = el('input', {
            class: 'input', type, value: value === null || value === undefined ? '' : value,
            on: {
                change: (event) => this.updatePatientField(
                    p.id, fieldName, transform ? transform(event.target.value) : event.target.value
                ),
            },
        });
        return this.trackPatientControl(p, fieldName, control, () => transform ? transform(control.value) : control.value);
    },

    patientSelect(p, fieldName, optionNodes) {
        return this.trackPatientControl(p, fieldName, el('select', {
            class: 'select',
            on: { change: (event) => this.updatePatientField(p.id, fieldName, event.target.value) },
        }, optionNodes));
    },

    localizationForDiagnosis(code) {
        const normalized = String(code || '').trim().toUpperCase();
        const match = this.allDiagnosisOptions().find(d => d.code === normalized);
        return match ? match.localization : '';
    },

    patientDiagnosisControl(p) {
        const currentLocalization = this.localizationForDiagnosis(p.diagnosis);
        const localizationSelect = el('select', {
            class: 'select',
            'aria-label': 'Локализация пациента',
        }, [
            option('', 'Все локализации', !currentLocalization),
            ...Object.keys(this.icd10Localizations).map(key => option(key, this.icd10Localizations[key].label, key === currentLocalization)),
        ]);
        const search = el('input', {
            class: 'input',
            type: 'search',
            value: '',
            placeholder: 'Поиск по коду или названию',
            'aria-label': 'Диагноз пациента',
        });
        const select = el('select', {
            class: 'select',
            on: { change: (event) => this.updatePatientField(p.id, 'diagnosis', event.target.value) },
        }, this.diagnosisOptionNodes(currentLocalization, '', p.diagnosis));
        this.trackPatientControl(p, 'diagnosis', select);
        const status = el('div', {}, this.clientPathStatusNode(this.clientPathForLocalization(currentLocalization)));
        const syncOptions = () => {
            const selected = select.value || p.diagnosis;
            select.replaceChildren(frag(this.diagnosisOptionNodes(localizationSelect.value, search.value, selected)));
        };
        localizationSelect.addEventListener('change', () => {
            select.value = '';
            syncOptions();
            status.replaceChildren(this.clientPathStatusNode(this.clientPathForLocalization(localizationSelect.value)));
        });
        search.addEventListener('input', () => {
            syncOptions();
        });
        return el('div', { class: 'stack stack--sm' }, [localizationSelect, search, select, status]);
    },

    patientPgiResultControl(p) {
        const error = el('p', { class: 'field__hint', text: 'Не переводит маршрут автоматически.' });
        const resultSelect = el('select', { class: 'select', 'aria-label': 'Результат ПГИ' }, [
            option('', this.PGI_RESULT_LABELS[''], !p.pgiResult),
            option('confirmed', this.PGI_RESULT_LABELS.confirmed, p.pgiResult === 'confirmed'),
            option('not_confirmed', this.PGI_RESULT_LABELS.not_confirmed, p.pgiResult === 'not_confirmed'),
        ]);
        const dateInput = el('input', {
            class: 'input',
            type: 'date',
            value: p.pgiResultDate || '',
            'aria-label': 'Дата результата ПГИ',
        });
        const readDraft = () => ({result: resultSelect.value, date: dateInput.value});
        this.trackPatientControl(p, 'pgiResult', resultSelect, readDraft);
        this.trackPatientControl(p, 'pgiResult', dateInput, readDraft);
        const save = () => {
            const result = resultSelect.value;
            const date = dateInput.value;
            if (result && !date) {
                error.textContent = 'Укажите дату результата ПГИ.';
                error.classList.add('field__hint--danger');
                dateInput.classList.add('input--invalid');
                dateInput.setAttribute('aria-invalid', 'true');
                dateInput.focus();
                return;
            }
            error.textContent = 'Не переводит маршрут автоматически.';
            error.classList.remove('field__hint--danger');
            dateInput.classList.remove('input--invalid');
            dateInput.removeAttribute('aria-invalid');
            this.updatePatientField(p.id, 'pgiResult', { result, date });
        };
        resultSelect.addEventListener('change', () => {
            if (!resultSelect.value) dateInput.value = '';
            save();
        });
        dateInput.addEventListener('change', save);
        return el('div', { class: 'stack stack--sm' }, [
            el('div', { class: 'grid-2' }, [
                this.field('Результат ПГИ', resultSelect),
                this.field('Дата результата ПГИ', dateInput),
            ]),
            error,
        ]);
    },

    tabData(p) {
        return el('div', { class: 'panel panel--pad' }, [
            el('fieldset', { class: 'fieldset' }, [
                el('legend', { class: 'fieldset__legend', text: 'Личные данные' }),
                this.field('ФИО', this.patientInput(p, 'name', 'text', p.name)),
                el('div', { class: 'grid-2' }, [
                    this.field('Возраст', this.patientInput(p, 'age', 'number', p.age, v => parseInt(v, 10) || 0)),
                    this.field('Телефон', this.patientInput(p, 'phone', 'tel', p.phone)),
                ]),
                this.field('Номер полиса ОМС', this.patientInput(p, 'policyNumber', 'text', p.policyNumber || '')),
            ]),
            el('fieldset', { class: 'fieldset' }, [
                el('legend', { class: 'fieldset__legend', text: 'Медицинская информация' }),
                this.field('Диагноз', this.patientDiagnosisControl(p), 'Локализация ограничивает список диагнозов; клиентский путь определяется автоматически.'),
                this.patientPgiResultControl(p),
            ]),
            el('fieldset', { class: 'fieldset' }, [
                el('legend', { class: 'fieldset__legend', text: 'Классификация и ответственные' }),
                el('div', { class: 'grid-2' }, [
                    this.field('Приоритет', this.patientSelect(p, 'priority', [
                        option('urgent', 'Срочно', p.priority === 'urgent'),
                        option('high', 'Высокий', p.priority === 'high'),
                        option('normal', 'Обычный', p.priority === 'normal'),
                    ])),
                    // Лечащий врач меняется только Разработчиком через отдельный
                    // диалог с подтверждением — свободный текст здесь недоступен.
                    this.field('Лечащий врач', el('input', {
                        class: 'input', type: 'text',
                        value: p.treatingDoctorName || p.doctor || '',
                        disabled: 'disabled',
                        'aria-label': 'Лечащий врач (изменяется Разработчиком)',
                    })),
                ]),
                this.field('Заведующий', this.patientSelect(p, 'head',
                    [...new Set([p.head, ...this.headOptions.map(h=>h.name)].filter(Boolean))].map(h => option(h, h + (!this.headOptions.some(x=>x.name===h) ? ' (сохраненное значение)' : ''), p.head === h)))),
            ]),
        ]);
    },

    tabComplaints(p) {
        return el('div', { class: 'panel panel--pad' }, [
            el('h2', { class: 'section-title', text: 'Комментарии' }),
            this.trackPatientControl(p, 'complaint', el('textarea', {
                class: 'textarea', rows: '10', value: p.complaint || '',
                'aria-label': 'Комментарии',
                on: { change: (event) => this.updatePatientField(p.id, 'complaint', event.target.value) },
            })),
            el('p', { class: 'field__hint', text: 'Поля сохраняются независимо. При переходе в другую вкладку несохраненный комментарий остается отдельным черновиком.' }),
        ]);
    },

    /* --- Вкладка «События и даты» ------------------------------------------- */

    tabEvents(p) {
        const history = p.history || [];
        if (!history.length) return el('div', { class: 'panel' }, el('div', { class: 'empty', text: 'Этапов пока нет.' }));

        const selectedKey = this.selectedTimelineNodes[p.id];
        let occIndex = history.length - 1;
        if (selectedKey && selectedKey.startsWith('occ:')) occIndex = parseInt(selectedKey.split(':')[1], 10);
        if (selectedKey && selectedKey.startsWith('future:')) {
            const stageKey = this.stageOrder[parseInt(selectedKey.split(':')[1], 10)];
            return el('div', { class: 'panel panel--pad' }, [
                this.renderTimeline(p),
                el('h2', { class: 'section-title', text: this.stageNames[stageKey] || 'Следующий этап' }),
                el('p', { class: 'field__hint', text: 'Этап ещё не наступил. Для перехода отметьте фактические данные текущего события.' }),
                el('button', {
                    type: 'button',
                    class: 'btn btn--primary',
                    text: 'Перевести пациента на этот этап',
                    on: { click: () => this.advanceToStage(p.id, stageKey, this.stageNames[stageKey]) },
                }),
            ]);
        }

        return el('div', { class: 'panel panel--pad' }, [
            this.renderTimeline(p),
            this.renderStageEventsPanel(p, occIndex),
        ]);
    },

    eventInput(p, occIndex, ev, fieldName, type, value, label) {
        const input=el('input', {
            class:'input',type,value:value || '', 'aria-label':label,'data-clinical-control':'true',
            on:{change:event=>this.updateEvent(p.id,occIndex,ev,fieldName,event.target.value,event.target)},
        });
        return el('div',{class:'clinical-field'},[
            this.field(label,input),
            el('button',{type:'button',class:'btn btn--quiet btn--sm','data-card-save':'true',text:'Сохранить поле',
                'aria-label':'Сохранить: '+label,on:{click:()=>{this.updateEvent(p.id,occIndex,ev,fieldName,input.value,input);}}}),
        ]);
    },

    renderStageEventsPanel(p, occIndex) {
        const occ = p.history[occIndex];
        if (!occ) return null;
        const stageKey = occ.stage;

        if (stageKey === 'primary-appointment') {
            const events = occ.events || [];
            const ev = events[0] || { actualDate: '', actualTime: '' };
            return frag([
                el('h2', { class: 'section-title', text: 'Первичный приём — фактические дата и время' }),
                !ev.actualDate ? el('p', { class: 'alert alert--danger', text: 'Дата фактического первичного приёма не заполнена — это обязательное поле.' }) : null,
                el('div', { class: 'event-card' }, [
                    el('div', { class: 'grid-2' }, [
                        this.eventInput(p, occIndex, events[0] || null, 'actualDate', 'date', ev.actualDate, 'Фактическая дата'),
                        this.eventInput(p, occIndex, events[0] || null, 'actualTime', 'time', ev.actualTime, 'Фактическое время'),
                    ]),
                ]),
                this.noteField(p, occIndex, occ.note),
                this.deletedEventsBlock(p),
            ]);
        }

        const schedulableLabels = {
            exam: 'обследования', appointment: 'приёма', consult: 'онкоконсилиума',
            'treatment-prep': 'лечения', treatment: 'лечения',
        };
        if (!schedulableLabels[stageKey]) {
            return frag([
                el('p', { class: 'muted', text: 'Для завершённого лечения плановые даты не заполняются.' }),
                this.noteField(p, occIndex, occ.note),
                this.deletedEventsBlock(p),
            ]);
        }

        const events = occ.events || [];
        const showType = (stageKey === 'treatment' || stageKey === 'treatment-prep');
        const isCurrentOcc = occIndex === p.history.length - 1;

        let warning = null;
        if (events.length === 0) warning = `Дата ${schedulableLabels[stageKey]} не заполнена.`;
        else if (showType && !events[events.length - 1].treatmentType) warning = 'Тип лечения не указан.';

        let deadlineNode = null;
        if (stageKey === 'appointment' || stageKey === 'consult') {
            const deadline = this.getStageDeadline(p, stageKey);
            if (deadline) {
                const lastEv = events[events.length - 1];
                const checkDate = lastEv ? (lastEv.actualDate || lastEv.date) : null;
                const overrun = checkDate && new Date(checkDate) > deadline;
                const nosologyLabel = this.nosologyData[p.nosology].label;
                deadlineNode = el('p', { class: `alert ${overrun ? 'alert--danger' : 'alert--warning'}` },
                    overrun
                        ? `Регламентный срок нарушен: событие должно было состояться не позднее ${this.formatDeadlineDate(deadline)} (${nosologyLabel}).`
                        : `Регламентный срок: не позднее ${this.formatDeadlineDate(deadline)} (${nosologyLabel}${p.priority !== 'normal' ? ', приоритет учтён' : ''}).`);
            }
        }

        const addLabels = {
            exam: 'Добавить дату обследования', appointment: 'Добавить приём',
            consult: 'Добавить дату консилиума', 'treatment-prep': 'Добавить дату лечения',
            treatment: 'Добавить дату лечения',
        };

        return frag([
            el('h2', { class: 'section-title', text: `Плановые и фактические даты — ${this.stageNames[stageKey]}` }),
            deadlineNode,
            warning ? el('p', { class: 'alert alert--danger', text: warning }) : null,

            ...events.map((ev, idx) => {
                const isPending = isCurrentOcc && idx === events.length - 1 && !ev.actualDate;
                let statusNode = null;
                if (!isPending && ev.actualDate) {
                    statusNode = ev.matchedPlan === false
                        ? el('span', { class: 'chip chip--warning', text: 'Состоялось с отклонением' })
                        : el('span', { class: 'chip chip--good', text: 'Состоялось по плану' });
                } else if (isPending && ev.date) {
                    statusNode = this.dateChip(this.getDaysUntil(ev.date), ev.time);
                }

                return el('div', { class: 'event-card', id:'patient-event-'+ev.id, tabindex:'-1' }, [
                    el('div', { class: 'event-card__head' }, [
                        el('span', { class: 'event-card__title', text: events.length > 1 ? `Событие ${idx + 1}` : 'Дата события' }),
                        el('button', {
                            type: 'button', class: 'btn btn--icon', 'aria-label': `Удалить событие ${idx + 1}`, title: 'Удалить событие',
                            on: { click: () => this.removeEvent(p.id, ev, events.length > 1 ? `Событие ${idx + 1}` : 'Дата события') },
                        }, icon('trash')),
                    ]),
                    statusNode,
                    ev.consiliumDecision ? el('div', { class: 'event-card__group' }, [
                        el('div', { class: 'event-card__legend', text: 'ОК' }),
                        el('span', {
                            class: 'chip chip--accent',
                            text: `Решение: ${this.CONSILIUM_DECISION_LABELS[ev.consiliumDecision] || ev.consiliumDecision}`,
                        }),
                        el('div', { class: 'pcard__sub', text: this.consiliumDecisionAttribution(ev) }),
                    ]) : null,
                    el('div', { class: 'event-card__group' }, [
                        el('div', { class: 'event-card__legend', text: 'План' }),
                        el('div', { class: 'grid-2' }, [
                            this.eventInput(p, occIndex, ev, 'date', 'date', ev.date, 'Плановая дата'),
                            this.eventInput(p, occIndex, ev, 'time', 'time', ev.time, 'Плановое время'),
                        ]),
                    ]),
                    el('div', { class: 'event-card__group' }, [
                        el('div', { class: 'event-card__legend', text: stageKey === 'appointment' ? 'Факт (заполните после приёма)' : 'Факт' }),
                        el('div', { class: 'grid-2' }, [
                            this.eventInput(p, occIndex, ev, 'actualDate', 'date', ev.actualDate, 'Фактическая дата'),
                            this.eventInput(p, occIndex, ev, 'actualTime', 'time', ev.actualTime, 'Фактическое время'),
                        ]),
                    ]),
                    showType ? el('div', { class: 'event-card__group' }, [
                        el('div', { class: 'event-card__legend', text: 'Тип лечения' }),
                        el('select', {
                            class: 'select', 'aria-label': 'Тип лечения', 'data-clinical-control':'true',
                            on: { change: (event) => this.updateEvent(p.id, occIndex, ev, 'treatmentType', event.target.value, event.target) },
                        }, this.treatmentTypeOptions(ev.treatmentType || '')),
                    ]) : null,
                ]);
            }),

            el('button', {
                type: 'button', class: 'btn btn--ghost',
                on: { click: () => this.addEvent(p.id, occIndex) },
            }, [icon('plus'), addLabels[stageKey]]),

            this.noteField(p, occIndex, occ.note),
            this.deletedEventsBlock(p),
        ]);
    },

    // Удалённые события пациента: хранятся в истории и восстанавливаются.
    // Список загружается по запросу; права проверяет сервер (как на правку).
    deletedEventsBlock(p) {
        if (this.isReadOnly()) return null;
        const list = el('div', { class: 'deleted-events', 'aria-live': 'polite' });
        const toggle = el('button', {
            type: 'button', class: 'btn btn--ghost btn--sm', 'aria-expanded': 'false',
            text: 'Показать удалённые события',
            on: { click: () => {
                const open = toggle.getAttribute('aria-expanded') === 'true';
                toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
                toggle.textContent = open ? 'Показать удалённые события' : 'Скрыть удалённые события';
                if (open) list.replaceChildren();
                else this.renderDeletedEvents(p.id, list);
            } },
        });
        return el('div', { class: 'event-card__group' }, [toggle, list]);
    },

    eventSummaryText(ev) {
        const parts = [];
        if (ev.date) parts.push(`план ${this.formatDeadlineDate(new Date(`${ev.date}T12:00:00`))}${ev.time ? ` ${ev.time}` : ''}`);
        if (ev.actualDate) parts.push(`факт ${this.formatDeadlineDate(new Date(`${ev.actualDate}T12:00:00`))}${ev.actualTime ? ` ${ev.actualTime}` : ''}`);
        if (ev.consiliumDecision) parts.push(`решение ОК: ${this.CONSILIUM_DECISION_LABELS[ev.consiliumDecision] || ev.consiliumDecision}`);
        return parts.length ? parts.join(', ') : 'даты не заполнены';
    },

    async renderDeletedEvents(patientId, container) {
        container.replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
        let data;
        try {
            data = await apiGetJson(`/api/patients/${patientId}/events/deleted`);
        } catch (e) {
            container.replaceChildren(el('p', { class: 'alert alert--danger', role: 'alert', text: `Не удалось загрузить удалённые события: ${e.message}` }));
            return;
        }
        const events = data.events || [];
        if (!events.length) {
            container.replaceChildren(el('div', { class: 'empty', text: 'Удалённых событий нет.' }));
            return;
        }
        container.replaceChildren(frag(events.map(ev => el('div', { class: 'event-card' }, [
            el('div', { class: 'event-card__head' }, [
                el('span', { class: 'event-card__title', text: `${this.stageNames[ev.historyStage] || ev.historyStage}: ${this.eventSummaryText(ev)}` }),
            ]),
            el('p', { class: 'muted', text: `Удалено ${this.formatDateTime(ev.deletedAt)}, ${ev.deletedByName}` }),
            ev.consiliumDecision ? el('p', { class: 'muted', text: this.consiliumDecisionAttribution(ev) }) : null,
            el('button', {
                type: 'button', class: 'btn btn--ghost btn--sm',
                text: 'Восстановить событие',
                'aria-label': `Восстановить событие: ${this.eventSummaryText(ev)}`,
                on: { click: () => this.restoreEvent(patientId, ev, container) },
            }),
        ]))));
    },

    noteField(p, occIndex, note) {
        const input=el('textarea', {class:'textarea',rows:'3',value:note || '','data-clinical-control':'true',
            placeholder:'Свободный комментарий по этому этапу…',
            on:{change:event=>this.updateOccurrenceNote(p.id,occIndex,event.target.value,event.target)},
        });
        return el('div',{class:'clinical-field'},[
            this.field('Примечание к этапу',input),
            el('button',{type:'button',class:'btn btn--ghost btn--sm','data-card-save':'true',text:'Сохранить заметку',
                on:{click:()=>{this.updateOccurrenceNote(p.id,occIndex,input.value,input);}}}),
        ]);
    },

    /* --- Вкладки «Чек-лист», «Заметки», «История» --------------------------- */

    tabChecklist(p) {
        const history = p.history || [];
        const occIndex = history.length - 1;
        const occ = occIndex >= 0 ? history[occIndex] : null;
        const nosology = this.nosologyData[p.nosology];

        if (!occ || !nosology) {
            return el('div', { class: 'panel' }, el('div', { class: 'empty', text: 'Чек-лист доступен после указания профиля клиентского пути.' }));
        }

        const isExam = occ.stage === 'exam';
        const required = (isExam ? nosology.checklistRequired : nosology.checklistRequiredStage2) || [];
        const optional = (isExam ? nosology.checklistOptional : nosology.checklistOptionalStage2) || [];

        if (!required.length && !optional.length) {
            return el('div', { class: 'panel panel--pad' }, [el('div', { class: 'empty', text: 'Для текущего этапа чек-лист не предусмотрен.' }),this.workspaceChecklistHistory(p,nosology)]);
        }

        const checklist = occ.checklist || {};
        const item = (name, isRequired) => el('label', { class: 'checkbox' }, [
            el('input', {
                type: 'checkbox', checked: !!checklist[name],
                on: { change: (event) => this.updateChecklistItem(p.id, occIndex, name, event.target.checked) },
            }),
            el('span', { class: 'checkbox__text' }, [name, isRequired ? el('span', { class: 'req', text: ' *' }) : null]),
        ]);

        return el('div', { class: 'panel panel--pad' }, [
            el('div', { class: 'checkline' }, [
                el('h2', { class: 'section-title', text: `Чек-лист: ${nosology.label}` }),
                el('span', { class: 'checkline__count', text: `${required.filter(i => checklist[i]).length} из ${required.length}` }),
            ]),
            ...required.map(name => item(name, true)),
            optional.length ? el('h3', { class: 'section-title', text: 'Опционально / по показаниям' }) : null,
            ...optional.map(name => item(name, false)),
            this.workspaceChecklistHistory(p,nosology),
        ]);
    },

    workspaceChecklistHistory(p,nosology={}) {
        const history=p.history||[];if(history.length<2)return null;
        return el('details',{class:'workspace-checklist-history'},[
            el('summary',{text:'Предыдущие вхождения этапов — только чтение'}),
            ...history.slice(0,-1).map((old,index)=>{
                const req=(old.stage==='exam'?nosology.checklistRequired:old.stage==='consult'?nosology.checklistRequiredStage2:[])||[];
                const opt=(old.stage==='exam'?nosology.checklistOptional:old.stage==='consult'?nosology.checklistOptionalStage2:[])||[];
                const names=[...new Set([...req,...opt,...Object.keys(old.checklist||{})])];
                return el('section',{'data-checklist-occurrence':old.id},[
                    el('h3',{class:'section-title',text:`${index+1}. ${this.getStageLabel(old)}`}),el('p',{class:'muted',text:this.formatDateTime(old.enteredAt)}),
                    el('p',{class:'muted',text:'Сохраненные отметки этого вхождения. Категории пунктов указаны по текущему справочнику.'}),
                    names.length?el('ul',{},names.map(name=>el('li',{},[el('span',{text:old.checklist?.[name]===true?'Выполнено: ':'Не выполнено: '}),el('span',{text:name+(req.includes(name)?' — обязательный пункт':opt.includes(name)?' — по показаниям':' — сохраненный исторический пункт')})]))):el('p',{text:'Для этого этапа чек-лист не предусмотрен.'}),
                ]);
            }),
        ]);
    },

    tabNotes(p) {
        const history = p.history || [];
        if (!history.length) return el('div', { class: 'panel' }, el('div', { class: 'empty', text: 'Этапов пока нет.' }));
        return el('div', { class: 'panel panel--pad' }, history.map((occ, occIndex) => el('div', { class: 'event-card' }, [
            el('div', { class: 'event-card__head' }, [
                el('span', { class: 'event-card__title', text: this.getStageLabel(occ) }),
                el('span', { class: 'muted', text: this.formatDateTime(occ.enteredAt) }),
            ]),
            this.noteField(p, occIndex, occ.note),
        ])));
    },

    tabHistory(p) {
        const history = p.history || [];
        if (!history.length) return el('div', { class: 'panel' }, el('div', { class: 'empty', text: 'История пуста.' }));

        return el('div', { class: 'panel panel--pad' }, history.map((occ, i) => {
            const isCurrentOcc = i === history.length - 1;
            const events = occ.events || [];
            return el('div', { class: 'event-card' }, [
                el('div', { class: 'event-card__head' }, [
                    el('span', { class: 'event-card__title', text: `${i + 1}. ${this.getStageLabel(occ)}` }),
                    isCurrentOcc ? el('span', { class: 'chip chip--accent', text: 'Текущий этап' }) : null,
                ]),
                el('div', { class: 'muted', text: `Статус проставлен: ${new Date(occ.enteredAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` }),
                ...(events.length ? events.map((ev, idx) => {
                    const isPending = isCurrentOcc && idx === events.length - 1 && !ev.actualDate;
                    const { text, status } = this.formatEventText(ev, isPending, this.TREATMENT_LABELS);
                    return el('div', { class: 'plan-row' }, [
                        el('span', { class: 'plan-row__date', text: text }),
                        el('span', { class: `chip chip--${ev.actualDate ? (ev.actualDateUnverified || ev.matchedPlan === false ? 'warning' : 'good') : 'neutral'}`, text: status }),
                    ]);
                }) : [el('p', { class: 'muted', text: 'Плановая дата не указана.' })]),
                occ.note ? el('p', { class: 'alert alert--warning', text: `Заметка: ${occ.note}` }) : null,
            ]);
        }));
    },

    /* ====================================================== РЕНДЕР: КАЧЕСТВО ДАННЫХ */

    qualityFilterCount() {
        const f = this.quality.filters;
        return [f.severity, f.category, f.code, f.doctor, f.department].filter(Boolean).length;
    },

    updateQualityFiltersButton() {
        const label = $('qualityFiltersBtnLabel');
        if (!label) return;
        const count = this.qualityFilterCount();
        label.textContent = count ? `Фильтры · ${count}` : 'Фильтры';
        $('openQualityFiltersSheetBtn').setAttribute('aria-label', count
            ? `Фильтры качества данных, активных фильтров: ${count}`
            : 'Фильтры качества данных');
    },

    openQualityFiltersSheet() {
        $('qualityFiltersSheetBody').append($('qualityToolbarFilters'));
        $('openQualityFiltersSheetBtn').setAttribute('aria-expanded', 'true');
        ui.openModal('qualityFiltersSheet');
    },

    closeQualityFiltersSheet() {
        ui.closeModal('qualityFiltersSheet');
        $('openQualityFiltersSheetBtn').setAttribute('aria-expanded', 'false');
        const toolbar = document.querySelector('#view-quality .toolbar');
        toolbar.append($('qualityToolbarFilters'));
    },

    resetQualityFilters() {
        this.quality.filters = {
            query: '',
            severity: '',
            category: '',
            code: '',
            doctor: '',
            department: '',
            sort: 'severity',
        };
        $('qualitySearchInput').value = '';
        $('qualitySeverityFilter').value = '';
        $('qualityCategoryFilter').value = '';
        $('qualityCodeFilter').value = '';
        $('qualityDoctorFilter').value = '';
        $('qualityDepartmentFilter').value = '';
        $('qualitySortSelect').value = 'severity';
        this.renderDataQuality();
    },

    qualitySeverityChip(severity) {
        const label = this.QUALITY_SEVERITY_LABELS[severity] || 'Нет проблем';
        const tone = severity === 'critical' ? 'danger' : severity === 'warning' ? 'warning' : severity === 'info' ? 'neutral' : 'good';
        return el('span', { class: `chip chip--${tone}`, text: label });
    },

    qualityProblemChip(label = 'Проблема') {
        return el('span', { class: 'chip chip--danger', text: label });
    },

    qualityParams() {
        const f = this.quality.filters;
        const params = new URLSearchParams();
        if (f.severity) params.set('severity', f.severity);
        if (f.category) params.set('category', f.category);
        if (f.code) params.set('code', f.code);
        if (f.doctor) params.set('treating_doctor', f.doctor);
        if (f.department) params.set('department', f.department);
        if (f.sort) params.set('sort', f.sort);
        params.set('limit', '200');
        return params.toString();
    },

    scheduleRead(key, render, immediate = false) {
        this.readVersions = this.readVersions || {};
        this.readTimers = this.readTimers || {};
        this.readVersions[key] = (this.readVersions[key] || 0) + 1;
        clearTimeout(this.readTimers[key]);
        this.readTimers[key] = setTimeout(() => render.call(this), immediate ? 0 : 300);
    },

    beginRead(key) {
        this.readVersions = this.readVersions || {};
        this.readTimers = this.readTimers || {};
        clearTimeout(this.readTimers[key]);
        return this.readVersions[key] = (this.readVersions[key] || 0) + 1;
    },

    isCurrentRead(key, version) {
        return !this.sessionExpired && this.readVersions[key] === version;
    },

    scheduleQualitySearch() {
        this.qualityRequest = (this.qualityRequest || 0) + 1;
        clearTimeout(this.qualitySearchTimer);
        this.qualitySearchTimer = setTimeout(() => this.renderDataQuality(), this.quality.filters.query ? 300 : 0);
    },

    // The bounded component is dormant in the normal bootstrap. A trusted
    // embedding can mount it without changing the server's public admission.
    mountQualityV1(endpoint, filters = {}, selectedFacets = new Map()) {
        if (typeof endpoint !== 'string' || !/^\/api\/[a-zA-Z0-9_/-]+$/.test(endpoint)) throw new Error('Invalid Quality endpoint');
        this.clearQualityV1(true);
        clearTimeout(this.qualitySearchTimer);
        this.qualityRequest = (this.qualityRequest || 0) + 1;
        Object.assign(this.quality, {summary: null, issues: [], patients: [], duplicateGroups: []});
        for (const id of ['qualityStatsRow', 'qualityBody', 'qualityDuplicatesPanel']) $(id).replaceChildren();
        const host = $('qualityV1Workspace');
        for (const element of host.parentElement.children) {
            if (element !== host) element.classList.add('is-hidden');
        }
        host.hidden = false;
        const config = {
            context: () => this.user && !this.sessionExpired && !this.sessionReconciling
                ? JSON.stringify([this.user.id, this.accessSignature(this.user), this.sessionEpoch || 0])
                : null,
            visible: owner => owner ? this.currentView === 'patient' && this.currentPatientId === owner
                : this.currentView === 'quality' && this.user?.roleId !== 'consilium_chair',
            read: request => apiFetch(...ClinicQualityV1.requestPath(endpoint, request)),
            onAccessLost: (error, owner) => {
                this.clearQualityV1(true);
                if (error?.status === 401 || error?.data?.code === 'ACCESS_CONTEXT_CHANGED') {
                    this.expireSession(true);
                } else if (owner && error?.status === 403) {
                    this.forgetDeniedPatient(owner);
                }
            },
            onOwnerUnavailable: owner => {
                this.clearQualityV1(false);
                this.forgetDeniedPatient(owner);
            },
            navigate: (id, tab, current, action) => this.openQualityV1Target(id, tab, current, action),
            categories: this.QUALITY_CATEGORY_LABELS,
            codes: this.QUALITY_CODE_LABELS,
        };
        const workspace = new ClinicQualityV1.Panel(host, config);
        workspace.filters = {...filters};
        workspace.selectedFacets = new Map(selectedFacets);
        this.qualityV1 = {endpoint, config, workspace, card: null};
        if (this.currentView === 'quality' && config.context()) void workspace.start();
    },

    clearQualityV1(forget) {
        if (!this.qualityV1) return;
        this.qualityV1.workspace.clear(forget);
        this.qualityV1.card?.clear(true);
    },

    openQualityV1Target(id, tab, scopeCurrent, action) {
        const allowed = () => scopeCurrent() && (!action || (action.can_write &&
            (tab === 'structure'
                ? action.workflow === 'unresolved_treating_doctor' && this.can('manageDepartments')
                : this.can('editPatients'))));
        const options = {
            allowed,
            denied: error => {
                this.clearQualityV1(error.status === 403);
                if (this.currentView === 'quality') {
                    this.qualityV1.workspace.publish({state: 'error', key: 'patients', error});
                }
            },
        };
        if (tab === 'structure') return browserNavigation.navigate({screen: 'structure'}, {...options, objectId: id});
        return this.openPatient(id, tab || 'overview', {...options, focus: () => $('crumbPatientName')});
    },

    async loadDataQuality(requestId = this.qualityRequest) {
        const search = this.quality.filters.query;
        const query = this.qualityParams();
        const summary = await apiGetJson('/api/data-quality/summary');
        if (requestId !== this.qualityRequest || this.qualityV1) return false;
        const issues = await apiFetch(`/api/data-quality/issues?${query}`, { headers: searchHeaders(search) });
        if (requestId !== this.qualityRequest) return false;
        this.quality.summary = summary;
        this.quality.issues = issues.issues || [];
        this.quality.patients = issues.patients || [];
        this.quality.duplicateGroups = issues.duplicate_groups || [];
        this.quality.rules = issues.rules || {};
        return true;
    },

    async renderDataQuality() {
        if (this.qualityV1) return this.qualityV1.workspace.start();
        clearTimeout(this.qualitySearchTimer);
        const requestId = this.qualityRequest = (this.qualityRequest || 0) + 1;
        this.updateQualityFiltersButton();
        const body = $('qualityBody');
        const empty = $('qualityEmpty');
        const dupPanel = $('qualityDuplicatesPanel');
        body.replaceChildren();
        empty.classList.remove('is-hidden');
        empty.textContent = 'Загрузка…';
        dupPanel.replaceChildren();

        try {
            if (!await this.loadDataQuality(requestId)) return;
            this.renderQualityFiltersOptions();
            this.renderQualityStats();
            this.renderQualityRows();
            this.renderQualityDuplicates();
        } catch (e) {
            if (requestId !== this.qualityRequest) return;
            empty.classList.remove('is-hidden');
            empty.textContent = `Не удалось загрузить качество данных: ${e.message}`;
            $('qualityStatsRow').replaceChildren();
            dupPanel.replaceChildren();
        }
    },

    renderQualityFiltersOptions() {
        const selectedDoctor = this.quality.filters.doctor;
        const selectedDept = this.quality.filters.department;
        const doctors = [...new Set(this.quality.patients.map(p => p.treating_doctor_name).filter(Boolean))].sort();
        const departments = [...new Set(this.quality.patients.flatMap(p => p.department_names || []))].sort();
        $('qualityDoctorFilter').replaceChildren(frag([
            option('', 'Любой лечащий врач', !selectedDoctor),
            ...doctors.map(name => option(name, name, name === selectedDoctor)),
        ]));
        $('qualityDepartmentFilter').replaceChildren(frag([
            option('', 'Любое отделение', !selectedDept),
            ...departments.map(name => option(name, name, name === selectedDept)),
        ]));
    },

    renderQualityStats() {
        const s = this.quality.summary || {};
        const stat = (label, value, meta, filter, tone = '') => {
            const className = `stat ${filter ? 'stat--button' : ''} ${tone ? 'stat--' + tone : ''}`;
            const props = { class: className };
            const children = [
                el('div', { class: 'stat__label', text: label }),
                el('div', { class: 'stat__value', text: String(value ?? 0) }),
                el('div', { class: 'stat__meta', text: meta }),
            ];
            if (!filter) return el('div', props, children);
            return el('button', {
                type: 'button',
                class: className,
                on: { click: () => {
                    Object.assign(this.quality.filters, {
                        severity: '',
                        category: '',
                        code: '',
                        doctor: '',
                        department: '',
                        query: '',
                    }, filter);
                    $('qualitySearchInput').value = '';
                    this.syncQualityFilterControls();
                    this.renderDataQuality();
                } },
            }, children);
        };
        $('qualityStatsRow').replaceChildren(frag([
            stat('Пациентов с проблемами', s.patients_with_issues, `${s.total_patients || 0} в области доступа`, null, s.patients_with_issues ? 'danger' : 'good'),
            stat('Критические ошибки', s.critical_count, 'требуют проверки', { severity: 'critical' }, s.critical_count ? 'danger' : 'good'),
            stat('Предупреждения', s.warning_count, 'уточнить данные', { severity: 'warning' }, s.warning_count ? 'danger' : 'good'),
            stat('Возможные дубли', s.possible_duplicate_groups, 'только ручная проверка', { code: 'possible_duplicate' }, s.possible_duplicate_groups ? 'danger' : 'good'),
            stat('Заполненность обязательных полей', `${s.average_completeness ?? 100}%`, 'не включает проблемы маршрута и дат', null, 'good'),
        ]));
    },

    syncQualityFilterControls() {
        const f = this.quality.filters;
        $('qualitySeverityFilter').value = f.severity;
        $('qualityCategoryFilter').value = f.category;
        $('qualityCodeFilter').value = f.code;
        $('qualityDoctorFilter').value = f.doctor;
        $('qualityDepartmentFilter').value = f.department;
        $('qualitySortSelect').value = f.sort;
    },

    renderQualityRows() {
        const rows = this.quality.patients;
        const body = $('qualityBody');
        const empty = $('qualityEmpty');
        if (!rows.length) {
            body.replaceChildren();
            empty.classList.remove('is-hidden');
            empty.textContent = this.quality.summary && this.quality.summary.total_issues === 0
                ? 'По действующим правилам качества проблем не обнаружено.'
                : 'По выбранным условиям проблем не найдено. Измените фильтры или поиск.';
            return;
        }
        empty.classList.add('is-hidden');
        body.replaceChildren(frag(rows.map(row => el('tr', {}, [
            el('td', {}, el('div', { class: 'person' }, [
                el('span', { class: 'avatar avatar--normal', text: this.initials(row.patient_name) }),
                el('div', {}, [
                    el('div', { class: 'person__name', text: row.patient_name }),
                    el('div', { class: 'person__meta', text: row.issue_count ? `${row.issue_count} ${this.pluralize(row.issue_count, 'проблема', 'проблемы', 'проблем')}` : 'Проблем не обнаружено' }),
                ]),
            ])),
            el('td', { class: 'cell-quality-score' }, [
                el('div', { class: 'quality-score' }, [
                    el('span', { class: 'quality-score__value', text: `${row.completeness.score}%` }),
                    el('span', { class: 'quality-score__label', text: 'Заполненность обязательных полей' }),
                ]),
                row.completeness.missing.length
                    ? el('div', { class: 'muted', text: `Не заполнено: ${row.completeness.missing.map(m => m.label).join(', ')}` })
                    : el('div', { class: 'muted', text: 'Обязательные поля заполнены' }),
            ]),
            el('td', { class: 'cell-quality-issues' }, [
                row.issue_count ? this.qualityProblemChip(`${row.issue_count} ${this.pluralize(row.issue_count, 'проблема', 'проблемы', 'проблем')}`) : this.qualitySeverityChip(null),
                ...(row.top_issues || []).map(issue => el('div', { class: 'quality-issue-line' }, [
                    el('span', { class: 'severity-dot severity-dot--danger', text: 'Проблема' }),
                    el('span', { text: issue.title }),
                ])),
            ]),
            el('td', { class: 'cell-quality-owner' }, [
                el('div', { text: row.treating_doctor_name || 'Не назначен' }),
                row.department_names && row.department_names.length
                    ? el('div', { class: 'muted', text: row.department_names.join(', ') })
                    : el('div', { class: 'muted', text: 'Отделение не указано' }),
            ]),
            el('td', { class: 'cell-actions' }, [
                el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Открыть пациента',
                    'aria-label': `Открыть карточку: ${row.patient_name}`,
                    on: { click: () => this.openPatient(row.patient_id) },
                }),
            ]),
        ]))));
    },

    renderQualityDuplicates() {
        const panel = $('qualityDuplicatesPanel');
        const groups = this.quality.duplicateGroups || [];
        if (!groups.length) {
            panel.replaceChildren(frag([
                el('h2', { class: 'panel__title', text: 'Возможные дубли' }),
                el('p', { class: 'panel__text', text: 'По доступным пациентам возможные дубли не найдены.' }),
            ]));
            return;
        }
        panel.replaceChildren(frag([
            el('h2', { class: 'panel__title', text: 'Возможные дубли' }),
            el('p', { class: 'panel__text', text: 'Совпадение не означает, что записи являются дублями. Требуется ручная проверка.' }),
            ...groups.map(group => el('div', { class: 'duplicate-group' }, [
                el('div', { class: 'duplicate-group__reason', text: group.reason }),
                el('div', { class: 'duplicate-group__patients' }, group.patients.map(p => el('button', {
                    type: 'button',
                    class: 'sheet-item',
                    on: { click: () => this.openPatient(p.patient_id) },
                }, [
                    el('span', { class: 'sheet-item__title', text: p.patient_name }),
                    el('span', { class: 'sheet-item__hint', text: `Заполненность полей: ${p.completeness}%` }),
                ]))),
            ])),
        ]));
    },

    async renderPatientQualityBlock(patientId) {
        const box = $('patientQualityBlock');
        if (!box) return;
        if (this.qualityV1) {
            this.qualityV1.card?.clear(true);
            const card = new ClinicQualityV1.Panel(box, this.qualityV1.config, patientId);
            this.qualityV1.card = card;
            return card.start();
        }
        box.replaceChildren(frag([
            el('h2', { class: 'section-title', text: 'Качество данных' }),
            el('div', { class: 'empty', text: 'Загрузка…' }),
        ]));
        try {
            const data = await apiGetJson(`/api/data-quality/patients/${patientId}`);
            const comp = data.patient.completeness;
            const issues = data.issues || [];
            const groups = data.duplicate_groups || [];
            box.replaceChildren(frag([
                el('h2', { class: 'section-title', text: 'Качество данных' }),
                el('div', { class: 'quality-score quality-score--block' }, [
                    el('span', { class: 'quality-score__value', text: `${comp.score}%` }),
                    el('span', { class: 'quality-score__label', text: 'Заполненность обязательных полей' }),
                ]),
                comp.missing.length
                    ? el('p', { class: 'muted', text: `Не заполнено: ${comp.missing.map(m => m.label).join(', ')}.` })
                    : el('p', { class: 'muted', text: 'Обязательные поля заполнены.' }),
                issues.length
                    ? el('div', { class: 'quality-findings' }, issues.map(issue => this.renderQualityFinding(patientId, issue)))
                    : el('div', { class: 'empty', text: 'По действующим правилам качества проблем не обнаружено.' }),
                groups.length ? el('div', { class: 'quality-findings' }, [
                    el('h3', { class: 'section-title', text: 'Возможные дубли' }),
                    el('p', { class: 'muted', text: 'Совпадение не означает, что записи являются дублями. Требуется ручная проверка.' }),
                    ...groups.map(group => el('div', { class: 'quality-finding' }, [
                        el('div', { class: 'quality-finding__title', text: group.reason }),
                        el('div', { class: 'quality-finding__text', text: group.patients.map(p => p.patient_name).join(', ') }),
                    ])),
                ]) : null,
            ]));
        } catch (e) {
            box.replaceChildren(frag([
                el('h2', { class: 'section-title', text: 'Качество данных' }),
                el('div', { class: 'empty', text: 'Не удалось загрузить качество данных.' }),
            ]));
        }
    },

    renderQualityFinding(patientId, issue) {
        const action = issue.suggested_action || {};
        const canWriteAction = action.can_write !== false;
        const readonlyMessage = 'Режим просмотра — изменение данных недоступно';
        return el('div', { class: 'quality-finding quality-finding--danger' }, [
            el('div', { class: 'quality-finding__head' }, [
                this.qualityProblemChip('Проблема'),
                el('span', { class: 'quality-finding__category', text: this.QUALITY_CATEGORY_LABELS[issue.category] || issue.category }),
            ]),
            el('div', { class: 'quality-finding__title', text: issue.title }),
            el('div', { class: 'quality-finding__text', text: issue.description }),
            issue.details && issue.details.sample_missing
                ? el('div', { class: 'quality-finding__text', text: `Не отмечено: ${issue.details.sample_missing.join(', ')}${issue.details.missing_count > issue.details.sample_missing.length ? '…' : ''}` })
                : null,
            el('button', {
                type: 'button',
                class: 'btn btn--ghost btn--sm',
                text: action.label || 'Открыть',
                disabled: !canWriteAction,
                'aria-label': canWriteAction ? (action.label || 'Открыть') : `${action.label || 'Открыть'}: ${readonlyMessage}`,
                title: canWriteAction ? (action.label || 'Открыть') : readonlyMessage,
                on: { click: () => {
                    if (canWriteAction) this.followQualityAction(patientId, action);
                } },
            }),
            canWriteAction ? null : el('div', { class: 'quality-finding__text', text: readonlyMessage }),
        ]);
    },

    followQualityAction(patientId, action) {
        if (action && action.workflow === 'unresolved_treating_doctor' && action.tab === 'structure') {
            return this.navigateView('structure');
        }
        const tab = action && action.tab ? action.tab : 'overview';
        this.openPatientTab(patientId, tab);
    },

    openPatientTab(id, tab) {
        return this.openPatient(id, tab || 'overview');
    },

    /* ============================================================= ИИ-ПОМОЩНИК */

    aiReadTicket(key) { return {key,version:this.beginRead(key),epoch:this.sessionEpoch||0,owner:this.user?.id}; },
    aiReadCurrent(t) { return !!this.user&&!this.sessionExpired&&!this.sessionReconciling&&t.owner===this.user.id&&t.epoch===(this.sessionEpoch||0)&&this.isCurrentRead(t.key,t.version); },
    cancelAIRequest() {
        this.beginRead('ai-chat');this.ai.request=null;this.ai.loading=false;
        this.ai.messages=this.ai.messages.filter(m=>!m.pending);
    },
    async refreshAIStatus(force = false) {
        const ticket=this.aiReadTicket('ai-status');this.ai.probing=true;this.updateAIButtonState();this.renderAIDrawer();
        try {
            const status=await apiGetJson(`/api/ai/status${force ? '?refresh=true' : ''}`);if(!this.aiReadCurrent(ticket))return;
            this.ai.status=status;
        } catch(error) {if(this.aiReadCurrent(ticket))this.ai.status={enabled:true,available:false,state:'unavailable'};}
        finally {if(this.aiReadCurrent(ticket)){this.ai.probing=false;this.updateAIButtonState();this.renderAIDrawer();}}
    },
    aiProviderLabel() {
        if(this.ai.probing||this.ai.status?.state==='probing')return 'Проверяем доступность модели…';
        return {disabled:'Модель выключена',available:'Модель доступна',unavailable:'ИИ-помощник временно недоступен'}[this.ai.status?.state]||'Доступность модели не проверена';
    },
    updateAIButtonState() {
        const button=$('aiAssistantBtn');if(!button)return;
        button.classList.toggle('is-muted',!this.ai.status?.available);button.setAttribute('aria-label','Открыть ИИ-помощник');button.title=this.aiProviderLabel();
    },

    roleAISuggestions() {
        const role = this.user && this.user.roleId;
        if (role === 'doctor') {
            return [
                'Какие мои пациенты требуют внимания?',
                'Что у меня на сегодня?',
                'Есть ли у моих пациентов просрочки?',
            ];
        }
        if (role === 'department_head') {
            return [
                'Кому в отделении требуется решение заведующего?',
                'Где больше всего просрочек?',
                'Как распределена нагрузка по врачам?',
            ];
        }
        return [
            'Сколько пациентов требуют внимания?',
            'Какая самая частая причина внимания?',
            'Что у меня на сегодня?',
        ];
    },

    openAIDrawer(patientId) {
        if(patientId)this.setAIPatientContext(patientId);
        this.ai.returnFocusTarget=document.activeElement;
        this.ai.lastFocusId = document.activeElement && document.activeElement.id ? document.activeElement.id : '';
        this.closeInternalNotificationsDrawer(false);
        $('aiAssistantScrim').classList.remove('is-hidden');
        $('aiAssistantDrawer').classList.remove('is-hidden');
        $('aiAssistantDrawer').setAttribute('aria-hidden', 'false');
        $('aiAssistantBtn').setAttribute('aria-expanded', 'true');
        this.renderAIDrawer();
        if (!this.ai.loading) {
            $('aiAssistantInput').focus();
        } else {
            $('aiAssistantClose').focus();
        }
    },

    closeAIDrawer(returnFocus = true) {
        $('aiAssistantScrim').classList.add('is-hidden');
        $('aiAssistantDrawer').classList.add('is-hidden');
        $('aiAssistantDrawer').setAttribute('aria-hidden', 'true');
        $('aiAssistantBtn').setAttribute('aria-expanded', 'false');
        if (returnFocus) {
            const target=this.ai.returnFocusTarget;
            if(target?.isConnected&&!target.closest('[hidden],.is-hidden,[inert]'))target.focus();else $('aiAssistantBtn').focus();
        }
    },

    setAIPatientContext(patientId) {
        if(this.ai.patientContextId!==patientId){this.cancelAIRequest();this.ai.messages=[];this.ai.references=[];this.ai.lastError='';$('aiAssistantInput').value='';}
        const patient=this.getPatient(patientId);this.ai.patientContextId=patientId;this.ai.patientContextLabel=patient?patient.name:'Выбранный пациент';this.renderAIDrawer();
    },
    clearAIPatientContext() {
        this.cancelAIRequest();this.ai.patientContextId=null;this.ai.patientContextLabel='';this.ai.messages=[];this.ai.references=[];this.ai.lastError='';$('aiAssistantInput').value='';this.renderAIDrawer();
    },

    renderAIContext() {
        const box = $('aiAssistantContext');
        if (!box) return;
        if (!this.ai.patientContextId) {
            box.classList.add('is-hidden');
            box.replaceChildren();
            return;
        }
        box.classList.remove('is-hidden');
        box.replaceChildren(frag([
            el('span', { text: `Пациент: ${this.ai.patientContextLabel || this.ai.patientContextId}` }),
            el('button', {
                type: 'button',
                class: 'btn btn--ghost btn--sm',
                text: 'Убрать',
                'aria-label': 'Убрать контекст пациента',
                on: { click: () => this.clearAIPatientContext() },
            }),
        ]));
    },

    renderAISuggestions() {
        const box = $('aiAssistantSuggestions');
        if (!box) return;
        const status = this.ai.status || {};
        if (this.ai.loading) {
            box.replaceChildren();
            box.classList.add('is-hidden');
            return;
        }
        box.classList.remove('is-hidden');
        const suggestions = this.roleAISuggestions();
        box.replaceChildren(frag(suggestions.map(prompt => el('button', {
            type: 'button',
            class: 'chip-btn',
            text: prompt,
            on: {
                click: () => {
                    $('aiAssistantInput').value = prompt;
                    $('aiAssistantInput').focus();
                },
            },
        }))));
    },

    renderAIMessage(message) {
        const mine = message.role === 'user',epoch=this.sessionEpoch,owner=this.user?.id;
        const children = [
            el('div', { class: 'ai-message__role', text: mine ? (message.pending?'Вы · ожидается ответ':message.failed?'Вы · ответ не получен':'Вы') : 'Ответ сервера · только чтение' }),
            el('div', { class: 'ai-message__text', text: message.content }),
        ];
        if (!mine && message.references && message.references.length) {
            children.push(el('div', { class: 'ai-result-cards' }, message.references.map(ref => {
                if (ref.type !== 'patient') return null;
                return el('article', { class: 'ai-result-card' }, [
                    el('div', { class: 'ai-result-card__body' }, [
                        el('strong', { text: ref.title || 'Пациент' }),
                        ref.subtitle ? el('span', { text: ref.subtitle }) : null,
                    ]),
                    el('button', {
                        type: 'button',
                        class: 'btn btn--ghost btn--sm',
                        text: ref.label || 'Открыть',
                        'aria-label': `${ref.label || 'Открыть'}: ${ref.title || 'пациент'}`,
                        on: { click: async()=>{if(this.ai.loading||this.sessionEpoch!==epoch||this.user?.id!==owner||!this.ai.messages.includes(message))return;const opened=await this.openNotificationPatient(ref.patientId,'overview');if(opened&&epoch===this.sessionEpoch)this.closeAIDrawer();} },
                    }),
                ]);
            })));
        }
        return el('article', { class: `ai-message ${mine ? 'ai-message--user' : 'ai-message--assistant'}` }, children);
    },

    renderAIDrawer() {
        const messages=$('aiAssistantMessages'),status=this.ai.status||{};if(!messages)return;
        $('aiAssistantSubtitle').textContent='История чата хранится только в текущей вкладке и очищается при смене сотрудника или перезагрузке.';
        this.renderAIContext();this.renderAISuggestions();
        $('aiProviderState').textContent=this.aiProviderLabel()+'. Основная система продолжает работать. Сервер может отвечать на поддерживаемые запросы без модели.';
        $('aiAssistantRefresh').disabled=!!this.ai.probing;$('aiAssistantRefresh').textContent=this.ai.probing?'Проверка…':'Проверить снова';
        const busy=!!this.ai.loading;$('aiAssistantStatus').classList.toggle('is-hidden',!busy&&!this.ai.lastError);
        $('aiAssistantStatus').textContent=busy?'Запрос отправлен. Ожидается ответ сервера…':this.ai.lastError||'';
        $('aiAssistantInput').disabled=busy;$('aiAssistantSendBtn').disabled=busy||this.sessionExpired||this.sessionReconciling;
        $('aiAssistantClearBtn').disabled=busy||!this.ai.messages.length;$('aiAssistantForm').classList.toggle('is-hidden', !status.available);
        $('aiFallbackForm').classList.toggle('is-hidden',!!status.available);$('aiFallbackLabel').classList.toggle('is-hidden',!!status.available);
        const source=status.available?$('aiFallbackForm'):$('aiAssistantForm'),target=status.available?$('aiAssistantForm'):$('aiFallbackForm');
        if(source.children.length){const focused=document.activeElement;target.append(...source.children);if(target.contains(focused)&&!focused.disabled)focused.focus({preventScroll:true});}
        $('aiAssistantMessages').setAttribute('aria-busy',String(busy));
        messages.replaceChildren(this.ai.messages.length?frag(this.ai.messages.map(m=>this.renderAIMessage(m))):el('div',{class:'ai-empty'},[
            el('h3',{text:'Вопрос по доступным данным'}),el('p',{text:'Попробуйте: «Что у меня на сегодня?» или «Какие пациенты требуют внимания?». Если сервер не поддерживает запрос и модель недоступна, ответ не будет создан.'}),
        ]));messages.scrollTop=messages.scrollHeight;
    },
    aiUnsafeAnswer(text) { return /(?:tool_calls?|function_call|system_prompt|api_key|authorization\s*:\s*bearer|-----BEGIN.*PRIVATE KEY)/i.test(text); },
    async sendAIMessage(event) {
        event?.preventDefault();const input=$('aiAssistantInput'),text=input.value.trim();
        if(!text||this.ai.loading||this.sessionExpired||this.sessionReconciling)return;
        const ticket=this.aiReadTicket('ai-chat'),context=this.ai.patientContextId||null,active=this.currentView==='patient'?this.currentPatientId:null;
        const pending={role:'user',content:text,pending:true};const op={ticket,context,active};this.ai.request=op;this.ai.loading=true;this.ai.lastError='';
        const history=this.ai.messages.filter(m=>!m.pending&&!m.failed&&['user','assistant'].includes(m.role)).slice(-12).map(m=>({role:m.role,content:m.content.slice(0,4000)}));
        this.ai.messages.push(pending);this.renderAIDrawer();
        const current=()=>this.aiReadCurrent(ticket)&&this.ai.request===op&&(this.ai.patientContextId||null)===context&&(this.currentView==='patient'?this.currentPatientId:null)===active;
        try {
            const response=await apiPost('/api/ai/chat',{message:text,history,patientContextId:context});if(!current())return;
            if(context){await apiGetJson('/api/patients/'+encodeURIComponent(context));if(!current())return;}
            if(typeof response.answer!=='string'||this.aiUnsafeAnswer(response.answer)){pending.pending=false;pending.failed=true;this.ai.lastError='Ответ не удалось безопасно показать. Вопрос сохранен; автоматической повторной отправки нет.';return;}
            pending.pending=false;const refs=(response.references||[]).filter(ref=>ref.type==='patient'&&typeof ref.patientId==='string');
            this.ai.references=refs;this.ai.messages.push({role:'assistant',content:response.answer||'Сервер не вернул текст ответа.',references:refs});
            if(input.value.trim()===text)input.value='';
        } catch(error) {
            if(!current())return;pending.pending=false;pending.failed=true;
            if([403,404].includes(error.status)){this.ai.messages=[];this.ai.references=[];this.ai.patientContextId=null;this.ai.patientContextLabel='';input.value='';this.ai.lastError='Контекст недоступен. Данные диалога очищены. Проверьте доступ к карточке.';
                if(context&&context===this.currentPatientId){try{await apiGetJson('/api/patients/'+encodeURIComponent(context));}catch(check){if(this.aiReadCurrent(ticket)&&[403,404].includes(check.status)){this.discardSessionAndReload();return;}}}
            }
            else this.ai.lastError=({401:'Сессия завершена. Войдите повторно.',429:'Слишком много запросов. Вопрос сохранен; повторите отправку вручную позже.',502:'Сервер не получил корректный ответ модели. Вопрос сохранен.',503:'Сервис не дал ответа. Вопрос сохранен; поддерживаемые сервером запросы могут работать без модели.'})[error.status]||'Ответ не получен. Вопрос сохранен. Автоматической повторной отправки нет.';
        } finally {
            if(this.ai.request===op){this.ai.request=null;this.ai.loading=false;if(this.aiReadCurrent(ticket)){this.renderAIDrawer();if(!$('aiAssistantDrawer').classList.contains('is-hidden'))input.focus({preventScroll:true});}}
        }
    },
    clearAIConversation() {
        if(this.ai.loading)return;this.cancelAIRequest();this.ai.messages=[];this.ai.references=[];this.ai.lastError='';$('aiAssistantInput').value='';this.renderAIDrawer();$('aiAssistantInput').focus();
    },

    /* =============================================== РЕНДЕР: ЦЕНТР УВЕДОМЛЕНИЙ */

    // I-6A: notification reads are fenced by session AND failure generation.
    notificationTicket(key) { return {key, version:this.beginRead(key), epoch:this.sessionEpoch||0, generation:this.notificationGeneration||0}; },
    notificationCurrent(t) { return !!this.user && !this.sessionExpired && !this.sessionReconciling && t.epoch===(this.sessionEpoch||0) && t.generation===(this.notificationGeneration||0) && this.isCurrentRead(t.key,t.version); },
    notificationLive(t) { return !!this.user && !this.sessionExpired && !this.sessionReconciling && t.epoch===(this.sessionEpoch||0) && t.generation===(this.notificationGeneration||0); },
    notificationControls() {
        const blocked=!!(this.notificationMutation||this.notificationTemplateChecking);
        for(const id of ['internalNotificationsReadAllBtn','internalNotificationsFullReadAllBtn']) if($(id)) $(id).disabled=blocked||!this.internalSummaryReady||!this.internalNotifications.summary?.unread_count||!(this.internalReady?.full||this.internalReady?.drawer);
        for(const id of ['notificationsGenerateBtn','notificationsProcessBtn']) if($(id)) $(id).disabled=blocked||!this.notifications.ready;
        document.querySelectorAll('#patientNotificationsBlock button:not([data-notification-refresh]), #notificationTemplatesPanel button:not([data-notification-refresh]), .internal-notification__actions button, #notificationsBody button').forEach(b=>{
            const stale=b.closest('#patientNotificationsBlock')?!this.patientNotificationReady:b.closest('#notificationTemplatesPanel,#notificationsBody')?!this.notifications.ready:b.closest('#internalNotificationsDrawerList')?!this.internalReady?.drawer:!this.internalReady?.full;
            if(blocked||stale){if(!Object.hasOwn(b.dataset,'notificationDisabled'))b.dataset.notificationDisabled=String(b.disabled);b.disabled=true;}
            else if(Object.hasOwn(b.dataset,'notificationDisabled')){b.disabled=b.dataset.notificationDisabled==='true';delete b.dataset.notificationDisabled;}
        });
        for(const node of this.notificationInputNodes('patient')){
            if(this.notificationMutation?.pending&&this.notificationMutation.scope==='patient'){if(!Object.hasOwn(node.dataset,'writeDisabled'))node.dataset.writeDisabled=String(node.disabled);node.disabled=true;}
            else if(Object.hasOwn(node.dataset,'writeDisabled')){node.disabled=node.dataset.writeDisabled==='true';delete node.dataset.writeDisabled;}
        }
    },
    notificationReadFinished(scope) { if((scope==='patient'&&!this.notificationPatientFresh(this.currentPatientId))||(scope==='outbound'&&!this.notificationOutboundFresh())||(scope==='internal'&&!this.internalReadReady()))return; if(this.notificationMutation?.unknown&&!this.notificationMutation.pending&&this.notificationMutation.scope===scope&&(scope!=='patient'||this.notificationMutation.patientId===this.currentPatientId))this.notificationMutation=null; this.notificationControls(); },
    notificationInputNodes(scope) {
        return scope==='patient'?[...document.querySelectorAll('#patientNotificationTemplate,#patientNotificationSchedule')]:[...document.querySelectorAll('#notificationTemplatesPanel textarea,#notificationTemplatesPanel input[type="checkbox"]')];
    },
    notificationInputValue(node) { return JSON.stringify(node.type==='checkbox'?node.checked:node.value); },
    stampNotificationInputs(scope) {
        this.notificationInputBaselines ||= new WeakMap();
        for(const node of this.notificationInputNodes(scope)){const t=scope==='outbound'?this.notifications.templates.find(t=>t.code===this.notificationTemplateCode(node)):null;this.notificationInputBaselines.set(node,{initial:this.notificationInputValue(node),retain:false,origin:t?this.notificationTemplateState(t):null});}
    },
    notificationInputSnapshot(scope,force=false) {
        const nodes=this.notificationInputNodes(scope);
        const dirty=n=>{const c=this.notificationInputBaselines?.get(n);return c&&this.notificationInputValue(n)!==c.initial;};
        if(scope==='outbound')return nodes.filter(dirty).map(n=>{const c=this.notificationInputBaselines.get(n);return {id:n.id,value:n.value,checked:n.checked,focused:document.activeElement===n,initial:c.initial,origin:c.origin};});
        if(!nodes.some(n=>{const c=this.notificationInputBaselines?.get(n);return force||c?.retain||dirty(n);}))return [];
        return nodes.map(n=>({id:n.id,value:n.value,checked:n.checked,focused:document.activeElement===n}));
    },
    notificationTemplateCode(node) { return node.id.replace(/^template-(?:body|enabled)-/,''); },
    notificationTemplateState(t) { return JSON.stringify({body:t.body,enabled:!!t.enabled,version:t.version}); },
    restoreNotificationInputs(scope,draft) {
        for(const item of draft){const node=$(item.id);if(!node)continue;
            const c=this.notificationInputBaselines?.get(node);
            if(scope==='outbound'){
                const value=JSON.stringify(node.type==='checkbox'?item.checked:item.value);
                // A confirmed server value also resolves an acknowledged or lost response.
                if(this.notificationInputValue(node)===value){if(item.focused&&!node.disabled)node.focus({preventScroll:true});continue;}
                if(!c||!item.origin)continue;
                c.conflict=c.origin!==item.origin;c.initial=item.initial;c.origin=item.origin;
            }
            if(node.tagName==='SELECT'&&![...node.options].some(o=>o.value===item.value)){const unavailable=option(item.value,'Сохраненный выбор — шаблон больше недоступен',true);unavailable.disabled=true;node.append(unavailable);}
            node.value=item.value;if(node.type==='checkbox')node.checked=item.checked;
            if(c)c.retain=true;
            if(item.focused&&!node.disabled)node.focus({preventScroll:true});
        }
        if(draft.length)this.notificationFormNotice(scope,'Введенные значения сохранены отдельно от обновленного состояния сервера. Проверьте результат перед новым действием.');
    },
    renderNotificationTemplateDraftStates() {
        for(const t of this.notifications.templates){
            const body=$(`template-body-${t.code}`),enabled=$(`template-enabled-${t.code}`);if(!body||!enabled)continue;
            const host=body.closest('.notification-template');host.querySelector('[data-template-draft-state]')?.remove();
            const dirty=[body,enabled].filter(n=>{const c=this.notificationInputBaselines?.get(n);return c&&this.notificationInputValue(n)!==c.initial;});
            const conflict=dirty.some(n=>this.notificationInputBaselines.get(n).conflict);
            const save=host.querySelector('button');save.disabled=conflict;
            if(!dirty.length)continue;
            host.append(el('div',{class:'alert alert--warning','data-template-draft-state':t.code},[
                el('p',{role:'alert',text:conflict?'Конфликт шаблона: серверное состояние изменилось. Черновик не сохранен; отправка заблокирована. Скопируйте нужный ввод перед его отменой.':'Несохраненный черновик. Он отличается от подтвержденных данных сервера.'}),
                conflict?el('div',{},[el('p',{text:`Сейчас на сервере: ${t.enabled?'включен':'выключен'}, версия ${t.version}`}),el('pre',{class:'notification-template__server',text:t.body})]):null,
                el('button',{type:'button',class:'btn btn--ghost','data-template-discard':t.code,text:'Использовать свежие данные сервера',on:{click:()=>this.discardNotificationTemplateDraft(t.code)}}),
            ]));
        }
    },
    async discardNotificationTemplateDraft(code) {
        if(!this.notificationOutboundFresh()||this.notificationMutation||this.notificationTemplateChecking)return;
        const epoch=this.sessionEpoch,t=this.notifications.templates.find(t=>t.code===code);if(!t)return;
        const state=this.notificationTemplateState(t);
        if(!await ui.confirm({title:'Отменить черновик шаблона?',text:'Несохраненный ввод этого шаблона будет заменен показанными данными сервера. Другие черновики сохранятся.',okLabel:'Использовать данные сервера',danger:false}))return;
        if(epoch!==this.sessionEpoch||!this.notificationOutboundFresh()||this.notificationMutation||this.notificationTemplateChecking||!this.can('manageNotificationTemplates')||state!==this.notificationTemplateState(this.notifications.templates.find(t=>t.code===code)||{}))return;
        for(const node of this.notificationInputNodes('outbound').filter(n=>this.notificationTemplateCode(n)===code)){
            if(node.type==='checkbox')node.checked=!!t.enabled;else node.value=t.body;
            this.notificationInputBaselines.set(node,{initial:this.notificationInputValue(node),origin:state,retain:false});
        }
        this.renderNotificationTemplateDraftStates();if(!this.notificationInputSnapshot('outbound').length)$('notificationTemplatesPanel').querySelector('[data-notification-form-state]')?.remove();
        $(`template-body-${code}`).focus();
    },
    notificationFormNotice(scope,message) {
        const host=scope==='patient'?$('patientNotificationsBlock'):$('notificationTemplatesPanel');if(!host)return;
        let notice=host.querySelector('[data-notification-form-state]');
        if(!notice){notice=el('div',{class:'alert alert--warning','data-notification-form-state':scope},[el('p',{role:'alert'}),el('button',{type:'button',class:'btn btn--ghost','data-notification-refresh':'true',text:'Проверить состояние на сервере',on:{click:()=>scope==='patient'?this.renderPatientNotificationsBlock(this.currentPatientId):this.renderNotifications()}})]);host.prepend(notice);}
        notice.querySelector('p').textContent=message;
    },
    notificationFailure(t) {
        if(!this.notificationLive(t))return;
        const keys=t.key?[t.key]:t.scope==='patient'?['patient-notifications']:t.scope==='outbound'?['notifications']:t.scope==='internal'?['internal-summary','internal-drawer','internal-full']:[];
        for(const key of keys){this.beginRead(key);
            if(key==='internal-summary'){this.internalSummaryReady=false;this.internalNotifications.summary=null;}
            if(key==='internal-drawer'||key==='internal-full'){
                const target=key==='internal-drawer'?'drawer':'full';this.internalReady||={};this.internalReady[target]=false;this.internalNotifications[target==='drawer'?'drawerItems':'fullItems']=[];
                $(target==='drawer'?'internalNotificationsDrawerList':'internalNotificationsFullList').replaceChildren();
                if(target==='full'){this.internalNotifications.total=0;$('internalNotificationsPageInfo').textContent='Нет актуальных данных';for(const id of ['internalNotificationsPrevBtn','internalNotificationsNextBtn'])$(id).disabled=true;}
            }
            if(key==='notifications'){
                Object.assign(this.notifications,{summary:null,items:[],ready:false,total:0});$('notificationsBody').replaceChildren();$('notificationsStatsRow').replaceChildren();$('notificationsPageInfo').textContent='Нет актуальных данных';
                for(const id of ['notificationsPrevBtn','notificationsNextBtn'])$(id).disabled=true;
                this.notificationFormNotice('outbound','Нет актуальных данных исходящей очереди. Ввод шаблонов сохранен; обновите состояние перед записью.');
            }
            if(key==='patient-notifications'){
                const keep=this.notificationInputSnapshot('patient',t.scope==='patient');
                this.patientNotificationReady=false;this.patientNotificationItems=[];this.patientNotificationCanWrite=false;this.patientNotificationCanCreate=false;
                const box=$('patientNotificationsBlock');if(box){
                    if(!keep.length)box.replaceChildren();
                    else {for(const node of box.querySelectorAll('.notification-consent,.notification-list,.notification-row'))node.remove();for(const n of this.notificationInputNodes('patient')){const c=this.notificationInputBaselines?.get(n);if(c)c.retain=true;}}
                    this.notificationFormNotice('patient','Нет актуальных данных уведомлений пациента. Введенные значения сохранены; проверьте историю перед повторной записью.');
                }
            }
        }
        this.updateInternalNotificationsBadge();this.notificationControls();
    },
    notificationPatientFresh(id) { return this.patientNotificationReady&&this.patientNotificationId===id&&this.currentPatientId===id&&this.currentView==='patient'&&this.currentTab==='notifications'&&!this.sessionExpired; },
    notificationOutboundFresh() { return this.notifications.ready&&this.currentView==='notifications'&&this.notifications.activeTab==='outbound'&&!this.sessionExpired&&!this.sessionReconciling; },
    internalReadReady() { return !this.sessionExpired&&!this.sessionReconciling&&(this.internalReady?.drawer||(this.internalReady?.full&&this.currentView==='notifications'&&this.notifications.activeTab==='inbox')); },
    internalItemCurrent(item) { return this.internalReadReady()&&((this.internalReady?.drawer&&this.internalNotifications.drawerItems.includes(item))||(this.internalReady?.full&&this.currentView==='notifications'&&this.notifications.activeTab==='inbox'&&this.internalNotifications.fullItems.includes(item))); },
    async notificationWrite(scope,guard,write,refresh) {
        if(this.notificationMutation||this.sessionExpired||this.sessionReconciling||!guard())return false;
        const op={scope,pending:true,unknown:false,epoch:this.sessionEpoch||0,generation:this.notificationGeneration||0,view:this.currentView,patientId:this.currentPatientId};this.notificationMutation=op;this.notificationControls();
        try {
            await write();op.acknowledged=true;
            if(!this.notificationLive(op))return false;
            if(op.view!==this.currentView||(scope==='patient'&&op.patientId!==this.currentPatientId)){if(this.notificationMutation===op)this.notificationMutation=null;return false;}
            await refresh();
            if(!this.notificationLive(op))return false;
            const ready=scope==='patient'?this.notificationPatientFresh(op.patientId):scope==='outbound'?this.notificationOutboundFresh():this.internalReadReady();
            if(!ready){if(scope!=='internal')this.notificationFormNotice(scope,'Сервер подтвердил запись, но актуальное состояние не получено. Ввод сохранен; проверьте сервер перед новым действием.');return false;}
            if(this.notificationMutation===op)this.notificationMutation=null;
            ui.toast('Состояние уведомлений обновлено с сервера.','good');
            return true;
        } catch(e) {
            if(this.notificationLive(op)){if([403,404].includes(e.status)){this.discardSessionAndReload();return false;}this.notificationFailure(op);ui.toast('Результат операции не подтвержден. Сначала обновите данные с сервера. '+e.message,'warning');}
            return false;
        } finally {
            if(this.notificationMutation===op){op.pending=false;op.unknown=true;}
            this.notificationControls();
        }
    },
    internalGroups(rows,compact) {
        const groups=new Map();for(const item of rows){const key=item.type||'other';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
        return frag([...groups].map(([key,items])=>el('section',{class:'notification-group'},[el('h3',{class:'notification-group__title',text:(this.INTERNAL_NOTIFICATION_TYPE_LABELS[key]||key)+' · '+items.length}),...items.map(item=>this.renderInternalNotificationCard(item,compact))])));
    },
    internalNotificationParams(target) {
        const state = this.internalNotifications;
        const params = new URLSearchParams();
        const tab = target === 'drawer' ? state.drawerFilter : state.fullTab;
        const filters = state.filters;
        const type = target === 'drawer' ? '' : filters.type;
        const unread = target === 'drawer' ? '' : filters.unread;

        if (tab === 'unread' || unread === 'unread') params.set('unread_only', 'true');
        if (tab === 'today' || tab === 'overdue') params.set('drawer_filter', tab);
        if (this.INTERNAL_NOTIFICATION_TYPE_LABELS[tab] && tab !== 'today' && tab !== 'overdue') {
            params.set('type', tab);
        }
        if (type) params.set('type', type);
        params.set('limit', String(target === 'drawer' ? 5 : filters.limit));
        params.set('offset', String(target === 'drawer' ? 0 : filters.offset));
        return params.toString();
    },

    async refreshInternalNotificationSummary() {
        const ticket=this.notificationTicket('internal-summary');this.internalSummaryReady=false;this.updateInternalNotificationsBadge();this.notificationControls();
        try {
            const summary=await apiGetJson('/api/internal-notifications/summary');if(!this.notificationCurrent(ticket))return;
            this.internalNotifications.summary=summary;this.internalSummaryReady=true;this.updateInternalNotificationsBadge();this.notificationControls();
        } catch(e) { if(this.notificationCurrent(ticket))this.notificationFailure(ticket); }
    },

    updateInternalNotificationsBadge() {
        const badge = $('internalNotificationsBadge');
        const bell = $('internalNotificationsBell');
        if (!badge || !bell) return;
        const unread = this.internalSummaryReady ? Number(this.internalNotifications.summary?.unread_count||0) : null;
        if($('internalNotificationsSubtitle'))$('internalNotificationsSubtitle').textContent=unread===null?'Счетчик временно недоступен':unread?`${unread} ${this.pluralize(unread,'новое','новых','новых')}`:'Новых уведомлений нет';
        badge.classList.toggle('is-hidden', unread === null || unread <= 0);
        badge.textContent = unread === null ? '' : String(unread);
        bell.setAttribute('aria-label', unread === null ? 'Уведомления: счетчик временно недоступен' : unread
            ? `Открыть уведомления, новых: ${unread}`
            : 'Открыть уведомления');
    },

    async loadInternalNotifications(target, version) {
        const summaryTicket=this.notificationTicket('internal-summary');
        const searchText = target === 'drawer' ? '' : (this.internalNotifications.filters || {}).query;
        const data = await apiFetch(`/api/internal-notifications?${this.internalNotificationParams(target)}`, { headers: searchHeaders(searchText) });
        if (!this.notificationCurrent(version)) return false;
        if (target === 'drawer') this.internalNotifications.drawerItems = data.items || [];
        else {
            this.internalNotifications.fullItems = data.items || [];
            this.internalNotifications.total = data.total || 0;
        }
        this.internalReady=this.internalReady||{};this.internalReady[target]=true;
        if(this.notificationCurrent(summaryTicket)){this.internalNotifications.summary=data.summary;this.internalSummaryReady=!!data.summary;}
        this.notificationReadFinished('internal');
        this.updateInternalNotificationsBadge();
        return data;
    },

    internalNotificationTone(type) {
        if (type === 'overdue') return 'danger';
        if (type === 'today' || type === 'data_quality' || type === 'consilium_revision') return 'warning';
        if (type === 'checklist') return 'info';
        return 'accent';
    },

    renderInternalNotificationTabs(containerId, active, onSelect, full) {
        const items = full ? this.INTERNAL_NOTIFICATION_TABS : this.INTERNAL_NOTIFICATION_TABS.slice(0, 4);
        $(containerId).replaceChildren(frag(items.map(tab => el('button', {
            type: 'button',
            class: `notification-tab${active === tab.value ? ' is-active' : ''}`,
            text: tab.label,
            'aria-pressed': active === tab.value ? 'true' : 'false',
            on: { click: () => onSelect(tab.value) },
        }))));
    },

    renderInternalNotificationCard(item, compact) {
        const unread = !item.read_at;
        const eventDate = item.event_at || item.first_seen_at;
        const planned = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}):00)?$/.exec(eventDate || '');
        const dateLabel = planned ? [`${planned[3]}.${planned[2]}.${planned[1]}`, planned[4]].filter(Boolean).join(' · ')
            : eventDate ? this.formatDateTime(eventDate) : 'Дата не указана';
        return el('article', { class: `internal-notification internal-notification--${unread ? 'unread' : 'read'}` }, [
            el('div', { class: 'internal-notification__main' }, [
                el('div', { class: 'internal-notification__head' }, [
                    el('span', {
                        class: `chip chip--${this.internalNotificationTone(item.type)}`,
                        text: this.INTERNAL_NOTIFICATION_TYPE_LABELS[item.type] || item.type,
                    }),
                    el('span', { class: unread ? 'internal-notification__unread' : 'internal-notification__read',
                        text: unread ? 'Новое' : 'Прочитано' }),
                ]),
                el('h3', { class: 'internal-notification__title', text: item.title || 'Уведомление' }),
                compact ? null : el('p', { class: 'internal-notification__text', text: item.description || '' }),
                el('div', { class: 'internal-notification__meta', text: [
                    item.patient_name || 'Пациент',
                    dateLabel,
                ].join(' · ') }),
            ]),
            el('div', { class: 'internal-notification__actions' }, [
                item.patient_id ? el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: 'Открыть', disabled:!!this.notificationMutation,
                    'data-internal-notification-open': '',
                    'data-internal-notification-return': !compact && this.internalNotificationReturnId === item.id ? '' : null,
                    on: { click: () => this.openInternalNotificationPatient(item) },
                }) : null,
                unread ? el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: 'Прочитано', disabled:!!this.notificationMutation,
                    on: { click: () => this.markInternalNotificationRead(item.id) },
                }) : null,
            ]),
        ]);
    },

    async openInternalNotificationsDrawer() {
        this.internalNotifications.lastFocusId = document.activeElement && document.activeElement.id ? document.activeElement.id : '';
        $('internalNotificationsScrim').classList.remove('is-hidden');
        $('internalNotificationsDrawer').classList.remove('is-hidden');
        $('internalNotificationsDrawer').setAttribute('aria-hidden', 'false');
        $('internalNotificationsBell').setAttribute('aria-expanded', 'true');
        $('internalNotificationsClose').focus();
        await this.renderInternalNotificationsDrawer();
    },

    closeInternalNotificationsDrawer({restoreFocus = true} = {}) {
        this.beginRead('internal-drawer');this.internalReady=this.internalReady||{};this.internalReady.drawer=false;this.internalNotifications.drawerItems=[];
        $('internalNotificationsDrawerList').replaceChildren();
        $('internalNotificationsScrim').classList.add('is-hidden');
        $('internalNotificationsDrawer').classList.add('is-hidden');
        $('internalNotificationsDrawer').setAttribute('aria-hidden', 'true');
        $('internalNotificationsBell').setAttribute('aria-expanded', 'false');
        const focusId = this.internalNotifications.lastFocusId || 'internalNotificationsBell';
        if (restoreFocus) $(focusId)?.focus();
    },

    async renderInternalNotificationsDrawer() {
        const version = this.notificationTicket('internal-drawer');this.internalReady=this.internalReady||{};this.internalReady.drawer=false;this.internalNotifications.drawerItems=[];this.notificationControls();
        const list = $('internalNotificationsDrawerList');
        const summary = this.internalNotifications.summary || {};
        $('internalNotificationsSubtitle').textContent = !this.internalSummaryReady?'Счетчик временно недоступен':summary.unread_count
            ? `${summary.unread_count} ${this.pluralize(summary.unread_count, 'новое', 'новых', 'новых')}`
            : 'Новых уведомлений нет';
        this.renderInternalNotificationTabs('internalNotificationsDrawerTabs', this.internalNotifications.drawerFilter, (value) => {
            this.internalNotifications.drawerFilter = value;
            this.renderInternalNotificationsDrawer();
        }, false);
        list.replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
        try {
            if (!await this.loadInternalNotifications('drawer', version)) return;
            const rows = this.internalNotifications.drawerItems || [];
            this.notificationControls();
            if (!rows.length) {
                list.replaceChildren(el('div', { class: 'empty', text: 'По выбранному фильтру уведомлений нет.' }));
                return;
            }
            list.replaceChildren(this.internalGroups(rows,true));
        } catch (e) {
            if (!this.notificationCurrent(version)) return;
            this.notificationFailure(version);
            list.replaceChildren(el('div', { class: 'empty', text: `Не удалось загрузить уведомления: ${e.message}` }));
        }
    },

    syncInternalNotificationControls() {
        $('internalNotificationsSearchInput').value = this.internalNotifications.filters.query;
        $('internalNotificationsTypeFilter').value = this.internalNotifications.filters.type;
        $('internalNotificationsUnreadFilter').value = this.internalNotifications.filters.unread;
    },

    renderInternalNotificationFiltersOptions() {
        const selectedType = this.internalNotifications.filters.type;
        $('internalNotificationsTypeFilter').replaceChildren(frag([
            option('', 'Все типы', !selectedType),
            ...Object.entries(this.INTERNAL_NOTIFICATION_TYPE_LABELS)
                .map(([value, label]) => option(value, label, value === selectedType)),
        ]));
        const selectedUnread = this.internalNotifications.filters.unread;
        $('internalNotificationsUnreadFilter').replaceChildren(frag([
            option('', 'Все статусы', !selectedUnread),
            option('unread', 'Только новые', selectedUnread === 'unread'),
        ]));
        this.syncInternalNotificationControls();
    },

    async renderInternalNotificationCenter() {
        $('internalNotificationsPageInfo').textContent='Загрузка…';$('internalNotificationsPrevBtn').disabled=true;$('internalNotificationsNextBtn').disabled=true;
        const version = this.notificationTicket('internal-full');this.internalReady=this.internalReady||{};this.internalReady.full=false;this.internalNotifications.fullItems=[];this.notificationControls();
        this.renderInternalNotificationFiltersOptions();
        this.renderInternalNotificationTabs('internalNotificationsFullTabs', this.internalNotifications.fullTab, (value) => {
            this.internalNotifications.fullTab = value;
            this.internalNotifications.filters.offset = 0;
            this.renderInternalNotificationCenter();
        }, true);
        const list = $('internalNotificationsFullList');
        list.replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
        try {
            if (!await this.loadInternalNotifications('full', version)) return;
            const rows = this.internalNotifications.fullItems || [];
            if (!rows.length) {
                list.replaceChildren(el('div', { class: 'empty', text: 'По выбранным условиям уведомлений нет.' }));
            } else {
                list.replaceChildren(this.internalGroups(rows,false));
            }
            const returnTarget = list.querySelector('[data-internal-notification-return]');
            this.internalNotificationReturnId = null;
            if (returnTarget && this.currentView === 'notifications' && !ui.topModal() &&
                document.activeElement === $('view-notifications').querySelector('h1')) {
                returnTarget.focus();
            }
            const { offset, limit } = this.internalNotifications.filters;
            const total = this.internalNotifications.total || 0;
            $('internalNotificationsPageInfo').textContent = total
                ? `${offset + 1}-${Math.min(offset + limit, total)} из ${total}`
                : '0 из 0';
            $('internalNotificationsPrevBtn').disabled = offset <= 0;
            $('internalNotificationsNextBtn').disabled = offset + limit >= total;
        } catch (e) {
            if (!this.notificationCurrent(version)) return;
            this.notificationFailure(version);
            list.replaceChildren(el('div', { class: 'empty', text: `Не удалось загрузить уведомления: ${e.message}` }));
            $('internalNotificationsPageInfo').textContent = '';
            $('internalNotificationsPrevBtn').disabled = true;
            $('internalNotificationsNextBtn').disabled = true;
        }
    },

    async refreshInternalNotificationLists() {
        if (!$('internalNotificationsDrawer').classList.contains('is-hidden')) await this.renderInternalNotificationsDrawer();
        if (this.currentView === 'notifications' && this.notifications.activeTab === 'inbox') await this.renderInternalNotificationCenter();
        await this.refreshInternalNotificationSummary();
    },
    async markInternalNotificationRead(id) {
        return this.notificationWrite('internal',()=>[...this.internalNotifications.drawerItems,...this.internalNotifications.fullItems].some(i=>i.id===id&&!i.read_at&&this.internalItemCurrent(i)),()=>apiPost(`/api/internal-notifications/${encodeURIComponent(id)}/read`,{}),()=>this.refreshInternalNotificationLists());
    },
    async markAllInternalNotificationsRead() {
        return this.notificationWrite('internal',()=>this.internalSummaryReady&&!!this.internalNotifications.summary?.unread_count&&this.internalReadReady(),()=>apiPost('/api/internal-notifications/read-all',{}),()=>this.refreshInternalNotificationLists());
    },

    openNotificationPatient(id, tab) {
        const ticket = this.notificationTicket('notification-navigation');
        return this.openPatient(id, tab || 'overview', {
            allowed: () => this.notificationCurrent(ticket),
        });
    },

    async openInternalNotificationPatient(item) {
        if (!this.internalItemCurrent(item) || this.notificationMutation || !item.patient_id) return false;
        const ticket = this.notificationTicket('notification-navigation');
        const current = () => this.notificationCurrent(ticket) && this.internalItemCurrent(item) && !this.notificationMutation;
        const refresh = message => {
            if (!current()) return;
            ui.toast(message, 'warning');
            void this.refreshInternalNotificationLists();
        };
        const drawer = !$('internalNotificationsDrawer').classList.contains('is-hidden');
        let opened;
        if (item.source_type === 'consilium_revision' && item.source_id) {
            try {
                const {appointments} = await apiGetJson('/api/consilium/appointments');
                if (!current()) return false;
                const revision = appointments.find(record => record.id === item.source_id &&
                    record.patientId === item.patient_id && record.status === 'needs_revision');
                if (!revision) {
                    refresh('Запись консилиума больше не ожидает доработки или недоступна.');
                    return false;
                }
                opened = await browserNavigation.navigate({screen: 'consilium'}, {
                    objectId: item.patient_id, allowed: current,
                    prepare: () => {
                        this.consilium.focusId = item.source_id;
                        this.consilium.search = '';
                        this.consilium.doctorDate = '';
                        this.consilium.groupFilters = [];
                        this.consilium.loaded = false;
                        $('consiliumSearchInput').value = '';
                        $('consiliumDoctorDate').value = '';
                        this.renderConsiliumGroupPicker('doctor');
                        return true;
                    },
                    denied: () => refresh('Карточка больше недоступна.'),
                    readFailed: () => refresh('Не удалось проверить действие.'),
                });
            } catch (error) {
                if (!error.obsolete) refresh('Не удалось проверить запись консилиума.');
                return false;
            }
        } else {
            const tab = item.source_type === 'checklist' ? 'checklist'
                : item.source_type === 'data_quality' ? 'data'
                : item.source_type === 'event' ? 'events' : 'overview';
            const action = item.source_type === 'event' && item.source_id
                ? {kind: 'day-event', eventId: item.source_id}
                : null;
            opened = await this.openPatient(item.patient_id, tab, {
                cardOrigin: 'notifications',
                allowed: current,
                historyAction: action,
                prepare: patient => {
                    if (!action) return true;
                    const occurrence = patient.history?.find(entry => entry.events?.some(event => event.id === action.eventId));
                    const event = occurrence?.events.find(event => event.id === action.eventId);
                    if (!event?.date || this.terminalStages.includes(patient.stage) ||
                        (item.event_at && item.event_at !== (event.time ? `${event.date}T${event.time}:00` : event.date))) {
                        refresh('Плановое событие изменилось или больше недоступно.');
                        return false;
                    }
                    Object.assign(action, {occurrenceId: occurrence.id, stage: occurrence.stage,
                        date: event.date, time: event.time || ''});
                    const reason = f1Doctor.replayAction(this, patient, action, true);
                    if (reason) refresh(reason);
                    return !reason;
                },
                focus: action ? () => f1Doctor.focusAction(action) : undefined,
                denied: () => refresh('Карточка больше недоступна.'),
                readFailed: () => refresh('Не удалось проверить действие.'),
            });
        }
        if (opened && this.notificationCurrent(ticket)) {
            if (drawer) this.closeInternalNotificationsDrawer({restoreFocus: false});
            this.internalNotificationReturnId = item.id;
        }
        return Boolean(opened);
    },

    /* ============================================================ РЕНДЕР: УВЕДОМЛЕНИЯ */

    notificationFilterCount() {
        const f = this.notifications.filters;
        return [f.status, f.template, f.dateFrom, f.dateTo, f.doctor, f.department].filter(Boolean).length;
    },

    updateNotificationsFiltersButton() {
        const label = $('notificationsFiltersBtnLabel');
        if (!label) return;
        const count = this.notificationFilterCount();
        label.textContent = count ? `Фильтры · ${count}` : 'Фильтры';
        $('openNotificationsFiltersSheetBtn').setAttribute('aria-label', count
            ? `Фильтры уведомлений, активных фильтров: ${count}`
            : 'Фильтры уведомлений');
    },

    openNotificationsFiltersSheet() {
        $('notificationsFiltersSheetBody').append($('notificationsToolbarFilters'));
        $('openNotificationsFiltersSheetBtn').setAttribute('aria-expanded', 'true');
        ui.openModal('notificationsFiltersSheet');
    },

    closeNotificationsFiltersSheet() {
        ui.closeModal('notificationsFiltersSheet');
        $('openNotificationsFiltersSheetBtn').setAttribute('aria-expanded', 'false');
        const toolbar = document.querySelector('#notificationsOutboundPanel .toolbar');
        toolbar.append($('notificationsToolbarFilters'));
    },

    resetNotificationsFilters() {
        this.notifications.offset=0;
        this.notifications.filters = {
            query: '',
            status: '',
            template: '',
            dateFrom: '',
            dateTo: '',
            doctor: '',
            department: '',
            sort: 'scheduled_asc',
        };
        $('notificationsSearchInput').value = '';
        this.syncNotificationsFilterControls();
        this.renderNotificationsPage();
    },

    syncNotificationsFilterControls() {
        const f = this.notifications.filters;
        $('notificationsStatusFilter').value = f.status;
        $('notificationsTemplateFilter').value = f.template;
        $('notificationsDateFromFilter').value = f.dateFrom;
        $('notificationsDateToFilter').value = f.dateTo;
        $('notificationsDoctorFilter').value = f.doctor;
        $('notificationsDepartmentFilter').value = f.department;
        $('notificationsSortSelect').value = f.sort;
    },

    notificationParams(extra = {}) {
        const f = Object.assign({}, this.notifications.filters, extra);
        const params = new URLSearchParams();
        if (f.status) params.set('status', f.status);
        if (f.template) params.set('template_code', f.template);
        if (f.dateFrom) params.set('date_from', f.dateFrom);
        if (f.dateTo) params.set('date_to', f.dateTo);
        if (f.doctor) params.set('treating_doctor', f.doctor);
        if (f.department) params.set('department', f.department);
        params.set('sort', f.sort || 'scheduled_asc');
        params.set('limit', String(this.notifications.limit));
        params.set('offset', String(this.notifications.offset));
        return params.toString();
    },

    async loadNotifications(version) {
        const query = this.notificationParams();
        const search = this.notifications.filters.query;
        const summary = await apiGetJson('/api/notifications/summary');
        const templates = await apiGetJson('/api/notifications/templates');
        const list = await apiFetch(`/api/notifications?${query}`, { headers: searchHeaders(search) });
        if (!this.notificationCurrent(version)) return false;
        this.notifications.summary = summary;
        this.notifications.templates = templates.templates || [];
        this.notifications.placeholders = templates.placeholders || [];
        this.notifications.items = list.notifications || [];
        this.notifications.total = list.total || 0;this.notifications.ready=true;this.notificationReadFinished('outbound');
        return true;
    },

    renderNotificationsPageTabs() {
        const active = this.notifications.activeTab || 'inbox';
        document.querySelectorAll('[data-notifications-tab]').forEach(button => {
            const selected = button.dataset.notificationsTab === active;
            button.classList.toggle('is-active', selected);
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.tabIndex = 0;
        });
        $('notificationsOutboundPanel').hidden = active !== 'outbound';
        $('notificationsInboxPanel').hidden = active !== 'inbox';
        $('notificationsGenerateBtn').classList.toggle('is-hidden', active !== 'outbound' || !this.can('runNotificationWorker'));
        $('notificationsProcessBtn').classList.toggle('is-hidden', active !== 'outbound' || !this.can('runNotificationWorker'));
        $('notificationsMockBanner').classList.toggle('is-hidden', active !== 'outbound');
    },

    async renderNotificationsPage() {
        this.renderNotificationsPageTabs();
        if (this.notifications.activeTab === 'outbound') {
            await this.renderNotifications();
        } else {
            await this.renderInternalNotificationCenter();
        }
        this.renderNotificationsPageTabs();
    },

    async renderNotifications() {
        const version = this.notificationTicket('notifications');this.notifications.ready=false;this.notifications.items=[];this.notificationControls();
        $('notificationsStatsRow').replaceChildren();
        this.updateNotificationsFiltersButton();
        $('notificationsPageInfo').textContent='Загрузка…';$('notificationsPrevBtn').disabled=true;$('notificationsNextBtn').disabled=true;
        const body = $('notificationsBody');
        const empty = $('notificationsEmpty');
        body.replaceChildren();
        empty.classList.remove('is-hidden');
        empty.textContent = 'Загрузка…';
        $('notificationsGenerateBtn').classList.toggle('is-hidden', !this.can('runNotificationWorker'));
        $('notificationsProcessBtn').classList.toggle('is-hidden', !this.can('runNotificationWorker'));
        try {
            if (!await this.loadNotifications(version)) return;
            $('notificationsMockBanner').classList.toggle('is-hidden', this.notifications.summary.provider !== 'mock');
            this.renderNotificationsFiltersOptions();
            this.renderNotificationsStats();
            this.renderNotificationsRows();
            this.renderNotificationTemplatesPanel();this.notificationControls();
            const {offset,limit}=this.notifications,total=this.notifications.total||0;
            $('notificationsPageInfo').textContent=total?`${offset+1}–${Math.min(offset+limit,total)} из ${total}`:'0 из 0';
            $('notificationsPrevBtn').disabled=offset<=0;$('notificationsNextBtn').disabled=offset+limit>=total;
        } catch (e) {
            if (!this.notificationCurrent(version)) return;
            this.notificationFailure(version);
            $('notificationsStatsRow').replaceChildren();
            if(this.can('manageNotificationTemplates'))$('notificationTemplatesPanel').classList.remove('is-hidden');
            empty.classList.remove('is-hidden');
            empty.textContent = `Не удалось загрузить уведомления: ${e.message}`;
        }
    },

    renderNotificationsFiltersOptions() {
        const selectedTemplate = this.notifications.filters.template;
        const selectedDoctor = this.notifications.filters.doctor;
        const selectedDept = this.notifications.filters.department;
        const doctors = [...new Set([...this.doctors.map(d=>d.fullName),selectedDoctor,...this.notifications.items.map(n=>n.treating_doctor_name)].filter(Boolean))].sort();
        const departments = [...new Set([...this.departments.map(d=>d.name),this.notifications.filters.department,...this.notifications.items.flatMap(n=>n.department_names||[])].filter(Boolean))].sort();
        $('notificationsTemplateFilter').replaceChildren(frag([
            option('', 'Любой шаблон', !selectedTemplate),
            ...this.notifications.templates.map(t => option(t.code, t.name, t.code === selectedTemplate)),
        ]));
        $('notificationsDoctorFilter').replaceChildren(frag([
            option('', 'Любой лечащий врач', !selectedDoctor),
            ...doctors.map(name => option(name, name, name === selectedDoctor)),
        ]));
        $('notificationsDepartmentFilter').replaceChildren(frag([
            option('', 'Любое отделение', !selectedDept),
            ...departments.map(name => option(name, name, name === selectedDept)),
        ]));
        this.syncNotificationsFilterControls();
    },

    renderNotificationsStats() {
        const s = this.notifications.summary || {};
        const stat = (label, value, meta) => el('div', { class: 'stat' }, [
            el('div', { class: 'stat__label', text: label }),
            el('div', { class: 'stat__value', text: String(value ?? 0) }),
            el('div', { class: 'stat__meta', text: meta }),
        ]);
        $('notificationsStatsRow').replaceChildren(frag([
            stat('Ожидают отправки', s.pending_count, 'сообщения'),
            stat('Отправлены', s.sent_count, 'тестовый режим'),
            stat('Ошибки', s.failed_count, 'требуют проверки'),
            stat('Отменены', s.cancelled_count, 'не будут отправлены'),
            stat('Без согласия', s.patients_without_consent, 'пациенты в области доступа'),
            stat('Некорректный телефон', s.patients_with_invalid_phone, 'проверить контакт'),
        ]));
    },

    notificationStatusChip(status) {
        const label = this.NOTIFICATION_STATUS_LABELS[status] || status;
        const tone = status === 'sent' ? 'good'
            : status === 'failed' ? 'danger'
            : status === 'cancelled' ? 'neutral'
            : status === 'skipped' ? 'warning'
            : status === 'processing' ? 'info' : 'accent';
        return el('span', { class: `chip chip--${tone}`, text: label });
    },

    notificationReasonText(item) {
        const code = item.error_code || item.error_message_safe || '';
        return this.NOTIFICATION_REASON_LABELS[code] || code || '—';
    },

    renderNotificationsRows() {
        const body = $('notificationsBody');
        const empty = $('notificationsEmpty');
        const rows = this.notifications.items || [];
        if (!rows.length) {
            body.replaceChildren();
            empty.classList.remove('is-hidden');
            empty.textContent = this.notifications.total === 0
                ? 'Ожидающих сообщений нет.'
                : 'По выбранным условиям уведомления не найдены.';
            return;
        }
        empty.classList.add('is-hidden');
        body.replaceChildren(frag(rows.map(item => el('tr', {}, [
            el('td', {}, el('div', { class: 'person' }, [
                el('span', { class: 'avatar avatar--normal', text: this.initials(item.patient_name) }),
                el('div', {}, [
                    el('div', { class: 'person__name', text: item.patient_name }),
                    el('div', { class: 'person__meta', text: item.phone_masked || 'Телефон не показан' }),
                ]),
            ])),
            el('td', { class: 'cell-notification-template', text: item.template_name || item.template_code }),
            el('td', { class: 'cell-notification-source', text: this.NOTIFICATION_SOURCE_LABELS[item.source_type] || item.source_type }),
            el('td', { class: 'cell-notification-scheduled', text: this.formatNotificationMoment(item.scheduled_at) }),
            el('td', { class: 'cell-notification-status' }, this.notificationStatusChip(item.status)),
            el('td', { class: 'cell-notification-attempts', text: `${item.attempt_count || 0}/${item.max_attempts || 0}` }),
            el('td', { class: 'cell-notification-reason', text: this.notificationReasonText(item) }),
            el('td', { class: 'cell-actions' }, [
                el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Открыть пациента',
                    on: { click: () => {if(this.notifications.ready&&!this.notificationMutation)this.openNotificationPatient(item.patient_id, 'notifications');} },
                }),
                item.status === 'pending' && this.can('manageNotifications') ? el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Отменить',
                    on: { click: () => this.cancelNotification(item.id) },
                }) : null,
                item.status === 'failed' && this.can('runNotificationWorker') ? el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Повторить',
                    on: { click: () => this.retryNotification(item.id) },
                }) : null,
            ]),
        ]))));
    },

    renderNotificationTemplatesPanel() {
        const resumed=this.notificationReauthDraft;
        const draft=this.notificationInputSnapshot('outbound');
        const retained=draft.length?draft:resumed?.owner===this.user?.id&&resumed.epoch===(this.sessionEpoch||0)?resumed.outbound:[];
        const panel = $('notificationTemplatesPanel');
        if (!this.can('manageNotificationTemplates')) {
            panel.classList.add('is-hidden');
            panel.replaceChildren();
            return;
        }
        panel.classList.remove('is-hidden');
        const placeholders = (this.notifications.placeholders || []).map(p => `{${p}}`).join(', ');
        panel.replaceChildren(frag([
            el('h2', { class: 'panel__title', text: 'Системные шаблоны' }),
            el('p', { class: 'panel__text', text: `Разрешённые переменные: ${placeholders}. Свободный текст напоминаний в MVP недоступен.` }),
            ...this.notifications.templates.map(t => el('div', { class: 'notification-template' }, [
                el('div', {}, [
                    el('div', { class: 'person__name', text: t.name }),
                    el('div', { class: 'person__meta', text: `${t.code} · версия ${t.version}` }),
                ]),
                el('label', { class: 'check' }, [
                    el('input', { type: 'checkbox', id: `template-enabled-${t.code}`, checked: !!t.enabled }),
                    el('span', { text: 'Включён' }),
                ]),
                el('div', { class: 'notification-template__body field' }, [
                    el('label', { class: 'field__label', for: `template-body-${t.code}`, text: 'Текст шаблона' }),
                    el('textarea', { class: 'textarea', id: `template-body-${t.code}`, rows: 3, text: t.body }),
                ]),
                el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Сохранить шаблон',
                    on: { click: () => this.saveNotificationTemplate(t.code) },
                }),
            ])),
        ]));
        this.stampNotificationInputs('outbound');this.restoreNotificationInputs('outbound',retained);this.renderNotificationTemplateDraftStates();if(resumed)resumed.outbound=[];
    },

    /* =============================================================== РЕНДЕР: АНАЛИТИКА */

    analyticsParams(extra = {}) {
        const f = Object.assign({}, this.analytics.filters, extra);
        const params = new URLSearchParams();
        if (f.dateFrom) params.set('date_from', f.dateFrom);
        if (f.dateTo) params.set('date_to', f.dateTo);
        if (f.stage) params.set('stage', f.stage);
        if (f.nosology) params.set('nosology', f.nosology);
        if (f.doctor) params.set('doctor_user_id', f.doctor);
        if (f.department) params.set('department_id', f.department);
        if (f.attentionReason) params.set('attention_reason', f.attentionReason);
        if (f.code) params.set('code', f.code);
        params.set('limit', '50');
        params.set('offset', String(f.offset || 0));
        return params.toString();
    },

    openWorkingAnalytics(source, {type, title, stage = ''}, allowed) {
        return browserNavigation.navigate({screen: 'analytics', analytics: {
            source,
            filters: {dateFrom: '', dateTo: '', stage, nosology: '', doctor: '', department: '', attentionReason: ''},
            detail: {type, title, extra: {}, offset: 0},
        }}, {allowed});
    },

    analyticsReturnContext(patientId, focusIndex) {
        const state = this.analytics.details;
        return {
            source: this.analytics.source,
            filters: {...this.analytics.filters},
            detail: state && {type: state.type, title: state.title, extra: {...state.extra}, offset: state.offset,
                focusPatient: patientId, focusIndex: focusIndex ?? state.items.indexOf(state.openedItem)},
        };
    },

    restoreAnalyticsContext(context) {
        this.analytics.source = context?.source || null;
        this.analytics.pendingDetails = context?.detail || null;
        if (!context) return;
        this.analytics.filters = {...context.filters};
        $('analyticsDateFrom').value = context.filters.dateFrom;
        $('analyticsDateTo').value = context.filters.dateTo;
        $('analyticsStageFilter').value = context.filters.stage;
    },

    clearAnalyticsRelease() {
        const state = this.analytics;
        for (const key of ['dashboard', 'summary', 'stages', 'workload', 'dataQuality', 'details']) state[key] = null;
        state.detailsToken += 1;
        this.analyticsReadState = 'idle';
        this.beginRead('analytics-dashboard');
        for (const id of ['analyticsStatsRow', 'analyticsStageChart', 'analyticsQualityList', 'analyticsWorkloadList',
            'analyticsProfileChart', 'analyticsRouteStateChart', 'analyticsTrendChart', 'analyticsAttentionList',
            'analyticsOperationsList', 'analyticsDetailsPanel', 'analyticsContext', 'analyticsScope']) $(id).replaceChildren();
        for (const id of ['analyticsDoctorFilter', 'analyticsDepartmentFilter']) $(id).replaceChildren();
        this.updateAnalyticsExportControls();
    },

    renderAnalyticsContext(meta) {
        const context = $('analyticsContext');
        const back = $('backToAnalyticsSource');
        const source = this.analytics.source;
        const label = {pulse: 'Пульс клиники', myDay: 'Мой день'}[source];
        back.hidden = !label || !this.navigationVisibility()[source];
        back.textContent = source === 'pulse' ? 'К пульсу клиники' : 'К моему дню';
        context.hidden = back.hidden;
        context.textContent = back.hidden ? '' : 'Из раздела «' + label + '».';
        const scope = $('analyticsScope');
        scope.hidden = !meta;
        if (!meta) { scope.textContent = ''; return; }
        const scopeLabel = {by_treating_doctor: 'пациенты лечащего врача', by_department: 'разрешенные отделения',
            global: 'все разрешенные пациенты', global_readonly: 'все разрешенные пациенты, чтение'}[meta.scope] ||
            'разрешенная область доступа';
        const {date_from: from, date_to: to} = meta.filters || {};
        const selected = [from && 'с ' + from, to && 'по ' + to].filter(Boolean).join(' ');
        const trend = this.analytics.dashboard.trend;
        const actual = trend?.rows?.length ? trend.rows[0].date + ' — ' + trend.rows.at(-1).date : '';
        const computed = new Date(meta.computed_at).toLocaleString('ru-RU', {timeZone: meta.timezone});
        scope.textContent = 'Серверная аналитика. Область: ' + scopeLabel + '. Рассчитано: ' + computed +
            ' (' + meta.timezone + '). Период: ' + (selected || 'по умолчанию') +
            (actual ? '. График: ' + actual : '') + '.';
    },

    analyticsDateString(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    },

    setAnalyticsPeriodPreset(days) {
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - Number(days) + 1);
        this.analytics.filters.dateFrom = this.analyticsDateString(start);
        this.analytics.filters.dateTo = this.analyticsDateString(end);
        $('analyticsDateFrom').value = this.analytics.filters.dateFrom;
        $('analyticsDateTo').value = this.analytics.filters.dateTo;
        this.updateAnalyticsPeriodPresetState();
        this.renderAnalytics();
    },

    updateAnalyticsPeriodPresetState() {
        const from = this.analytics.filters.dateFrom;
        const to = this.analytics.filters.dateTo;
        document.querySelectorAll('[data-analytics-period]').forEach(button => {
            const days = Number(button.dataset.analyticsPeriod);
            const end = new Date();
            const start = new Date();
            start.setDate(end.getDate() - days + 1);
            const active = from === this.analyticsDateString(start) && to === this.analyticsDateString(end);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    },

    async loadAnalytics(params, ticket) {
        const dashboard=await apiGetJson(`/api/analytics/dashboard?${params}`);
        if(this.currentView !== 'analytics' || !this.managementReadCurrent(ticket,this.analyticsParams().toString()))return false;
        Object.assign(this.analytics,{dashboard,summary:dashboard.summary,stages:dashboard.stages,workload:dashboard.workload,dataQuality:dashboard.data_quality});
        return true;
    },

    async renderAnalytics() {
        if (this.can('consiliumChair')) {
            await this.renderChairAnalytics();
            return;
        }
        const params=this.analyticsParams().toString(),ticket=this.managementReadTicket('analytics-dashboard',params);
        this.analyticsDashboardTicket=ticket;this.analyticsReadState='loading';
        const current=()=>this.currentView === 'analytics' && this.managementReadCurrent(ticket,this.analyticsParams().toString());
        const pending = this.analytics.pendingDetails;
        this.analytics.pendingDetails = null;
        this.renderAnalyticsContext(null);
        this.updateAnalyticsExportControls();
        document.querySelector('.analytics-dashboard').setAttribute('aria-busy','true');
        $('analyticsSubtitle').textContent = 'Организационные показатели маршрутов, просрочек и заполненности данных';
        $('chairAnalyticsDashboard').classList.add('is-hidden');
        document.querySelector('.analytics-dashboard').classList.remove('is-hidden');
        document.querySelector('.analytics-note').classList.remove('is-hidden');
        document.querySelector('.analytics-controls__filters').classList.remove('is-hidden');
        $('analyticsStatsRow').replaceChildren();
        $('analyticsStageChart').replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
        $('analyticsQualityList').replaceChildren();
        $('analyticsWorkloadList').replaceChildren();
        $('analyticsProfileChart').replaceChildren();
        $('analyticsRouteStateChart').replaceChildren();
        $('analyticsTrendChart').replaceChildren();
        $('analyticsAttentionList').replaceChildren();
        $('analyticsOperationsList').replaceChildren();
        // Пересчёт закрывает детализацию; запоздавшие ответы её страниц игнорируются.
        this.analytics.details = null;
        this.analytics.detailsToken += 1;
        $('analyticsDetailsPanel').replaceChildren();
        try {
            if(!await this.loadAnalytics(params,ticket)||!current())return;
            this.renderAnalyticsContext(this.analytics.dashboard.meta);
            this.renderAnalyticsFilterOptions();
            this.updateAnalyticsPeriodPresetState();
            this.renderAnalyticsSummary();
            this.renderAnalyticsTrend();
            this.renderAnalyticsStages();
            this.renderAnalyticsVisualBars('analyticsProfileChart', this.analytics.dashboard.profiles.rows || [], {
                labelKey: 'label',
                label: row => this.nosologyData[row.meta && row.meta.nosology] ? this.nosologyData[row.meta.nosology].label : row.label,
                empty: 'Доступных пациентов с профилем клиентского пути нет.',
                onClick: row => row.meta && row.meta.nosology ? this.renderAnalyticsDetails('patients', this.nosologyData[row.meta.nosology]?.label || row.label, { nosology: row.meta.nosology }) : null,
            });
            this.renderAnalyticsAttention();
            this.renderAnalyticsWorkload();
            this.renderAnalyticsQualityVisual();
            this.renderAnalyticsVisualBars('analyticsRouteStateChart', this.analytics.dashboard.route_state.rows || [], {
                labelKey: 'label',
                meta: row => row.meta && row.meta.overlap ? 'Может пересекаться с другими состояниями' : 'Текущее состояние',
                onClick: row => row.detail_type ? this.renderAnalyticsDetails(row.detail_type, row.label, row.filter || {}) : null,
            });
            this.renderAnalyticsOperations();
            this.analyticsReadState='ready';
            this.updateAnalyticsExportControls();
        } catch (e) {
            if(!current())return;this.analyticsReadState='error';
            $('analyticsStageChart').replaceChildren(el('div', { class: 'empty', text: 'Не удалось загрузить аналитику. Попробуйте обновить данные.' }));
        } finally {if(current())document.querySelector('.analytics-dashboard').setAttribute('aria-busy','false');}
        if (pending && current() && this.analyticsReadState === 'ready') {
            await this.renderAnalyticsDetails(pending.type, pending.title, pending.extra, pending);
        }
    },

    chairAnalyticsRequestParams() {
        const params=new URLSearchParams();
        if(this.analytics.filters.dateFrom)params.set('date_from',this.analytics.filters.dateFrom);
        if(this.analytics.filters.dateTo)params.set('date_to',this.analytics.filters.dateTo);
        return params.toString();
    },
    setChairAnalyticsReadState(state) {
        this.chairAnalyticsReadState=state;
        $('chairAnalyticsDashboard').setAttribute('aria-busy',String(state==='loading'));
        if(state==='ready')return;
        for(const id of ['chairAnalyticsStats','chairTreatmentAnalytics','chairSchemeAnalytics','chairScheduleAnalytics'])$(id).replaceChildren();
        $('chairAnalyticsStats').append(el('div',{class:'empty',role:state==='error'?'alert':'status',text:state==='loading'?'Загрузка аналитики консилиума…':'Не удалось загрузить аналитику консилиума. Актуальные показатели недоступны; обновите данные.'}));
    },
    async renderChairAnalytics() {
        if(!this.user||this.sessionExpired||this.sessionReconciling||!this.can('consiliumChair')){this.setChairAnalyticsReadState('error');return;}
        const params=this.chairAnalyticsRequestParams(),ticket=this.managementReadTicket('chair-analytics',params);this.chairAnalyticsReadTicket=ticket;
        const current=()=>this.can('consiliumChair')&&this.managementReadCurrent(ticket,this.chairAnalyticsRequestParams());
        this.analytics.source = null;
        this.analytics.pendingDetails = null;
        this.renderAnalyticsContext(null);
        this.setChairAnalyticsReadState('loading');
        $('analyticsSubtitle').textContent = 'Назначения консилиума и фактическая загрузка расписания';
        document.querySelector('.analytics-dashboard').classList.add('is-hidden');
        document.querySelector('.analytics-note').classList.add('is-hidden');
        document.querySelector('.analytics-controls__filters').classList.add('is-hidden');
        this.updateAnalyticsExportControls();
        $('chairAnalyticsDashboard').classList.remove('is-hidden');
        try {
            const data=await apiGetJson(`/api/consilium/analytics${params?'?'+params:''}`);if(!current())return;
            const stat = (label, value, meta) => el('div', { class: 'stat' }, [
                el('div', { class: 'stat__label', text: label }),
                el('div', { class: 'stat__value', text: String(value) }),
                el('div', { class: 'stat__meta', text: meta }),
            ]);
            $('chairAnalyticsStats').replaceChildren(frag([
                stat('Всего записей', data.summary.total, 'за выбранный период'),
                stat('Подписано', data.summary.signed, 'решение утверждено'),
                stat('Ожидают решения', data.summary.awaiting, `${data.summary.inReview} на рассмотрении`),
                stat('Возвращено', data.summary.returned, 'ожидают доработки врача'),
            ]));
            this.renderAnalyticsVisualBars('chairTreatmentAnalytics', data.treatments || [], {
                labelKey: 'label',
                empty: 'Подписанных назначений за период пока нет.',
                meta: row => row.count ? 'подписанных решений' : 'назначений нет',
            });
            this.renderAnalyticsVisualBars('chairSchemeAnalytics', data.schemes || [], {
                labelKey: 'label',
                label: row => `${row.code ? row.code + ' — ' : ''}${row.label}`,
                empty: 'Подписанных химиотерапевтических схем за период пока нет.',
                meta: row => `${row.count} назначений`,
            });
            const schedule = data.schedule || {};
            // WP2.3-B2: загрузка — по фактическим слотам председателя; без
            // расписания — «Нет расписания», а не 0%.
            if (schedule.state === 'no_schedule') {
                $('chairScheduleAnalytics').replaceChildren(el('div', { class: 'consilium-load-card' }, [
                    el('div', { class: 'consilium-load-card__value', text: 'Нет расписания' }),
                    el('div', { class: 'muted', text: 'За выбранный период председатель не создал слоты.' }),
                    schedule.outsideSchedule
                        ? el('div', { class: 'consilium-load-card__meta', text: `Записей вне расписания: ${schedule.outsideSchedule}` })
                        : null,
                ]));
                this.setChairAnalyticsReadState('ready');return;
            }
            $('chairScheduleAnalytics').replaceChildren(el('div', { class: 'consilium-load-card' }, [
                el('div', { class: 'consilium-load-card__value', text: `${schedule.loadPercent || 0}%` }),
                el('div', { class: 'muted', text: 'занятости слотов председателя за период' }),
                el('progress', { max: 100, value: schedule.loadPercent || 0, 'aria-label': `Загрузка расписания ${schedule.loadPercent || 0}%` }),
                el('div', { class: 'consilium-load-card__meta', text: `${schedule.occupied || 0} занятых слотов из ${schedule.slots || 0} · дней с расписанием: ${schedule.activeDays || 0}` }),
                schedule.outsideSchedule
                    ? el('div', { class: 'consilium-load-card__meta', text: `Записей вне расписания (в загрузку не входят): ${schedule.outsideSchedule}` })
                    : null,
                el('div', { class: 'consilium-load-card__extra', text: `Дополнительно: специалистов требуют ${data.summary.needsSpecialists || 0} записей.` }),
            ]));
            this.setChairAnalyticsReadState('ready');
        } catch (error) {
            if(current())this.setChairAnalyticsReadState('error');
        }
    },

    renderAnalyticsFilterOptions() {
        const selectedDoctor = this.analytics.filters.doctor;
        const selectedDepartment = this.analytics.filters.department;
        const selectedNosology = this.analytics.filters.nosology;
        const workloadRows = (this.analytics.workload && this.analytics.workload.rows) || [];
        const doctors = workloadRows
            .filter(row => row.doctor_user_id)
            .map(row => ({ id: row.doctor_user_id, name: row.doctor_name }))
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        const departments = [];
        const seenDepartments = new Set();
        workloadRows.forEach(row => {
            (row.department_ids || []).forEach((id, index) => {
                if (!id || seenDepartments.has(id)) return;
                seenDepartments.add(id);
                departments.push({ id, name: (row.department_names || [])[index] || id });
            });
        });
        departments.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        $('analyticsDoctorFilter').replaceChildren(frag([
            option('', 'Любой лечащий врач', !selectedDoctor),
            ...doctors.map(d => option(d.id, d.name, d.id === selectedDoctor)),
        ]));
        $('analyticsDepartmentFilter').replaceChildren(frag([
            option('', 'Любое отделение', !selectedDepartment),
            ...departments.map(d => option(d.id, d.name, d.id === selectedDepartment)),
        ]));
        $('analyticsNosologyFilter').replaceChildren(frag([
            option('', 'Любая локализация', !selectedNosology),
            ...this.analyticsLocalizationOptions().map(item => option(item.value, item.label, item.value === selectedNosology)),
        ]));
        $('analyticsAttentionReasonFilter').replaceChildren(frag([
            option('', 'Любая причина внимания', !this.analytics.filters.attentionReason),
            ...Object.entries(this.ATTENTION_REASON_LABELS).map(([code, label]) => option(code, label, code === this.analytics.filters.attentionReason)),
        ]));
    },

    analyticsLocalizationOptions() {
        const seenLabels = new Set();
        return Object.entries(this.nosologyData).reduce((items, [value, data]) => {
            const label = data.label || value;
            if (seenLabels.has(label)) return items;
            seenLabels.add(label);
            items.push({ value, label });
            return items;
        }, []);
    },

    resetAnalyticsFilters() {
        this.analytics.filters = { dateFrom: '', dateTo: '', stage: '', nosology: '', doctor: '', department: '', attentionReason: '' };
        $('analyticsDateFrom').value = '';
        $('analyticsDateTo').value = '';
        $('analyticsStageFilter').value = '';
        $('analyticsNosologyFilter').value = '';
        $('analyticsDoctorFilter').value = '';
        $('analyticsDepartmentFilter').value = '';
        $('analyticsAttentionReasonFilter').value = '';
        this.updateAnalyticsPeriodPresetState();
        this.renderAnalytics();
    },

    renderAnalyticsSummary() {
        const cards = (this.analytics.summary && this.analytics.summary.cards) || [];
        const visibleCodes = new Set([
            'total_patients',
            'active_patients',
            'patients_need_attention',
            'patients_with_overdue',
            'data_quality_issues',
        ]);
        const nodes = cards.filter(card => visibleCodes.has(card.code)).map(card => el('button', {
            type: 'button',
            class: `stat stat--button ${this.analyticsCardToneClass(card.code)}`,
            'aria-describedby': 'analytics-definition-' + card.code,
            on: {click: () => {
                if (card.detail_type) this.renderAnalyticsDetails(card.detail_type, ({
                    active_patients: 'Пациенты в выбранной области',
                    patients_with_overdue: 'Просроченные события',
                })[card.code] || card.label);
            }},
        }, [
            el('div', { class: 'stat__label', text: card.label }),
            el('div', { class: 'stat__value', text: String(card.value ?? 0) }),
            el('div', { class: 'stat__meta', text: card.code === 'active_patients' ? 'детализация: весь доступный набор' :
                card.code === 'patients_with_overdue' ? 'детализация: события' :
                card.kind === 'period' ? 'за период' : 'текущее состояние' }),
            el('span', {id: 'analytics-definition-' + card.code, class: 'visually-hidden', text: card.definition}),
        ]));
        const qualitySummary = this.analytics.dataQuality && this.analytics.dataQuality.summary;
        if (qualitySummary) {
            // Пустая выборка — нет данных, а не 100 % заполненности.
            const hasPatients = qualitySummary.average_completeness != null;
            nodes.push(el('div', {
                class: `stat stat--quality ${!hasPatients ? '' : qualitySummary.total_issues ? 'stat--danger' : 'stat--good'}`,
            }, [
                el('div', { class: 'stat__label', text: 'Заполненность обязательных полей' }),
                el('div', { class: 'stat__value', text: hasPatients ? `${qualitySummary.average_completeness}%` : '—' }),
                el('div', { class: 'stat__meta', text: hasPatients ? `${qualitySummary.total_issues} проблем отдельно` : 'нет пациентов в выборке' }),
                // Проблемы — отдельный список всех уровней; процент заполненности на него не влияет.
                hasPatients ? el('div', { class: 'stat__meta' }, el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: 'Посмотреть проблемы',
                    on: { click: () => this.renderAnalyticsDetails('quality_all', 'Все проблемы качества данных') },
                })) : null,
            ]));
        }
        $('analyticsStatsRow').replaceChildren(frag(nodes));
    },

    analyticsCardToneClass(code) {
        if (code === 'patients_with_overdue' || code === 'data_quality_issues') return 'stat--danger';
        if (code === 'patients_need_attention') return 'stat--warning';
        if (code === 'active_patients') return 'stat--info';
        if (code === 'completed_patients') return 'stat--good';
        return '';
    },

    renderAnalyticsBarChart(targetId, rows, config) {
        const labelKey = config.labelKey || 'label';
        if (!rows.length) {
            $(targetId).replaceChildren(el('div', { class: 'empty', text: config.empty || 'Данных по выбранным условиям нет.' }));
            return;
        }
        const max = Math.max(1, ...rows.map(row => Number(row.count || 0)));
        $(targetId).replaceChildren(frag(rows.map(row => el('button', {
            type: 'button',
            class: 'bar-row',
            on: { click: () => config.onClick ? config.onClick(row) : null },
        }, [
            el('span', { class: 'bar-row__label', text: config.label ? config.label(row) : row[labelKey] }),
            el('progress', { class: 'bar-row__bar', max, value: row.count || 0, 'aria-label': `${row[labelKey]}: ${row.count || 0}` }),
            el('span', { class: 'bar-row__value', text: config.valueText ? config.valueText(row) : `${row.count} · ${row.percent}%` }),
            el('span', { class: 'bar-row__meta', text: config.meta ? config.meta(row) : '' }),
        ]))));
    },

    renderAnalyticsVisualBars(targetId, rows, config = {}) {
        const labelKey = config.labelKey || 'label';
        if (!rows.length) {
            $(targetId).replaceChildren(el('div', { class: 'empty', text: config.empty || 'Данных по выбранным условиям нет.' }));
            return;
        }
        const max = Math.max(1, ...rows.map(row => Number(row.count || 0)));
        $(targetId).replaceChildren(frag(rows.slice(0, config.limit || 8).map((row, index) => {
            const label = config.label ? config.label(row) : row[labelKey];
            const count = Number(row.count || 0);
            const meta = config.meta ? config.meta(row) : `${count} · ${row.percent || 0}%`;
            return el('button', {
                type: 'button',
                class: `analytics-bar analytics-bar--${(index % 5) + 1} ${config.tone ? 'analytics-bar--' + config.tone(row) : ''}`,
                title: `${label}: ${meta}`,
                'aria-label': `${label}: ${meta}`,
                on: { click: () => config.onClick ? config.onClick(row) : null },
            }, [
                el('span', { class: 'analytics-bar__top' }, [
                    el('span', { class: 'analytics-bar__label', text: label }),
                    el('strong', { class: 'analytics-bar__value', text: String(count) }),
                ]),
                el('progress', { class: 'analytics-bar__progress', max, value: count, 'aria-label': `${label}: ${count}` }),
                el('span', { class: 'analytics-bar__meta', text: meta }),
            ]);
        })));
    },

    renderAnalyticsStages() {
        const rows = (this.analytics.stages && this.analytics.stages.rows) || [];
        if (!rows.length) {
            $('analyticsStageChart').replaceChildren(el('div', { class: 'empty', text: 'Пациентов по этапам нет.' }));
            return;
        }
        const total = rows.reduce((sum, row) => sum + (row.count || 0), 0);
        const size = 164;
        const center = size / 2;
        const radius = 58;
        const circumference = 2 * Math.PI * radius;
        let offset = 0;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'analytics-donut');
        svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `Пациенты по этапам маршрута, всего ${total}`);
        rows.forEach((row, index) => {
            const value = total ? row.count / total : 0;
            const circle = document.createElementNS(SVG_NS, 'circle');
            circle.setAttribute('class', `analytics-donut__seg analytics-donut__seg--${(index % 5) + 1}`);
            circle.setAttribute('cx', String(center));
            circle.setAttribute('cy', String(center));
            circle.setAttribute('r', String(radius));
            circle.setAttribute('fill', 'none');
            circle.setAttribute('stroke-width', '22');
            circle.setAttribute('stroke-dasharray', `${Math.max(0, value * circumference - 1)} ${circumference}`);
            circle.setAttribute('stroke-dashoffset', String(-offset));
            circle.setAttribute('transform', `rotate(-90 ${center} ${center})`);
            svg.append(circle);
            offset += value * circumference;
        });
        const ring = el('div', { class: 'analytics-ring analytics-ring--donut' }, [
            svg,
            el('div', { class: 'analytics-ring-center', 'aria-hidden': 'true' }, [
                el('div', {
                    class: `analytics-ring-value${total >= 100 ? ' analytics-ring-value--compact' : ''}`,
                    text: String(total),
                }),
                el('div', { class: 'analytics-ring-label', text: this.patientCountWord(total) }),
            ]),
        ]);
        const bars = el('div', { class: 'analytics-stage-list' }, rows.map(row => el('button', {
            type: 'button',
            class: 'analytics-stage-row',
            on: { click: () => this.renderAnalyticsDetails('patients', row.stage_label, { stage: row.stage }) },
        }, [
            el('span', { text: row.stage_label }),
            el('strong', { text: String(row.count || 0) }),
            el('small', { text: `Просрочки: ${row.overdue_patients}; проблемы: ${row.quality_patients}` }),
        ])));
        $('analyticsStageChart').replaceChildren(ring, bars);
    },

    patientCountWord(count) {
        const value = Math.abs(Number(count) || 0);
        const mod100 = value % 100;
        const mod10 = value % 10;
        if (mod100 >= 11 && mod100 <= 14) return 'пациентов';
        if (mod10 === 1) return 'пациент';
        if (mod10 >= 2 && mod10 <= 4) return 'пациента';
        return 'пациентов';
    },

    svgText(x, y, text, className) {
        const node = document.createElementNS(SVG_NS, 'text');
        node.setAttribute('x', String(x));
        node.setAttribute('y', String(y));
        node.setAttribute('class', className);
        node.setAttribute('text-anchor', 'middle');
        node.textContent = text;
        return node;
    },

    renderAnalyticsAttention() {
        const rows = (this.analytics.dashboard && this.analytics.dashboard.attention && this.analytics.dashboard.attention.rows) || [];
        if (!rows.length) {
            $('analyticsAttentionList').replaceChildren(el('div', { class: 'empty', text: 'Пациентов с активной ручной отметкой внимания нет.' }));
            return;
        }
        this.renderAnalyticsVisualBars('analyticsAttentionList', rows, {
            labelKey: 'label',
            tone: row => (row.code === 'critical_overdue' || row.code === 'emergency_hospitalization') ? 'danger' : 'warning',
            onClick: row => row.detail_type ? this.renderAnalyticsDetails(row.detail_type, row.label, { attentionReason: row.code }) : null,
        });
    },

    renderAnalyticsWorkload() {
        const rows = (this.analytics.workload && this.analytics.workload.rows) || [];
        if (!rows.length) {
            $('analyticsWorkloadList').replaceChildren(el('div', { class: 'empty', text: 'Нет данных по нагрузке в текущей области доступа.' }));
            return;
        }
        const chartRows = rows.slice(0, 8).map(row => ({
            label: row.doctor_name,
            count: row.active_patients,
            percent: 0,
            meta: `Просрочки: ${row.overdue_patients}; чек-листы: ${row.incomplete_required_checklists}; ошибки отправки: ${row.failed_notifications}`,
        }));
        const max = Math.max(1, ...chartRows.map(row => row.count));
        chartRows.forEach(row => { row.percent = Math.round(row.count / max * 1000) / 10; });
        this.renderAnalyticsVisualBars('analyticsWorkloadList', chartRows, {
            labelKey: 'label',
            tone: () => 'info',
            meta: row => row.meta,
            onClick: () => null,
        });
    },

    renderAnalyticsQualityVisual() {
        const data = this.analytics.dataQuality || {};
        const summary = data.summary || {};
        const rows = (this.analytics.dashboard && this.analytics.dashboard.data_quality && this.analytics.dashboard.data_quality.rows) || [];
        // Сводка считается сервером по той же выборке, что и список ниже; без пациентов значения нет.
        const hasPatients = summary.average_completeness != null;
        const safeScore = hasPatients ? Math.max(0, Math.min(100, Number(summary.average_completeness))) : 0;
        const ringLength = 2 * Math.PI * 39;
        const qualityRing = document.createElementNS(SVG_NS, 'svg');
        qualityRing.setAttribute('class', 'analytics-quality-ring');
        qualityRing.setAttribute('viewBox', '0 0 96 96');
        qualityRing.setAttribute('role', 'img');
        qualityRing.setAttribute('aria-label', hasPatients ? `Заполненность обязательных полей ${safeScore}%` : 'Нет пациентов в выборке');
        const qualityCircle = document.createElementNS(SVG_NS, 'circle');
        qualityCircle.setAttribute('class', 'analytics-quality-ring__seg');
        qualityCircle.setAttribute('cx', '48');
        qualityCircle.setAttribute('cy', '48');
        qualityCircle.setAttribute('r', '39');
        qualityCircle.setAttribute('fill', 'none');
        qualityCircle.setAttribute('stroke-width', '10');
        // Дуга пропорциональна заполненности: полное кольцо только при 100 %.
        qualityCircle.setAttribute('stroke-dasharray', `${ringLength * safeScore / 100} ${ringLength}`);
        qualityCircle.setAttribute('transform', 'rotate(-90 48 48)');
        qualityRing.append(qualityCircle);
        const panel = el('div', { class: 'analytics-quality-card' }, [
            el('div', { class: 'analytics-quality-card__score' }, [
                el('div', { class: 'analytics-ring analytics-ring--quality' }, [
                    qualityRing,
                    el('div', { class: 'analytics-ring-center', 'aria-hidden': 'true' }, [
                        el('div', { class: 'analytics-ring-value analytics-ring-value--quality', text: hasPatients ? `${safeScore}%` : '—' }),
                        el('div', { class: 'analytics-ring-label analytics-ring-label--quality', text: hasPatients ? 'заполнено' : 'нет данных' }),
                    ]),
                ]),
            ]),
            el('div', { class: 'analytics-quality-card__text' }, hasPatients ? [
                el('strong', { text: `${summary.total_issues} проблем качества данных` }),
                el('span', { text: `${summary.patients_with_issues} пациентов требуют проверки данных` }),
            ] : [
                el('strong', { text: 'Нет пациентов в выборке' }),
                el('span', { text: 'Пациентов по выбранным условиям нет.' }),
            ]),
        ]);
        const list = rows.length
            ? el('div', { class: 'analytics-bars analytics-bars--compact' }, rows.slice(0, 5).map(row => el('button', {
                type: 'button',
                class: 'analytics-row analytics-row--button analytics-row--danger',
                on: { click: () => row.detail_type ? this.renderAnalyticsDetails(row.detail_type, row.label, row.filter || {}) : null },
            }, [
                el('span', { text: row.label }),
                el('strong', { text: String(row.count || 0) }),
            ])))
            : el('div', { class: 'empty', text: 'Проблем качества данных по выбранным условиям нет.' });
        $('analyticsQualityList').replaceChildren(panel, list);
    },

    renderAnalyticsOperations() {
        const rows = (this.analytics.dashboard && this.analytics.dashboard.operations && this.analytics.dashboard.operations.rows) || [];
        $('analyticsOperationsList').replaceChildren(frag(rows.map(card => el('button', {
            type: 'button',
            class: 'analytics-row analytics-row--button',
            on: { click: () => card.detail_type ? this.renderAnalyticsDetails(card.detail_type, card.label, card.filter || {}) : null },
        }, [
            el('span', { text: card.label }),
            el('strong', { text: String(card.count || card.value || 0) }),
        ]))));
    },

    renderAnalyticsTrend() {
        const trend = this.analytics.dashboard && this.analytics.dashboard.trend;
        const rows = (trend && trend.rows) || [];
        if (!rows.length) {
            $('analyticsTrendChart').replaceChildren(el('div', { class: 'empty', text: 'Данных по динамике за период нет.' }));
            return;
        }
        const rawMax = Math.max(0, ...rows.map(row => Math.max(row.new_patients || 0, row.completed_patients || 0)));
        const max = Math.max(3, rawMax);
        const width = 640;
        const height = 210;
        const plotLeft = 42;
        const plotRight = width - 22;
        const plotTop = 18;
        const plotBottom = height - 48;
        const chart = document.createElementNS(SVG_NS, 'svg');
        chart.setAttribute('class', 'analytics-trend__svg');
        chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
        chart.setAttribute('role', 'img');
        chart.setAttribute('aria-label', 'Динамика новых и завершённых пациентов за выбранный период');
        const point = (row, index, key) => {
            const x = plotLeft + (rows.length === 1 ? 0 : index * ((plotRight - plotLeft) / (rows.length - 1)));
            const y = plotBottom - ((row[key] || 0) / max) * (plotBottom - plotTop);
            return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
        };
        const makePath = (key) => rows.map((row, index) => {
            const [x, y] = point(row, index, key);
            return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
        }).join(' ');
        [0, Math.ceil(max / 2), max].filter((value, index, self) => self.indexOf(value) === index).forEach(value => {
            const y = plotBottom - (value / max) * (plotBottom - plotTop);
            const grid = document.createElementNS(SVG_NS, 'line');
            grid.setAttribute('class', 'analytics-trend__grid');
            grid.setAttribute('x1', String(plotLeft));
            grid.setAttribute('x2', String(plotRight));
            grid.setAttribute('y1', String(Math.round(y * 10) / 10));
            grid.setAttribute('y2', String(Math.round(y * 10) / 10));
            chart.append(grid);
            chart.append(this.svgText(12, y + 4, String(value), 'analytics-trend__y-label'));
        });
        const area = document.createElementNS(SVG_NS, 'path');
        const last = point(rows[rows.length - 1], rows.length - 1, 'new_patients');
        const first = point(rows[0], 0, 'new_patients');
        area.setAttribute('class', 'analytics-trend__area');
        area.setAttribute('d', `${makePath('new_patients')} L ${last[0]} ${plotBottom} L ${first[0]} ${plotBottom} Z`);
        chart.append(area);
        ['new_patients', 'completed_patients'].forEach((key) => {
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('class', `analytics-trend__line analytics-trend__line--${key}`);
            path.setAttribute('d', makePath(key));
            path.setAttribute('fill', 'none');
            chart.append(path);
            rows.forEach((row, index) => {
                const [x, y] = point(row, index, key);
                const circle = document.createElementNS(SVG_NS, 'circle');
                circle.setAttribute('class', `analytics-trend__point analytics-trend__point--${key}`);
                circle.setAttribute('cx', String(x));
                circle.setAttribute('cy', String(y));
                circle.setAttribute('r', row[key] ? '3.5' : '2.5');
                const title = document.createElementNS(SVG_NS, 'title');
                title.textContent = `${row.label}: ${row[key] || 0}`;
                circle.append(title);
                chart.append(circle);
            });
        });
        const axis = document.createElementNS(SVG_NS, 'line');
        axis.setAttribute('class', 'analytics-trend__axis');
        axis.setAttribute('x1', String(plotLeft));
        axis.setAttribute('x2', String(plotRight));
        axis.setAttribute('y1', String(plotBottom));
        axis.setAttribute('y2', String(plotBottom));
        chart.append(axis);
        [0, Math.floor(rows.length / 2), rows.length - 1].filter((value, index, self) => self.indexOf(value) === index).forEach(index => {
            const [x] = point(rows[index], index, 'new_patients');
            chart.append(this.svgText(x, height - 12, rows[index].label, 'analytics-trend__tick'));
        });
        $('analyticsTrendChart').replaceChildren(
            chart,
            el('div', { class: 'analytics-trend__meta' }, [
                el('span', { class: 'analytics-trend__legend analytics-trend__legend--new', text: 'Новые пациенты' }),
                el('span', { class: 'analytics-trend__legend analytics-trend__legend--completed', text: 'Завершения' }),
                el('span', { text: `${rows.reduce((sum, row) => sum + (row.new_patients || 0), 0)} новых пациентов` }),
                el('span', { text: `${rows.reduce((sum, row) => sum + (row.completed_patients || 0), 0)} завершений по истории этапов` }),
            ]),
        );
    },

    analyticsDetailCurrent(state) {
        return this.currentView === 'analytics' && this.analyticsReadState === 'ready' &&
            this.analytics.details === state && state.token === this.analytics.detailsToken &&
            this.managementReadCurrent(this.analyticsDashboardTicket, this.analyticsParams().toString());
    },

    async renderAnalyticsDetails(type, title, extra = {}, context = {}) {
        if (this.currentView !== 'analytics' || this.analyticsReadState !== 'ready') return;
        const state = {token: ++this.analytics.detailsToken, type, title, extra,
            offset: context.offset || 0, items: [], total: 0, loading: false, error: '',
            focusPatient: context.focusPatient, focusIndex: context.focusIndex};
        this.analytics.details = state;
        await this.loadAnalyticsDetailsPage(state);
    },

    async loadAnalyticsDetailsPage(state, offset = state.offset) {
        if (!this.analyticsDetailCurrent(state) || state.loading) return;
        const initialFocus = document.activeElement;
        state.loading = true;
        state.error = '';
        state.items = [];
        state.offset = offset;
        this.drawAnalyticsDetails(state);
        const heading = $('analyticsDetailTitle');
        // A same-user workspace rebuild replaces every DOM node and may return focus to body.
        const restoreAfterRebuild = state.focusPatient && initialFocus === document.body && !ui.topModal();
        if ($('view-analytics').contains(initialFocus) || !initialFocus?.isConnected || restoreAfterRebuild) heading.focus();
        try {
            // These drilldowns describe current state. Date filters apply to the period chart,
            // never to the patient/event list opened from a current dashboard metric.
            const get = page => apiGetJson('/api/analytics/details?' +
                this.analyticsParams({...state.extra, dateFrom: '', dateTo: '', offset: page}) + '&type=' + encodeURIComponent(state.type));
            let data = await get(offset);
            if (!this.analyticsDetailCurrent(state)) return;
            if (offset && Number.isInteger(data.total) && data.total <= offset) {
                offset = 0;
                data = await get(offset);
                if (!this.analyticsDetailCurrent(state)) return;
            }
            if (data.detail_type !== state.type || data.offset !== offset || data.limit !== 50 ||
                !Number.isInteger(data.total) || data.total < 0 || !Array.isArray(data.items) ||
                data.items.length !== Math.min(50, Math.max(0, data.total - offset))) throw new Error('Некорректная детализация');
            Object.assign(state, {offset, items: data.items, total: data.total});
        } catch {
            if (!this.analyticsDetailCurrent(state)) return;
            state.error = 'Не удалось загрузить детализацию. Попробуйте ещё раз.';
        }
        const restoreFocus = document.activeElement === heading;
        state.loading = false;
        this.drawAnalyticsDetails(state);
        if (restoreFocus) {
            const buttons = [...$('analyticsDetailsPanel').querySelectorAll('[data-analytics-patient]')];
            const target = buttons.find(button => Number(button.dataset.analyticsPosition) === state.focusIndex &&
                button.dataset.analyticsPatient === state.focusPatient) ||
                buttons.find(button => button.dataset.analyticsPatient === state.focusPatient);
            (target || $('analyticsDetailTitle')).focus();
        }
        state.focusPatient = null;
        state.focusIndex = null;
    },

    openAnalyticsPatient(state, item) {
        const current = () => this.analyticsDetailCurrent(state) && !state.loading && state.items.includes(item);
        if (!current()) return;
        state.openedItem = item;
        // Preserve overview for ordinary Analytics, including existing History routes.
        const tab = this.analytics.source ?
            ({overdue_events: 'events', incomplete_checklists: 'checklist',
                notifications_pending: 'notifications', notifications_failed: 'notifications'}[state.type] || 'overview') : 'overview';
        void browserNavigation.navigate({screen: 'patient', patientId: item.patient_id, tab}, {
            allowed: current,
            denied: () => { if (current()) void this.loadAnalyticsDetailsPage(state); },
        });
    },

    // Уточнение для нескольких проблем одного кода у пациента: где в маршруте она найдена.
    qualityIssueContextText(context) {
        if (!context) return '';
        const parts = [];
        if (context.history_number) parts.push(`запись маршрута №${context.history_number}`);
        if (context.event_number) parts.push(`событие №${context.event_number}`);
        if (context.planned_date) parts.push(`плановая дата ${this.formatDeadlineDate(new Date(`${context.planned_date}T12:00:00`))}`);
        return parts.length ? parts.join(', ').replace(/^./, ch => ch.toUpperCase()) : '';
    },

    drawAnalyticsDetails(state) {
        const panel = $('analyticsDetailsPanel');
        const rows = state.items;
        const unit = ({overdue_events: 'события', incomplete_checklists: 'пациенты с незаполненными пунктами',
            notifications_pending: 'уведомления', notifications_failed: 'уведомления', quality_all: 'проблемы качества',
            quality_actionable: 'проблемы качества', quality_critical: 'проблемы качества',
            quality_warning: 'проблемы качества', quality_info: 'проблемы качества'})[state.type] || 'пациенты';
        const pageAction = (text, offset) => el('button', {type: 'button', class: 'btn btn--ghost btn--sm', text,
            on: {click: () => this.loadAnalyticsDetailsPage(state, offset)}});
        panel.setAttribute('aria-busy', String(state.loading));
        panel.replaceChildren(frag([
            el('h2', { id: 'analyticsDetailTitle', tabindex: '-1', class: 'panel__title', text: state.title || 'Детальный список' }),
            !state.loading && !state.error ? el('p', {class: 'panel__text', role: 'status',
                text: 'Текущее состояние · ' + unit + ' · ' +
                    (rows.length ? (state.offset + 1) + '–' + (state.offset + rows.length) + ' из ' + state.total : '0') +
                    '. Данные ограничены текущей областью доступа.'}) : null,
            rows.length ? el('div', { class: 'analytics-list' }, rows.map((item, index) => el('div', { class: 'analytics-detail' }, [
                el('div', { class: 'person__name', text: item.patient_name || item.doctor_name || item.title || 'Запись' }),
                item.severity ? el('div', { class: 'person__meta', text: `${this.QUALITY_SEVERITY_LABELS[item.severity] || item.severity}: ${item.title || item.code_label || item.code}` }) : null,
                this.qualityIssueContextText(item.context) ? el('div', { class: 'person__meta', text: this.qualityIssueContextText(item.context) }) : null,
                item.issue_count ? el('div', { class: 'person__meta', text: `Проблем качества данных: ${item.issue_count}` }) : null,
                item.stage_label ? el('div', { class: 'person__meta', text: item.stage_label }) : null,
                item.treating_doctor_name ? el('div', { class: 'person__meta', text: item.treating_doctor_name }) : null,
                state.type === 'overdue_events' && item.planned_date ? el('div', {class: 'person__meta',
                    text: 'Плановая дата: ' + this.formatDeadlineDate(new Date(item.planned_date + 'T12:00:00'))}) : null,
                item.days_overdue ? el('div', { class: 'person__meta', text: `Просрочено: ${item.days_overdue} дн.` }) : null,
                item.error_code ? el('div', { class: 'person__meta', text: this.NOTIFICATION_REASON_LABELS[item.error_code] || item.error_code }) : null,
                item.patient_id ? el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: 'Открыть пациента',
                    'data-analytics-patient': item.patient_id,
                    'data-analytics-position': String(index),
                    on: { click: () => this.openAnalyticsPatient(state, item) },
                }) : null,
            ]))) : null,
            state.loading ? el('div', {class: 'empty', role: 'status', text: 'Загрузка…'}) : null,
            !state.loading && !state.error && !rows.length ? el('div', { class: 'empty', text: 'По выбранным условиям записей нет.' }) : null,
            state.error ? el('div', { class: 'empty', role: 'alert', text: state.error }) : null,
            state.error ? el('button', {
                type: 'button', class: 'btn btn--ghost btn--sm', text: 'Повторить',
                on: { click: () => this.loadAnalyticsDetailsPage(state) },
            }) : null,
            !state.loading && !state.error ? el('div', {class: 'f1-actions'}, [
                state.offset > 0 ? pageAction('Предыдущая страница', Math.max(0, state.offset - 50)) : null,
                state.offset + rows.length < state.total ? pageAction('Следующая страница', state.offset + 50) : null,
            ]) : null,
        ]));
    },

    analyticsExportChoice() {
        const reportType = $('analyticsReportType').value;
        if (!['summary', 'stages', 'workload', 'data_quality', 'checklists', 'notifications'].includes(reportType)) return null;
        const supportsDetails = reportType === 'data_quality' || reportType === 'checklists';
        const detailLevel = supportsDetails && $('analyticsReportDetail').value === 'details' ? 'details' : 'aggregate';
        return { reportType, detailLevel, supportsDetails };
    },

    analyticsExportCurrent(ticket = this.analyticsDashboardTicket) {
        return this.currentView === 'analytics' && !this.can('consiliumChair') &&
            this.analyticsReadState === 'ready' && this.managementReadCurrent(ticket, this.analyticsParams());
    },

    updateAnalyticsExportControls() {
        const controls = $('analyticsExportControls');
        const type = $('analyticsReportType');
        const detail = $('analyticsReportDetail');
        const choice = this.analyticsExportChoice();
        const ready = this.analyticsExportCurrent();
        const pending = this.analyticsExportRequest && this.analyticsExportCurrent(this.analyticsExportRequest.ticket);
        controls.hidden = !this.user || this.can('consiliumChair');
        type.disabled = !ready || !!pending;
        detail.disabled = !ready || !!pending || !choice?.supportsDetails;
        const detailOption = detail.querySelector('[value="details"]');
        detailOption.disabled = !choice?.supportsDetails;
        detailOption.textContent = choice?.reportType === 'checklists' ? 'По этапам' : 'По кодам проблем';
        if (!choice?.supportsDetails) detail.value = 'aggregate';
        $('analyticsExportBtn').disabled = !ready || !!pending || !choice;

        const description = $('analyticsExportDescription');
        if (!ready || !choice) {
            description.textContent = 'CSV доступен после загрузки актуальной аналитики.';
            return;
        }
        const { dashboard, filters } = this.analytics;
        const scope = {
            global: 'Все пациенты в вашей области доступа',
            global_readonly: 'Все пациенты в вашей области чтения',
            by_department: 'Пациенты доступных вам отделений',
            by_treating_doctor: 'Ваши пациенты',
        }[dashboard.meta.scope] || 'Ваша область доступа';
        const active = [
            ['Этап', 'analyticsStageFilter', filters.stage],
            ['Локализация', 'analyticsNosologyFilter', filters.nosology],
            ['Лечащий врач', 'analyticsDoctorFilter', filters.doctor],
            ['Отделение', 'analyticsDepartmentFilter', filters.department],
            ['Причина внимания', 'analyticsAttentionReasonFilter', filters.attentionReason],
        ].flatMap(([label, id, value]) => {
            if (!value) return [];
            const selected = $(id).selectedOptions[0];
            return [selected?.value === value ? label + ' — ' + selected.textContent : label];
        });
        const filterText = active.length ? 'Фильтры: ' + active.join(', ') + '.' : 'Без дополнительных фильтров.';
        const file = 'Файл: analytics_' + choice.reportType + '_дата_время.csv.';
        const limit = choice.reportType === 'workload' ? ' До 50 строк нагрузки.' : '';
        description.textContent = scope + '. ' + filterText + ' Текущее состояние на момент выгрузки. Выбранный период не применяется к CSV. ' + file + limit;
    },

    async exportAnalyticsCsv() {
        const ticket = this.analyticsDashboardTicket;
        if (!this.analyticsExportCurrent(ticket)) return;
        if (this.analyticsExportRequest && this.analyticsExportCurrent(this.analyticsExportRequest.ticket)) return;
        const choice = this.analyticsExportChoice();
        if (!choice) return;
        const { reportType, detailLevel } = choice;
        const request = { ticket };
        this.analyticsExportRequest = request;
        this.updateAnalyticsExportControls();
        const current = () => this.analyticsExportRequest === request && this.analyticsExportCurrent(ticket);
        try {
            const response = await apiFetch('/api/analytics/export?' + ticket.params, {
                method: 'POST',
                body: JSON.stringify({ reportType, detailLevel }),
                rawResponse: true,
            });
            if (!current()) return;
            const disposition = response?.headers.get('content-disposition') || '';
            const match = /^attachment; filename="(analytics_([a-z_]+)_\d{8}_\d{6}\.csv)"$/.exec(disposition);
            const contentType = response?.headers.get('content-type') || '';
            if (!match || match[2] !== reportType || !/^text\/csv(?:\s*;|$)/i.test(contentType)) {
                throw new Error('сервер не вернул ожидаемый CSV-файл');
            }
            const blob = await response.blob();
            if (!current()) return;
            const url = URL.createObjectURL(blob);
            const link = el('a', { href: url, download: match[1] });
            document.body.append(link);
            try {
                link.click();
            } finally {
                link.remove();
                URL.revokeObjectURL(url);
            }
            ui.toast('CSV-отчёт сформирован.', 'good');
        } catch (e) {
            if (current()) ui.toast('Не удалось сформировать CSV: ' + e.message, 'warning');
        } finally {
            if (this.analyticsExportRequest === request) {
                this.analyticsExportRequest = null;
                this.updateAnalyticsExportControls();
            }
        }
    },

    tabNotifications() {
        return el('div', { class: 'panel panel--pad', id: 'patientNotificationsBlock' }, [
            el('h2', { class: 'section-title', text: 'Сообщения пациенту' }),
            el('div', { class: 'empty', text: 'Загрузка…' }),
        ]);
    },

    async renderPatientNotificationsBlock(patientId) {
        const box = $('patientNotificationsBlock');
        if (!box||this.currentView!=='patient'||this.currentTab!=='notifications'||this.currentPatientId!==patientId) return;
        const ticket=this.notificationTicket('patient-notifications');this.patientNotificationReady=false;this.patientNotificationItems=[];this.patientNotificationCanWrite=false;this.patientNotificationCanCreate=false;
        const current=()=>this.notificationCurrent(ticket)&&box.isConnected&&this.currentPatientId===patientId&&this.currentTab==='notifications'&&this.currentView==='patient';
        this.notificationControls();
        if(!this.notificationInputNodes('patient').length)box.replaceChildren(frag([
            el('h2', { class: 'section-title', text: 'Сообщения пациенту' }),
            el('div', { class: 'empty', text: 'Загрузка…' }),
        ]));
        try {
            const [data, templatesData] = await Promise.all([
                apiGetJson(`/api/notifications/patients/${patientId}`),
                apiGetJson('/api/notifications/templates'),
            ]);
            if(!current())return;const localDraft=this.notificationInputSnapshot('patient',this.notificationMutation?.scope==='patient'&&this.notificationMutation.patientId===patientId);
            const resumed=this.notificationReauthDraft;const draft=localDraft.length?localDraft:resumed?.owner===this.user?.id&&resumed.epoch===(this.sessionEpoch||0)&&resumed.patientId===patientId?resumed.patient:[];this.patientNotificationId=patientId;this.patientNotificationItems=data.notifications||[];this.patientNotificationCanWrite=!!data.can_write;this.patientNotificationReady=true;this.notificationReadFinished('patient');
            const pref = data.preference || {};
            this.notifications.templates = templatesData.templates || [];
            this.notifications.placeholders = templatesData.placeholders || [];
            const templates = (templatesData.templates || []).filter(t => t.enabled);
            const canWrite = !!data.can_write && !this.isReadOnly();
            this.patientNotificationCanCreate=canWrite&&pref.sms_enabled&&pref.consent_status==='granted';
            const consentLabel = {
                not_recorded: 'Согласие не зафиксировано',
                granted: 'Согласие получено',
                revoked: 'Согласие отозвано',
            }[pref.consent_status] || 'Согласие не зафиксировано';
            box.replaceChildren(frag([
                el('h2', { class: 'section-title', text: 'Сообщения пациенту' }),
                el('p', { class: 'alert alert--info', text: 'Тестовый режим: реальные SMS не отправляются' }),
                el('div', { class: 'summary notification-consent' }, [
                    el('div', { text: pref.sms_enabled ? 'SMS включены' : 'SMS выключены' }),
                    el('div', { text: consentLabel }),
                    pref.consent_recorded_at ? el('div', { text: `Дата фиксации: ${this.formatDateTime(pref.consent_recorded_at)}` }) : null,
                    pref.consent_recorded_by_name ? el('div', { text: `Зафиксировал: ${pref.consent_recorded_by_name}` }) : null,
                    data.upcoming ? el('div', { text: `Ближайшее уведомление: ${this.formatNotificationMoment(data.upcoming.scheduled_at)}` }) : null,
                ]),
                canWrite ? this.patientNotificationActions(patientId, pref, templates, data.institution_now) : el('p', {
                    class: 'muted',
                    text: 'Режим просмотра — изменение данных недоступно',
                }),
                el('h3', { class: 'section-title', text: 'История уведомлений' }),
                data.notifications && data.notifications.length
                    ? el('div', { class: 'notification-list' }, data.notifications.map(item => el('div', { class: 'notification-row' }, [
                        el('div', {}, [
                            el('div', { class: 'person__name', text: item.template_name || item.template_code }),
                            el('div', { class: 'person__meta', text: `${this.formatNotificationMoment(item.scheduled_at)} · ${this.NOTIFICATION_SOURCE_LABELS[item.source_type] || item.source_type}` }),
                            el('div', { class: 'muted', text: this.notificationReasonText(item) }),
                        ]),
                        this.notificationStatusChip(item.status),
                        canWrite&&item.status==='pending'?el('button',{type:'button',class:'btn btn--ghost btn--sm',text:'Отменить',on:{click:()=>this.cancelNotification(item.id)}}):null,
                        this.can('runNotificationWorker')&&item.status==='failed'?el('button',{type:'button',class:'btn btn--ghost btn--sm',text:'Повторить',on:{click:()=>this.retryNotification(item.id)}}):null,
                    ])))
                    : el('div', { class: 'empty', text: 'Уведомления ещё не создавались.' }),
            ]));
            this.stampNotificationInputs('patient');if(canWrite)this.restoreNotificationInputs('patient',draft);if(resumed&&resumed.patientId===patientId)resumed.patient=[];
            this.updatePatientNotificationPreview();this.notificationControls();
        } catch (e) {
            if(!current())return;
            if([403,404].includes(e.status)){this.discardSessionAndReload();return;}
            this.notificationFailure(ticket);
        }
    },

    patientNotificationActions(patientId, pref, templates, institutionNow) {
        const serverNow = new Date(institutionNow);
        const now = new Date(serverNow.getTime() + 60 * 60 * 1000);
        const defaultDateTime = Number.isNaN(now.getTime()) ? '' : new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(now).replace(' ', 'T');
        return el('div', {}, [
            el('div', { class: 'pcard__actions' }, [
                el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Зафиксировать согласие',
                    on: { click: () => this.savePatientNotificationPreference(patientId, true, 'granted') },
                }),
                el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Отозвать согласие',
                    disabled: pref.consent_status !== 'granted',
                    title: pref.consent_status !== 'granted' ? 'Согласие ещё не получено' : 'Ожидающие уведомления будут отменены',
                    on: { click: () => this.savePatientNotificationPreference(patientId, false, 'revoked') },
                }),
            ]),
            el('div', { class: 'notification-form' }, [
                el('div', { class: 'field' }, [
                    el('label', { class: 'field__label', for: 'patientNotificationTemplate', text: 'Шаблон' }),
                    el('select', {
                        class: 'select',
                        id: 'patientNotificationTemplate',
                        on: { change: () => this.updatePatientNotificationPreview() },
                    }, templates.length
                        ? templates.map(t => option(t.code, t.name))
                        : [option('', 'Нет включённых шаблонов', true)]),
                ]),
                el('div', { class: 'field' }, [
                    el('label', { class: 'field__label', for: 'patientNotificationSchedule', text: 'Дата и время отправки (МСК)' }),
                    el('input', {
                        class: 'input',
                        type: 'datetime-local',
                        id: 'patientNotificationSchedule',
                        value: defaultDateTime,
                        on: { input: () => this.updatePatientNotificationPreview() },
                    }),
                ]),
                el('div', { class: 'field field--wide' }, [
                    el('label', { class: 'field__label', for: 'patientNotificationPreview', text: 'Предварительный просмотр' }),
                    el('textarea', { class: 'textarea', id: 'patientNotificationPreview', rows: 3, readonly: true }),
                    el('p', { class: 'field__hint', text: 'Свободный текст недоступен: используется только утверждённый шаблон.' }),
                ]),
                el('button', {
                    type: 'button', class: 'btn btn--primary', text: 'Создать напоминание',
                    disabled: !templates.length||!this.patientNotificationCanCreate,
                    on: { click: () => this.createPatientNotification(patientId) },
                }),
            ]),
        ]);
    },

    updatePatientNotificationPreview() {
        const templateSelect = $('patientNotificationTemplate');
        const scheduleInput = $('patientNotificationSchedule');
        const preview = $('patientNotificationPreview');
        if (!templateSelect || !scheduleInput || !preview) return;
        const template = (this.notifications.templates || []).find(t => t.code === templateSelect.value)
            || { body: 'Напоминаем о запланированном посещении {date} в {time}. Для уточнения информации свяжитесь с организацией.' };
        const parts = scheduleInput.value.split('T');
        const dateText = parts[0] || 'дата';
        const timeText = parts[1] || 'время';
        const tokens = template.body.match(/\{\{|\}\}|\{(?:date|time)\}|[^{}]+/g) || [];
        if (template.body.length > 500 || tokens.join('') !== template.body) {
            preview.value = 'Недопустимый шаблон уведомления.';
            return;
        }
        const values = {'{date}': dateText, '{time}': timeText, '{{': '{', '}}': '}'};
        preview.value = tokens.map(token => Object.hasOwn(values, token) ? values[token] : token).join('');

    },

    async savePatientNotificationPreference(patientId,smsEnabled,consentStatus) {
        return this.notificationWrite('patient',()=>this.notificationPatientFresh(patientId)&&!this.isReadOnly(),()=>apiPut(`/api/notifications/patients/${patientId}/preferences`,{smsEnabled,consentStatus}),()=>this.renderPatientNotificationsBlock(patientId));
    },
    async createPatientNotification(patientId) {
        if(!this.notificationPatientFresh(patientId)||!this.patientNotificationCanCreate||this.notificationMutation)return;
        const templateCode=$('patientNotificationTemplate').value,scheduledValue=$('patientNotificationSchedule').value;
        const scheduled=scheduledValue?new Date(scheduledValue+'+03:00'):null;
        if(!templateCode||$('patientNotificationTemplate').selectedOptions[0]?.disabled||!scheduled||Number.isNaN(scheduled.getTime())){ui.toast('Укажите шаблон, дату и время отправки.','warning');return;}
        return this.notificationWrite('patient',()=>this.notificationPatientFresh(patientId)&&!this.isReadOnly(),()=>apiPost('/api/notifications',{patientId,templateCode,scheduledAt:scheduled.toISOString()}),()=>this.renderPatientNotificationsBlock(patientId));
    },
    async cancelNotification(id) {
        const patient=this.notificationPatientFresh(this.currentPatientId),scope=patient?'patient':'outbound';
        return this.notificationWrite(scope,()=>patient?this.patientNotificationCanWrite&&this.patientNotificationItems.some(i=>i.id===id&&i.status==='pending'):this.notificationOutboundFresh()&&this.can('manageNotifications')&&this.notifications.items.some(i=>i.id===id&&i.status==='pending'),()=>apiPost(`/api/notifications/${id}/cancel`),()=>patient?this.renderPatientNotificationsBlock(this.currentPatientId):this.renderNotifications());
    },
    async retryNotification(id) {
        const patient=this.notificationPatientFresh(this.currentPatientId),scope=patient?'patient':'outbound';
        return this.notificationWrite(scope,()=>this.can('runNotificationWorker')&&(patient?this.patientNotificationItems:this.notificationOutboundFresh()?this.notifications.items:[]).some(i=>i.id===id&&i.status==='failed'),()=>apiPost(`/api/notifications/${id}/retry`),()=>patient?this.renderPatientNotificationsBlock(this.currentPatientId):this.renderNotifications());
    },
    async generateNotificationsDue() {
        return this.notificationWrite('outbound',()=>this.notificationOutboundFresh()&&this.can('runNotificationWorker'),()=>apiPost('/api/notifications/generate-due'),()=>this.renderNotifications());
    },
    async processNotificationsDue() {
        return this.notificationWrite('outbound',()=>this.notificationOutboundFresh()&&this.can('runNotificationWorker'),()=>apiPost('/api/notifications/process-due?limit=100'),()=>this.renderNotifications());
    },
    async saveNotificationTemplate(code) {
        if(!this.notificationOutboundFresh()||this.notificationMutation||this.notificationTemplateChecking||!this.can('manageNotificationTemplates'))return false;
        const nodes=this.notificationInputNodes('outbound').filter(n=>this.notificationTemplateCode(n)===code);
        const dirty=this.notificationInputSnapshot('outbound').filter(x=>nodes.some(n=>n.id===x.id));
        if(!dirty.length)return false;
        if(nodes.some(n=>this.notificationInputBaselines.get(n)?.conflict)){ui.toast('Сначала разрешите обнаруженный конфликт шаблона.','warning');return false;}
        const ticket=this.notificationTicket('notification-template-check'),baseline=this.notifications.templates.find(t=>t.code===code),outboundVersion=this.readVersions.notifications;
        this.notificationTemplateChecking=ticket;this.notificationControls();
        try {
            const fresh=await apiGetJson('/api/notifications/templates');
            if(!this.notificationCurrent(ticket)||this.readVersions.notifications!==outboundVersion||!this.notificationOutboundFresh()||!this.can('manageNotificationTemplates'))return false;
            const target=fresh.templates.find(t=>t.code===code);
            if(!target){this.notificationFailure({...ticket,key:'notifications'});return false;}
            const changed=this.notificationTemplateState(target)!==this.notificationTemplateState(baseline);
            const changedInput=dirty.some(x=>{const n=$(x.id);return !n||this.notificationInputValue(n)!==JSON.stringify(n.type==='checkbox'?x.checked:x.value);});
            this.notifications.templates=fresh.templates;this.notifications.placeholders=fresh.placeholders||[];
            this.renderNotificationTemplatesPanel();
            if(changed||changedInput){ui.toast('Состояние шаблона или ввод изменились. Проверьте показанные данные перед сохранением.','warning');return false;}
            const payload={};for(const x of dirty)payload[x.id.startsWith('template-body-')?'body':'enabled']=x.id.startsWith('template-body-')?x.value:x.checked;
            this.notificationTemplateChecking=null;this.notificationControls();
            return await this.notificationWrite('outbound',()=>this.notificationOutboundFresh()&&this.can('manageNotificationTemplates'),async()=>{
                const saved=await apiPut(`/api/notifications/templates/${encodeURIComponent(code)}`,payload);
                if(!this.notificationLive(ticket))return;
                for(const node of this.notificationInputNodes('outbound').filter(n=>this.notificationTemplateCode(n)===code)){
                    const c=this.notificationInputBaselines.get(node);if(!c)continue;
                    const field=node.type==='checkbox'?'enabled':'body',value=field==='enabled'?!!saved.enabled:saved.body;
                    const expected=Object.hasOwn(payload,field)?JSON.stringify(payload[field]):c.initial;
                    // A server-side change to an untouched field must not become a phantom draft.
                    if(this.notificationInputValue(node)===expected){if(field==='enabled')node.checked=value;else node.value=value;}
                    c.initial=JSON.stringify(value);c.origin=this.notificationTemplateState(saved);c.conflict=false;c.retain=false;
                }
            },()=>this.renderNotifications());
        } catch(e) {
            if(this.notificationCurrent(ticket)&&this.readVersions.notifications===outboundVersion){if([403,404].includes(e.status))this.discardSessionAndReload();else{this.notificationFailure({...ticket,key:'notifications'});ui.toast('Не удалось проверить шаблоны. Ввод сохранен; запись не отправлена. '+e.message,'warning');}}
            return false;
        } finally {if(this.notificationTemplateChecking===ticket)this.notificationTemplateChecking=null;this.notificationControls();}
    },

    /* ==================================================== РЕНДЕР: ПРОЧИЕ РАЗДЕЛЫ */

    openWorkingSchedule(query = '', allowed) {
        if (this.currentView !== 'myDay' || !this.navigationVisibility().myDay) return false;
        return browserNavigation.navigate({screen: 'calendar', schedule: {query, source: 'myDay', trail: [null], index: 0}}, {allowed});
    },

    scheduleContext(eventId = null) {
        const state = this.workspaceListState('events');
        return {query: state.query, source: state.source || null, eventId,
            trail: state.ready ? state.trail.slice(0, state.index + 1) : [null], index: state.ready ? state.index : 0};
    },

    scheduleDateCell(row, today) {
        const tone = row.date < today ? 'danger' : row.date === today ? 'accent' : 'neutral';
        const label = row.date < today ? 'Просрочено' : row.date === today ? 'Сегодня' : 'Запланировано';
        const date = row.date.split('-').reverse().join('.');
        return [el('div', {class: 'workspace-date', text: `${date} · ${row.time || 'Время не указано'}`}),
            el('span', {class: `chip chip--${tone}`, text: label})];
    },

    async renderCalendar(cursor = null) {
        return this.renderWorkspacePage('events','calendarPanel','calendar',cursor);
    },
    workspaceListState(kind) {
        this.workspacePages ||= {};
        return this.workspacePages[kind] ||= {query:'',trail:[null],index:0,ready:false,rows:[]};
    },
    async renderWorkspacePage(kind,hostId,view,cursor=null,_unused=null,restarted=false) {
        const state=this.workspaceListState(kind),epoch=this.sessionEpoch,owner=this.user?.id;
        const version=this.beginRead('workspace-'+kind),host=$(hostId),returnFocus=host.contains(document.activeElement);
        const scheduleTitle = kind === 'events' ? $('scheduleTitle') : null;
        if (returnFocus && scheduleTitle && !ui.topModal()) {
            scheduleTitle.tabIndex = -1;
            scheduleTitle.focus({preventScroll: true});
        }
        const scheduleFocus = () => scheduleTitle && document.activeElement === scheduleTitle && !ui.topModal();
        const current=()=>this.isCurrentRead('workspace-'+kind,version)&&this.sessionEpoch===epoch&&this.user?.id===owner&&!this.sessionReconciling&&this.currentView===view;
        state.ready=false;state.rows=[];host.setAttribute('aria-busy','true');
        host.replaceChildren(el('p',{class:'empty',role:'status',text:'Загрузка актуальных данных…'}));
        if(!cursor){state.trail=[null];state.index=0;}
        try {
            const query=new URLSearchParams({limit:'50',q:state.query||''});if(cursor)query.set('cursor',cursor);
            const data=await apiGetJson('/api/patients/workspace/'+kind+'?'+query);
            if(!current())return;
            state.rows=data[kind];state.page=data.page;state.ready=true;state.epoch=epoch;
            const event=kind==='events',headers=event?['Пациент и этап','Плановая дата и время','Заведующий','Действие']:['Пациент и этап','Обязательные пункты','Лечащий врач','Действие'];
            const today = event ? new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Moscow', dateStyle: 'short'}).format() : null;
            const rows=state.rows.map(row=>{
                const name=event?row.patientName:row.patient_name,stage=this.stageNames[row.stage]||row.stage;
                return el('tr',{class:'list-row','data-workspace-row':event?row.id:row.patient_id},[
                    el('td',{'data-label':headers[0]},[el('div',{class:'person__name',text:name}),el('div',{class:'person__meta',text:stage})]),
                    el('td',{'data-label':headers[1]},event?this.scheduleDateCell(row,today):[
                        el('div',{class:'workspace-progress',role:'progressbar','aria-label':'Выполнение обязательных пунктов','aria-valuemin':'0','aria-valuemax':String(row.total_required),'aria-valuenow':String(row.completed_required)},el('span',{class:'workspace-progress__fill','data-complete':String(row.completed_required===row.total_required)},String(row.completed_required)+' / '+String(row.total_required))),
                        el('span',{class:row.incomplete_required?'chip chip--warning':'chip chip--good',text:row.incomplete_required?'Не выполнено: '+row.incomplete_required:'Обязательные пункты выполнены'})]),
                    el('td',{'data-label':headers[2],text:(event?row.head:row.treating_doctor_name)||'Не указан'}),
                    el('td',{'data-label':headers[3]},el('button',{type:'button',class:'btn btn--ghost btn--sm',text:event?'К событию':'К чек-листу','aria-label':(event?'Открыть карточку: ':'Открыть чек-лист: ')+name,on:{click:()=>this.openWorkspacePatient(kind,row,version)}})),
                ]);
            });
            const table=el('div',{class:'workspace-table-scroll'},el('table',{class:'workspace-table'},[
                el('caption',{class:'visually-hidden',text:event?'Плановые события без отмеченного факта':'Обязательные чек-листы последнего вхождения этапа'}),
                el('thead',{},el('tr',{},headers.map(text=>el('th',{scope:'col',text})))),el('tbody',{},rows),
            ]));
            const load=next=>this.renderWorkspacePage(kind,hostId,view,next);
            host.replaceChildren(el('div',{class:'workspace-result',role:'status','aria-live':'polite',tabindex:'-1',text:`Найдено в разрешенной области: ${data.page.total}`}),rows.length?table:el('div',{class:'empty',text:state.query?'По вашему запросу ничего не найдено. Измените поиск.':event?'Плановых событий без факта нет.':'Чек-листов с обязательными пунктами нет.'}),this.boundedPager(data,state,load));
            if (event) {
                const eventId = state.focusEventId;
                state.focusEventId = null;
                if (scheduleFocus()) {
                    const previous = eventId && [...host.querySelectorAll('[data-workspace-row]')]
                        .find(node => node.dataset.workspaceRow === eventId)?.querySelector('button');
                    if (previous) previous.focus();
                    else if (returnFocus || restarted) host.querySelector('.workspace-result').focus({preventScroll:true});
                }
            } else if(returnFocus)host.querySelector('.workspace-result').focus({preventScroll:true});
        } catch(error) {
            if(!current())return;
            if(!restarted&&[409,410].includes(error.status)&&['PATIENT_QUERY_CHANGED','CURSOR_EXPIRED'].includes(error.data?.code)){
                ui.toast('Набор изменился. Обновлена первая страница; поиск, карточка и черновики сохранены.','warning');
                return this.renderWorkspacePage(kind,hostId,view,null,null,true);
            }
            state.ready=false;state.rows=[];
            if(!error.obsolete) {
                const retry = el('button',{type:'button',class:'btn btn--ghost',text:'Повторить загрузку',on:{click:()=>loadWorkspace()}});
                host.replaceChildren(el('p',{class:'alert alert--danger',role:'alert',text:'Нет актуальных данных. '+error.message}),retry);
                if (scheduleFocus()) retry.focus();
            }
        } finally {if(current())host.removeAttribute('aria-busy');}
        const loadWorkspace=()=>this.renderWorkspacePage(kind,hostId,view);
    },
    openWorkspacePatient(kind, row, version) {
        const state = this.workspaceListState(kind);
        const view = kind === 'events' ? 'calendar' : 'checklists';
        const id = row.patientId || row.patient_id;
        const action = kind === 'events' ? {kind: 'day-event', occurrenceId: row.historyEntryId,
            eventId: row.id, stage: row.stage, date: row.date, time: row.time || ''} : null;
        const refresh = () => {
            if (this.currentView === 'calendar' && this.isCurrentRead('workspace-events', version)) {
                void this.renderCalendar(state.trail[state.index]);
            }
        };
        return this.openPatient(id, kind === 'events' ? 'events' : 'checklist', {
            registryOnDenial: !action,
            historyAction: action,
            denied: action ? refresh : undefined,
            readFailed: action ? refresh : undefined,
            allowed: () => state.ready && state.rows.includes(row) && state.epoch === this.sessionEpoch &&
                this.currentView === view && this.isCurrentRead('workspace-' + kind, version),
            prepare: patient => {
                if (!action) return true;
                const unavailable = f1Doctor.replayAction(this, patient, action);
                if (!unavailable) return true;
                ui.toast(unavailable, 'warning');
                refresh();
                return false;
            },
            focus: () => {
                const target = kind === 'events' ? $('patient-event-' + row.id) : $('patientPanels');
                target?.scrollIntoView({block: 'nearest'});
                return target;
            },
        });
    },

    boundedPager(data,state,load) {
        const page=data.page;
        return el('div',{class:'pagination'},[
            el('button',{type:'button',class:'btn btn--ghost',text:'Назад',disabled:state.index===0,on:{click:()=>{state.index--;load(state.trail[state.index]);}}}),
            el('span',{role:'status','aria-live':'polite',text:page.total?`${page.offset+1}–${Math.min(page.offset+page.limit,page.total)} из ${page.total}`:'Нет результатов'}),
            el('button',{type:'button',class:'btn btn--ghost',text:'Далее',disabled:!page.hasNext,on:{click:()=>{state.trail[++state.index]=page.nextCursor;load(page.nextCursor);}}}),
        ]);
    },

    async renderChecklistsView(cursor = null) {
        return this.renderWorkspacePage('checklists','checklistsPanel','checklists',cursor);
    },

    auditRequestParams() { return 'limit=100'; },
    setAuditReadState(state) {
        this.auditReadState=state;
        const panel=$('auditPanel');panel.setAttribute('aria-busy',String(state==='loading'));
        if(state==='ready')return;
        panel.replaceChildren(el('div',{class:'empty',role:state==='error'?'alert':'status',text:state==='loading'?'Загрузка выборки журнала…':'Не удалось загрузить выборку журнала. Это не означает отсутствия записей в журнале. Повторите обновление.'}));
    },
    async renderAudit() {
        const panel=$('auditPanel');
        if(!this.user||this.sessionExpired||this.sessionReconciling||!this.can('viewAudit')){this.setAuditReadState('error');return;}
        const params=this.auditRequestParams(),ticket=this.managementReadTicket('audit-log',params);this.auditReadTicket=ticket;
        const current=()=>this.can('viewAudit')&&this.managementReadCurrent(ticket,this.auditRequestParams());
        if(panel.contains(document.activeElement))$('auditRefreshBtn').focus({preventScroll:true});
        this.setAuditReadState('loading');
        try {
            const data=await apiGetJson('/api/audit?'+params);if(!current())return;
            if(!Array.isArray(data.events))throw new Error('Invalid audit response');
            if (!data.events.length) {
                this.setAuditReadState('ready');
                panel.replaceChildren(el('div',{class:'empty',role:'status',text:'В полученной выборке нет событий. Это не подтверждает отсутствие записей в журнале.'}));
                return;
            }
            const labels = {
                login_success: 'Успешный вход', login_failure: 'Неудачный вход',
                login_rate_limited: 'Вход заблокирован (частые попытки)', logout: 'Выход',
                password_changed: 'Смена пароля', patient_created: 'Создан пациент',
                patient_updated: 'Изменён пациент', patient_deleted: 'Удалён пациент',
                patient_event_deleted: 'Удалено событие маршрута', patient_event_restored: 'Восстановлено событие маршрута',
                import_preview: 'Проверка импорта', import_committed: 'Импорт выполнен',
                import_future_facts: 'Импорт: факт с датой позже сегодняшней',
                import_unverified_facts: 'Импорт: неподтверждённый факт из файла',
                export: 'Экспорт', migration_committed: 'Перенос локальных данных',
                backup_created: 'Создана резервная копия', restore_performed: 'Восстановление из копии',
                db_integrity_failed: 'Ошибка целостности базы',
                user_created: 'Создан сотрудник', user_updated: 'Изменён сотрудник',
                role_changed: 'Изменена роль', user_blocked: 'Сотрудник заблокирован',
                user_deactivated: 'Сотрудник деактивирован', user_restored: 'Сотрудник восстановлен',
                password_reset: 'Сброс пароля', sessions_terminated: 'Завершены сессии',
                department_created: 'Создано отделение', department_updated: 'Изменено отделение',
                head_assigned: 'Назначен заведующий', membership_changed: 'Изменён состав отделения',
                treating_doctor_changed: 'Смена лечащего врача', access_denied: 'Отказ в доступе',
            };
            panel.replaceChildren(el('p',{class:'panel__text',text:`Показано событий: ${data.events.length}. Лимит выборки — 100; это не полный журнал.`}),frag(data.events.map(event => el('div', { class: 'list-row' }, [
                el('div', { class: 'list-row__main' }, [
                    el('div', { class: 'list-row__title', text: labels[event.event_type] || event.event_type }),
                    el('div', { class: 'list-row__sub', text: event.detail ? `${event.detail}` : (event.patient_id ? `запись ${event.patient_id.slice(0, 8)}…` : '—') }),
                ]),
                el('span', { class: `chip chip--${event.result === 'ok' ? 'good' : event.result === 'denied' ? 'danger' : 'warning'}`, text: event.result }),
                el('span', { class: 'list-row__side', text: this.formatDateTime(event.created_at) }),
            ]))));
            this.setAuditReadState('ready');
        } catch (e) {
            if(current())this.setAuditReadState('error');
        }
    },

    renderSettings() {
        const u = this.user || {};
        $('settingsInfo').replaceChildren(frag([
            el('dt', { text: 'Учётная запись' }), el('dd', { text: u.fullName ? `${u.fullName} (${u.roleLabel})` : '—' }),
            el('dt', { text: 'Режим' }), el('dd', { text: 'Локальный, только 127.0.0.1' }),
            el('dt', { text: 'Хранилище' }), el('dd', { text: 'SQLite на сервере' }),
            el('dt', { text: 'В браузере' }), el('dd', { text: 'только выбранная тема оформления' }),
            el('dt', { text: 'Первый Разработчик' }), el('dd', {}, el('code', { text: 'python -m backend.cli create-developer' })),
            el('dt', { text: 'Резервная копия' }), el('dd', {}, el('code', { text: 'python -m backend.cli backup' })),
        ]));
    },

    /* ================================================================ МУТАЦИИ */

    capturePatientEdits() {
        if (!this.user || this.sessionExpired || !this.patientDetails || !$('patientPanels')) return;
        this.sessionFieldDrafts=this.collectSessionFieldDrafts(this.user,[...this.patientDetails.values()],new Set(this.patientDetails.keys()));
        if (this.sessionFieldDrafts.size || $('sessionFieldDrafts')) this.renderSessionFieldDrafts();
    },

    guardNavigationChange(node, control) {
        node.addEventListener('focus',()=>{control.navigationBlur=false;});
        // Clinical controls stay dirty until acknowledgment. Primary fields retain
        // the existing explicit field-completion change contract (including Tab).
        node.addEventListener('keydown', event => { if (event.key === 'Tab') control.navigationBlur = Boolean(control.navigationOnly); });
        node.addEventListener('change',event=>{
            if (control.navigationBlur || !document.hasFocus()) {control.navigationBlur=false;event.stopImmediatePropagation();return;}
        },true);
    },

    registerClinicalControls() {
        this.patientDraftControls ||= new WeakMap();
        for (const node of $('patientPanels').querySelectorAll('[data-clinical-control]')) {
            if (this.patientDraftControls.has(node) || node.disabled || ['checkbox','search'].includes(node.type)) continue;
            const control={navigationOnly:true,readValue:()=>node.value,initial:JSON.stringify(node.value),touched:false};
            this.patientDraftControls.set(node,control);node.addEventListener('input',()=>{control.touched=true;});
            this.guardNavigationChange(node,control);
        }
    },

    dirtyClinicalControls(includePrimary = false) {
        return [...$('patientPanels').querySelectorAll('input,select,textarea')].filter(node=>{
            const c=this.patientDraftControls?.get(node);return c && (includePrimary || c.navigationOnly) && !node.disabled && (c.pending || c.error || (c.touched && JSON.stringify(c.readValue())!==c.initial));
        });
    },

    markClinicalSubmitted(node, submitted) {
        const c = this.patientDraftControls?.get(node);
        if (!c) return;
        c.initial = JSON.stringify(submitted);
        c.touched = JSON.stringify(c.readValue()) !== c.initial;
        c.error = null;
    },

    async submitClinicalControl(node, patientId, write) {
        const c = this.patientDraftControls?.get(node);
        if (!c || this.sessionExpired || !this.can('editPatients')) return;
        if (this.clinicalWriteInFlight || c.blocked) return;
        const owner = this.user.id, epoch = this.sessionEpoch;
        const submitted = node.value;
        const ticket = {};
        this.clinicalWriteInFlight = ticket;
        c.pending = true;
        c.touched = true;
        const field = node.closest('.clinical-field') || node.parentElement;
        let status = field.querySelector('.clinical-save-status');
        if (!status) { status = el('p', {class:'field__hint clinical-save-status', role:'status'}); field.append(status); }
        status.textContent = 'Сохранение… Ввод можно продолжать, повторная запись заблокирована.';
        field.setAttribute('aria-busy', 'true');
        const buttons = [...$('patientPanels').querySelectorAll('[data-card-save]')];
        buttons.forEach(button => { button.disabled = true; });
        try {
            const updated = await write(submitted, c);
            if (this.user?.id !== owner || this.sessionEpoch !== epoch || this.sessionExpired || !node.isConnected) return;
            this.replacePatientInCache(updated);
            this.markClinicalSubmitted(node, submitted);
            status.textContent = c.touched ? 'Отправленное значение сохранено. Новый ввод еще не сохранен.' : 'Сохранено.';
        } catch (error) {
            if (this.user?.id !== owner || this.sessionEpoch !== epoch || this.sessionExpired || !node.isConnected) return;
            if ([403,404].includes(error.status)) {
                this.forgetDeniedPatient(patientId);
                return;
            }
            c.error = error.status || 'unknown';
            c.blocked = !error.status || [409,410].includes(error.status);
            status.textContent = c.blocked
                ? 'Результат записи не подтвержден или версия изменилась. Ввод сохранен в форме. Повторная запись запрещена: явно отмените ввод и обновите карточку перед новым решением.'
                : 'Не сохранено. Ввод сохранен в форме. Исправьте ошибку или повторите сохранение вручную. ' + apiErrorMessage(error.status);
        } finally {
            c.pending = false;
            if (this.clinicalWriteInFlight === ticket) {
                this.clinicalWriteInFlight = null;
                buttons.forEach(button => { button.disabled = !this.can('editPatients'); });
            }
            field.removeAttribute('aria-busy');
            if (c.blocked) field.querySelectorAll('[data-card-save]').forEach(button => { button.disabled = true; });
            if (node.isConnected && !this.sessionExpired && this.user?.id === owner && !this.dirtyClinicalControls().length) this.refreshCurrent();
        }
    },

    forgetDeniedPatient(patientId, {refreshRegistry = true} = {}) {
        browserNavigation.forget(patientId);
        // Object access can change without a role/access-context change.
        this.patientDetails.delete(patientId);
        for (const [key, draft] of this.sessionFieldDrafts) {
            if (draft.patientId === patientId) this.sessionFieldDrafts.delete(key);
        }
        this.patientRows = this.patientRows.filter(patient => patient.id !== patientId);
        this.patientListDirty = true;
        this.renderSessionFieldDrafts();
        if (this.currentView === 'patients') {
            if (this.currentPatientId === patientId) this.clearPatientNavigationView();
            this.patientRows = [];
            $('patientsBody').replaceChildren();
            this.patientPage = null;
            if (refreshRegistry) void this.reloadPatientsAndRender(this.pageTrail[this.pageIndex]);
            return;
        }
        // A row can be denied after returning from its previous card. Clear the
        // hidden card, then let the active workspace refresh its own selection.
        if (this.currentPatientId === patientId && ['myDay', 'pulse', 'calendar', 'notifications', 'analytics'].includes(this.currentView)) {
            this.clearPatientNavigationView();
        }
        if (this.currentPatientId !== patientId) {
            this.renderPatients();
            return;
        }
        this.clearPatientNavigationView();
        this.showView('patients');
        browserNavigation.replaceScreen('patients');
    },

    clearPatientNavigationView() {
        for (const id of ['patientPanels', 'patientSide', 'patientRoute', 'patientFacts', 'crumbPatientName']) {
            $(id).replaceChildren();
        }
        this.currentPatientId = null;
        this.patientDetails.clear();
    },

    async confirmClinicalNavigation(intentCurrent = () => true) {
        if(this.sessionExpired||this.sessionReconciling||!this.user)return false;
        if(this.clinicalWriteInFlight){ui.toast('Дождитесь результата сохранения. Новый ввод остается в форме.','warning');return false;}
        const dirty = this.dirtyClinicalControls().map(node => [node, JSON.stringify(this.patientDraftControls.get(node).readValue())]);
        if (!dirty.length) return true;
        const epoch=this.sessionEpoch,user=this.user.id,patientId=this.currentPatientId;
        const current=()=>intentCurrent()&&!this.sessionExpired&&!this.sessionReconciling&&this.user?.id===user&&this.sessionEpoch===epoch&&this.currentPatientId===patientId&&!this.clinicalWriteInFlight;
        const ok=await ui.confirm({title:'Отменить несохраненный ввод?',text:'Поля события или заметки еще не сохранены. Остаться в форме или явно отменить ввод перед переходом?',okLabel:'Отменить ввод и перейти',danger:false});
        if(!ok||!current())return false;
        if (dirty.some(([node]) => this.patientDraftControls.get(node).error)) {
            try { await this.refreshPatientRecord(patientId, current); }
            catch (error) {
                if (current()) {
                    if ([403, 404].includes(error.status)) this.forgetDeniedPatient(patientId);
                    else ui.toast('Не удалось обновить карточку. Ввод сохранен.', 'warning');
                }
                return false;
            }
            if(!current())return false;
        }
        if (dirty.some(([node, value]) => !node.isConnected ||
            JSON.stringify(this.patientDraftControls.get(node).readValue()) !== value)) return false;
        for (const [node] of dirty) {
            const control = this.patientDraftControls.get(node);
            node.value = JSON.parse(control.initial);
            control.touched = false;
            control.error = null;
            control.blocked = false;
        }
        return true;
    },

    bindPatientNavigation() {
        const routed = '#patientTabs button,#backToList,.nav__item,#openAddBtn,#unresolvedBannerBtn,[data-route-click]';
        const selector=routed+',#patientSide button,#patientFacts button,.tl-step,#themeToggle,[data-card-save]';
        const qualityNavigation = '[data-quality-action="patient"],[data-quality-action="finding"]';
        document.addEventListener('pointerdown',event=>{
            if (!event.target.closest(selector+',#internalNotificationsBell,#aiAssistantBtn,.ai-result-card button,.internal-notification__actions button,#notificationsBody button,'+qualityNavigation) || this.sessionExpired) return;
            const c=this.patientDraftControls?.get(document.activeElement);if(c)c.navigationBlur=true;
        },{capture:true,signal:this.globalControls.signal});
        document.addEventListener('click',event=>{
            const target=event.target.closest(selector);
            if(!target || this.sessionExpired || !this.user || target.matches(routed+', [data-card-save],[data-ai-open],'+qualityNavigation))return;
            const dirty=this.dirtyClinicalControls();if(!dirty.length)return;
            event.preventDefault();event.stopImmediatePropagation();
            if (this.clinicalWriteInFlight) { ui.toast('Дождитесь результата сохранения. Новый ввод остается в форме.', 'warning'); return; }
            void this.confirmClinicalNavigation().then(ok=>{if(ok)target.click();});
        },{capture:true,signal:this.globalControls.signal});
    },

    trackPatientControl(patient, field, node, readValue = () => node.value) {
        this.patientDraftControls = this.patientDraftControls || new WeakMap();
        // Версия принадлежит отрисованной карточке, а не будущему ответу сервера.
        const control = {patientId: patient.id, field, expectedVersion: patient.version,
            readValue, initial: JSON.stringify(readValue()), touched: false};
        this.patientDraftControls.set(node, control);
        for (const event of ['input', 'change']) node.addEventListener(event, () => { control.touched = true; });
        this.guardNavigationChange(node,control);
        return node;
    },

    collectSessionFieldDrafts(user, fresh, allowed) {
        const drafts = new Map(this.sessionFieldDrafts || []);
        for (const node of $('patientPanels').querySelectorAll('input, select, textarea')) {
            const control = this.patientDraftControls?.get(node);
            if (!control || control.navigationOnly || !control.touched || node.disabled) continue;
            const value = control.readValue();
            if (JSON.stringify(value) === control.initial) continue;
            drafts.set(control.patientId + ':' + control.field, {patientId: control.patientId, owner: this.user.id,
                body: {field: control.field, value, expectedVersion: control.expectedVersion}});
        }
        const current = new Map(fresh.map(patient => [patient.id, patient]));
        return new Map([...drafts].filter(([, draft]) => {
            if (draft.owner !== user.id || !allowed.has(draft.patientId)) return false;
            const patient = current.get(draft.patientId);
            const saved = draft.body.field === 'pgiResult'
                ? {result: patient.pgiResult || '', date: patient.pgiResultDate || ''} : patient[draft.body.field];
            // Ответ мог потеряться после успешной записи: уже сохраненное значение не черновик.
            return JSON.stringify(saved ?? '') !== JSON.stringify(draft.body.value ?? '');
        }));
    },

    keepSessionFieldDraft(patientId, body) {
        this.sessionFieldDrafts = this.sessionFieldDrafts || new Map();
        const key = patientId + ':' + body.field;
        this.sessionFieldDrafts.set(key, { patientId, body, owner: this.draftOwnerId || this.user.id });
        this.renderSessionFieldDrafts();
    },

    renderSessionFieldDrafts() {
        let banner = $('sessionFieldDrafts');
        if (!banner) {
            banner = el('div', { id: 'sessionFieldDrafts', class: 'alert alert--warning', role: 'status' });
            $('content').prepend(banner);
        }
        banner.replaceChildren();
        const labels = {name: 'ФИО', age: 'возраст', phone: 'телефон', policyNumber: 'полис ОМС', diagnosis: 'диагноз',
            pgiResult: 'результат ПГИ', pgiResultDate: 'дата ПГИ', nosology: 'клиентский путь', priority: 'приоритет',
            doctor: 'лечащий врач', head: 'заведующий', complaint: 'комментарий'};
        for (const [key, draft] of this.sessionFieldDrafts) {
            const save = el('button', {type: 'button', class: 'btn btn--primary btn--sm', text: 'Сохранить правку', on: {click: async () => {
                if (this.sessionExpired || this.user.id !== draft.owner) return;
                if (!this.can('editPatients')) return;
                save.disabled = true;
                try {
                    // Сохраняется исходная версия: повторный вход не разрешает перезапись.
                    const updated = await apiPatch(`/api/patients/${draft.patientId}`, draft.body);
                    this.sessionFieldDrafts.delete(key);
                    this.replacePatientInCache(updated);
                    this.renderSessionFieldDrafts();
                    this.refreshCurrent();
                } catch (error) {
                    if (this.isStaleRecord(error)) {
                        await this.reloadAfterStaleRecord(draft.patientId, error);
                        this.renderSessionFieldDrafts();
                    }
                    else ui.toast(error.message, 'warning');
                }
                finally { save.disabled = !this.can('editPatients'); }
            }}});
            save.disabled = !this.can('editPatients');
            banner.append(el('div', {}, [el('span', {text: 'Несохраненная правка (' + (labels[draft.body.field] || 'поле карточки') + '): ' +
                    (draft.body.value && typeof draft.body.value === 'object' ? Object.values(draft.body.value).join(' / ') : String(draft.body.value ?? '')) + '. '
                    + 'Версия черновика: ' + draft.body.expectedVersion + '. Версия сервера: ' + (this.getPatient(draft.patientId)?.version ?? 'недоступна') + '. '
                    + 'Поля карточки показывают данные сервера. '}), save,
                el('button', {type: 'button', class: 'btn btn--ghost btn--sm', text: 'Отменить правку', on: {click: async () => {
                    if (!await ui.confirm({title: 'Отменить правку?', text: 'Несохраненное значение будет удалено.', okLabel: 'Удалить черновик'})) return;
                    if (this.sessionExpired) return;
                    try {
                        await this.refreshPatientRecord(draft.patientId);
                        this.sessionFieldDrafts.delete(key);
                        this.renderSessionFieldDrafts();
                        this.refreshCurrent();
                    } catch (error) { ui.toast(error.message, 'warning'); }
                }}}),
            ]));
        }
        banner.hidden = this.sessionFieldDrafts.size === 0;
    },

    async updatePatientField(patientId, fieldName, value) {
        // WP-C: версия карточки, которую видит пользователь; правка устаревшей карточки
        // получает 409 STALE_PATIENT_VERSION вместо тихой перезаписи чужого изменения.
        const cached = this.getPatient(patientId);
        const body = { field: fieldName, value, expectedVersion: cached ? cached.version : undefined };
        for (;;) {
            try {
                const updated = await apiPatch(`/api/patients/${patientId}`, body);
                if (this.sessionFieldDrafts && this.sessionFieldDrafts.delete(patientId + ':' + fieldName)) {
                    this.renderSessionFieldDrafts();
                }
                this.replacePatientInCache(updated);
                this.refreshCurrent();
                return;
            } catch (e) {
                if (e.obsolete && (!this.sessionExpired || this.discardingSession)) return;
                if (e.status === 401 || e.data?.code === 'ACCESS_CONTEXT_CHANGED') {
                    this.keepSessionFieldDraft(patientId, body);
                    return;
                }
                if (!e.status || e.status === 503 || e.status === 422 || this.isStaleRecord(e)) this.keepSessionFieldDraft(patientId, body);
                // WP2.4-C: другой карточке вашей области принадлежит тот же номер полиса.
                if (this.isStaleRecord(e)) {
                    await this.reloadAfterStaleRecord(patientId, e);
                    return;
                }
                if (fieldName === 'policyNumber' && this.isDuplicateLimitExceeded(e)) {
                    ui.toast(e.message, 'danger');
                } else if (fieldName === 'policyNumber' && this.isPossibleDuplicate(e)) {
                    const answer = await this.askDuplicateConfirmation(e.data, {
                        title: 'Номер полиса уже есть у другой карточки', confirmLabel: 'Сохранить номер',
                        reasonLabel: 'Причина, по которой номер нужно сохранить',
                    });
                    if (answer) {
                        body.duplicateConfirmation = {
                            reason: answer.reason, matchedPatientIds: (e.data.matches || []).map(m => m.id),
                        };
                        continue;
                    }
                    ui.toast('Номер полиса не изменен.', 'warning');
                } else {
                    ui.toast('Не удалось сохранить: ' + e.message, 'danger');
                }
                this.refreshCurrent();
                return;
            }
        }
    },

    // WP-C: карточку или пункт чек-листа уже изменил другой пользователь.
    isStaleRecord(error) {
        return Boolean(error && error.status === 409 && error.data
            && (error.data.code === 'STALE_PATIENT_VERSION' || error.data.code === 'STALE_CHECKLIST_ITEM'));
    },

    async reloadAfterStaleRecord(patientId, error) {
        ui.toast(error.message, 'warning');
        try {
            await this.refreshPatientRecord(patientId);
        } catch (e) { /* карточка недоступна — список обновится при следующей загрузке */ }
        this.refreshCurrent();
    },

    // WP2.4-C: ответ 409 POSSIBLE_DUPLICATE — совпадение полиса с карточками вашей области.
    isPossibleDuplicate(error) {
        return Boolean(error && error.status === 409 && error.data && error.data.code === 'POSSIBLE_DUPLICATE');
    },

    // C-01: совпадений больше лимита — подтверждать неполный список нельзя, только ручной разбор.
    isDuplicateLimitExceeded(error) {
        return Boolean(error && error.status === 409 && error.data
            && error.data.code === 'DUPLICATE_MATCH_LIMIT_EXCEEDED');
    },

    // Окно подтверждения возможного дубля: только карточки, доступные сотруднику,
    // все сведения выводятся как текст. Возвращает { reason } или null.
    askDuplicateConfirmation(data, { title, confirmLabel, reasonLabel }) {
        return new Promise((resolve) => {
            let done = false;
            const finish = (reason, openId) => {
                if (done) return;
                done = true;
                $('duplicateForm').removeEventListener('submit', onSubmit);
                $('cancelDuplicateBtn').removeEventListener('click', onCancel);
                $('closeDuplicateIconBtn').removeEventListener('click', onCancel);
                document.removeEventListener('keydown', onKey, true);
                ui.closeModal('duplicateModal');
                if (openId) {
                    ui.closeModal('addModal');
                    this.openPatient(openId);
                }
                resolve(reason ? { reason } : null);
            };
            const onSubmit = (event) => {
                event.preventDefault();
                const reason = $('duplicateReason').value.trim();
                if (!reason) {
                    $('duplicateError').textContent = 'Укажите причину.';
                    $('duplicateError').classList.remove('is-hidden');
                    return;
                }
                finish(reason);
            };
            const onCancel = () => finish(null);
            const onKey = (event) => { if (event.key === 'Escape') finish(null); };
            $('duplicateModalTitle').textContent = title;
            $('duplicateText').textContent = data.detail || '';
            $('duplicateReason').value = '';
            $('duplicateError').classList.add('is-hidden');
            $('confirmDuplicateBtn').textContent = confirmLabel;
            $('duplicateReasonLabel').textContent = reasonLabel;
            $('duplicateMatches').replaceChildren(...(data.matches || []).map(m => el('li', { class: 'list-row' }, [
                el('span', { text: [m.name, m.age ? `${m.age} лет` : '', m.treatingDoctorName ? `лечащий врач: ${m.treatingDoctorName}` : '']
                    .filter(Boolean).join(' · ') }),
                el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Открыть карточку',
                    on: { click: () => finish(null, m.id) } }),
            ])));
            $('duplicateForm').addEventListener('submit', onSubmit);
            $('cancelDuplicateBtn').addEventListener('click', onCancel);
            $('closeDuplicateIconBtn').addEventListener('click', onCancel);
            document.addEventListener('keydown', onKey, true);
            ui.openModal('duplicateModal');
        });
    },

    async deletePatient(patientId) {
        const p = this.getPatient(patientId);
        const confirmed = await ui.confirm({
            title: 'Удалить пациента?',
            text: `Запись «${p ? p.name : ''}» и вся её история будут удалены безвозвратно.`,
            okLabel: 'Удалить',
        });
        if (!confirmed) return;
        try {
            await apiDelete(`/api/patients/${patientId}`);
            this.forgetDeniedPatient(patientId);
            await this.loadPatients();
            ui.toast('Пациент удалён.', 'good');
        } catch (e) {
            ui.toast('Не удалось удалить: ' + e.message, 'danger');
        }
    },

    // Активные события этапа, которые видит карточка: сервер добавит событие,
    // только если набор не изменился (иначе 409 и обновление карточки).
    seenEventIds(patientId, occIndex) {
        const p = this.getPatient(patientId);
        const occ = p && p.history ? p.history[occIndex] : null;
        return occ ? (occ.events || []).map(ev => ev.id).filter(Boolean) : [];
    },

    async addEvent(patientId, occIndex) {
        try {
            const updated = await apiPost(`/api/patients/${patientId}/history/${occIndex}/events`, {
                expectedEventIds: this.seenEventIds(patientId, occIndex), purpose: 'add',
            });
            this.replacePatientInCache(updated);
            this.refreshCurrent();
        } catch (e) {
            ui.toast('Не удалось добавить событие: ' + e.message, 'danger');
            await this.reloadPatientAfterConflict(patientId, e);
        }
    },

    // Конфликт версии или удалённое событие: показать актуальную карточку.
    async reloadPatientAfterConflict(patientId, error) {
        if (error.status !== 409 && error.status !== 404 && error.status !== 410) return;
        try {
            this.replacePatientInCache(await apiGetJson(`/api/patients/${patientId}`));
            this.refreshCurrent();
        } catch (e) { /* сообщение об исходной ошибке уже показано */ }
    },

    async removeEvent(patientId, ev, title) {
        const confirmed = await ui.confirm({
            title: 'Удалить событие?',
            text: `${title}: ${this.eventSummaryText(ev)}. Событие исчезнет из активной истории маршрута, но данные сохранятся — его можно будет восстановить в разделе «Удалённые события».`,
            okLabel: 'Удалить событие',
        });
        if (!confirmed) return;
        try {
            const updated = await apiDelete(`/api/patients/${patientId}/events/${encodeURIComponent(ev.id)}?version=${ev.version}`);
            this.replacePatientInCache(updated);
            this.refreshCurrent();
            ui.toast('Событие удалено. Его можно восстановить в разделе «Удалённые события».', 'good');
        } catch (e) {
            ui.toast('Не удалось удалить событие: ' + e.message, 'danger');
            await this.reloadPatientAfterConflict(patientId, e);
        }
    },

    async restoreEvent(patientId, ev, container) {
        try {
            const updated = await apiPost(`/api/patients/${patientId}/events/${encodeURIComponent(ev.id)}/restore`, { version: ev.version });
            this.replacePatientInCache(updated);
            this.refreshCurrent();
            ui.toast('Событие восстановлено на прежнее место в истории.', 'good');
        } catch (e) {
            ui.toast('Не удалось восстановить событие: ' + e.message, 'danger');
            if (container && container.isConnected) await this.renderDeletedEvents(patientId, container);
            await this.reloadPatientAfterConflict(patientId, e);
        }
    },

    async updateEvent(patientId, occIndex, ev, fieldName, value, node) {
        return this.submitClinicalControl(node, patientId, async (submitted, control) => {
            let target = control.eventTarget || ev;
            if (!target || !target.id) {
                const created = await apiPost(`/api/patients/${patientId}/history/${occIndex}/events`, {
                    expectedEventIds: [], purpose: 'placeholder',
                });
                target = created.history[occIndex].events.find(item => item.id === created.createdEventId);
                if (!target) throw new Error('Созданное событие не найдено. Обновите карточку пациента');
                // A confirmed placeholder must not be created a second time after PATCH failure.
                control.eventTarget = target;
            }
            const updated = await apiPatch(`/api/patients/${patientId}/events/${encodeURIComponent(target.id)}`, {field:fieldName, value:submitted, version:target.version});
            control.eventTarget = updated.history[occIndex].events.find(item => item.id === target.id);
            return updated;
        });
    },

    async updateOccurrenceNote(patientId, occIndex, value, node) {
        return this.submitClinicalControl(node, patientId, submitted =>
            apiPatch(`/api/patients/${patientId}/history/${occIndex}/note`, {note:submitted}));
    },

    async updateChecklistItem(patientId, occIndex, itemName, checked) {
        // WP-C: состояние пункта, которое видел пользователь (нет пункта — не отмечен).
        const cached = this.getPatient(patientId);
        const entry = cached && cached.history ? cached.history[occIndex] : null;
        const expected = Boolean(entry && entry.checklist && entry.checklist[itemName]);
        try {
            const updated = await apiPatch(`/api/patients/${patientId}/history/${occIndex}/checklist`,
                { item: itemName, checked, expected });
            this.replacePatientInCache(updated);
        } catch (e) {
            if (this.isStaleRecord(e)) {
                await this.reloadAfterStaleRecord(patientId, e);
                return;
            }
            ui.toast('Не удалось сохранить чек-лист: ' + e.message, 'danger');
        }
    },

    selectTimelineNode(patientId, nodeKey) {
        const select = () => {
            if (this.selectedTimelineNodes[patientId] === nodeKey) delete this.selectedTimelineNodes[patientId];
            else this.selectedTimelineNodes[patientId] = nodeKey;
            return true;
        };
        if (this.currentTab !== 'events') return this.openPatient(patientId, 'events', {prepare: select});
        select();
        this.refreshCurrent();
    },

    async advanceToStage(patientId, stage, stageLabel, options = {}) {
        const confirmed = await ui.confirm({
            title: 'Перевести на следующий этап?',
            text: `Пациент будет переведён на этап «${stageLabel}».`,
            okLabel: 'Перевести',
            danger: false,
        });
        if (!confirmed) return;
        await this.changeStage(patientId, stage, options);
    },

    /**
     * Перед переходом фиксируем фактическую дату текущего события: сервер
     * принимает её вместе со сменой этапа одним запросом.
     */
    async changeStage(id, newStage, options = {}) {
        const p = this.getPatient(id);
        if (!p || p.stage === newStage) return false;

        const occ = this.getCurrentOccurrence(p);
        let lastEventUpdate = null;
        let lastEventRef = {};

        if (occ) {
            const events = occ.events || [];
            const lastEvent = events.length ? events[events.length - 1] : { date: null, time: null };
            // Сервер запишет факт, только если это событие всё ещё последнее и не изменилось.
            if (lastEvent.id) lastEventRef = { lastEventId: lastEvent.id, lastEventVersion: lastEvent.version };
            if (!lastEvent.actualDate) {
                const stageLabel = this.stageNames[occ.stage] || occ.stage;
                const today = new Date();
                const todayValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                // Фактическое время, уже записанное правкой события, — факт: его не
                // заменяет плановое время (иначе сервер ответит 409 FACT_CONFLICT).
                const storedTime = lastEvent.actualTime || '';
                if (!lastEvent.date) {
                    lastEventUpdate = { actualDate: todayValue, actualTime: storedTime, matchedPlan: null };
                } else if (lastEvent.date === todayValue) {
                    const time = storedTime || lastEvent.time || '';
                    lastEventUpdate = { actualDate: todayValue, actualTime: time, matchedPlan: time === (lastEvent.time || '') };
                } else {
                    const answer = await ui.promptDateTime({
                        title: 'Фактическая дата события',
                        text: `Плановая дата этапа «${stageLabel}»: ${lastEvent.date}${lastEvent.time ? ' ' + lastEvent.time : ''}.`
                            + (storedTime ? ` Фактическое время уже записано: ${storedTime}.` : '')
                            + ' Укажите фактическую дату события.',
                        date: todayValue,
                        time: storedTime || lastEvent.time || '',
                    });
                    if (!answer) return false;
                    const matchedPlan = answer.date === lastEvent.date && (answer.time || '') === (lastEvent.time || '');
                    lastEventUpdate = { actualDate: answer.date, actualTime: answer.time || '', matchedPlan };
                }
            }
        }

        try {
            // expectedStage и запись маршрута: перевод из устаревшей карточки сервер отклонит (409).
            // expectedHistoryEntryId: та же запись маршрута, а не только то же
            // название этапа (этапы повторяются: exam → appointment → exam).
            const routeRef = { expectedStage: p.stage, expectedHistoryEntryId: occ ? occ.id : null };
            const body = lastEventUpdate
                ? { newStage, ...routeRef, lastEventUpdate, ...lastEventRef }
                : { newStage, ...routeRef, lastEventUpdate };
            const updated = await apiPost(`/api/patients/${id}/stage`, body);
            this.replacePatientInCache(updated);
            this.selectedTimelineNodes[id] = `occ:${updated.history.length - 1}`;
            await this.loadActivity();
            this.refreshCurrent();
            ui.toast(`Пациент переведён: ${this.stageNames[newStage]}.`, 'good');
            return true;
        } catch (e) {
            ui.toast('Не удалось изменить этап: ' + e.message, 'danger');
            await this.reloadPatientAfterConflict(id, e);
            return false;
        }
    },

    refreshCurrent() {
        if (this.sessionExpired) return;
        if (this.currentView === 'patient') this.renderPatientView();
        else if (this.currentView === 'patients') this.renderPatients();
    },

    /* ================================================== НОВЫЙ ПАЦИЕНТ (МОДАЛКА) */

    addFormState() {
        return JSON.stringify([...$('addForm').querySelectorAll('input, select, textarea')]
            .map(node => [node.id, node.value, node.checked]));
    },

    requestCloseAddModal(nextView = 'patients') {
        const focus = nextView === 'patients' ? () => $('openAddBtn') : undefined;
        return browserNavigation.navigate({screen: nextView}, {focus});
    },

    async confirmCloseAddModal(current) {
        if (this.addPatientPending || this.addClosePending) return false;
        const owner=this.user?.id, epoch=this.sessionEpoch;
        if (this.addFormState() !== this.addFormBaseline) {
            this.addClosePending = true;
            const discard = await ui.confirm({title: 'Закрыть форму?',
                text: this.addPatientUncertain
                    ? 'Запрос мог уже создать карточку. Удаление локального черновика не отменяет запись на сервере. Для проверки результата останьтесь в форме. Удалить черновик?'
                    : 'Несохраненные данные будут удалены. Продолжить?', okLabel: 'Удалить черновик'});
            this.addClosePending = false;
            if (!discard || this.sessionExpired || this.user?.id!==owner || this.sessionEpoch!==epoch || !current()) return false;
        }
        return current();
    },

    openAddModal() {
        if (!this.can('createPatients') || this.sessionExpired) return;
        if (this.addFormActive) { ui.openModal('addModal'); return; }
        // WP2.4-B: one new operation; uncertain outcomes retain this key/body.
        this.addPatientKey = newIdempotencyKey();
        this.addPatientSentBody = null;
        this.addPatientUncertain = false;
        this.addPatientDuplicateConfirmation = null;
        this.addFormActive = true;
        $('addForm').reset();
        this.clearCreateFieldErrors();
        $('addFormError').classList.add('is-hidden');
        this.clearPgiResultDateError();
        this.resetDiagnosisSelect();
        this.updateClientPathStatus();
        this.updateStageFields();
        this.setAddPatientPending(false);
        this.addFormBaseline = this.addFormState();
        ui.openModal('addModal');
    },

    clearCreateFieldErrors() {
        const removed=new Set([...$('addForm').querySelectorAll('[data-create-error]')].map(node=>node.id));
        for (const input of $('addForm').querySelectorAll('[aria-describedby]')) { const ids=input.getAttribute('aria-describedby').split(' ').filter(id=>!removed.has(id));if(ids.length)input.setAttribute('aria-describedby',ids.join(' '));else input.removeAttribute('aria-describedby'); }
        for (const node of $('addForm').querySelectorAll('[data-create-error]')) node.remove();
        for (const node of $('addForm').querySelectorAll('[aria-invalid]')) node.removeAttribute('aria-invalid');
    },

    showCreateFieldError(id) {
        const input=$(id); if (!input) return;
        const visible=input.type==='hidden' ? $('diagnosisSearch') : input;
        visible.setAttribute('aria-invalid','true');
        let message=$(id+'CreateError');
        if (!message) { message=el('p',{id:id+'CreateError',class:'field__hint field__hint--danger','data-create-error':'true',text:'Проверьте значение поля.'}); visible.after(message); }
        const described=(visible.getAttribute('aria-describedby')||'').split(' ').filter(Boolean);
        if (!described.includes(message.id)) visible.setAttribute('aria-describedby',[...described,message.id].join(' '));
    },

    resetDiagnosisSelect() {
        const search = $('diagnosisSearch');
        const hidden = $('diagnosis');
        const list = $('diagnosisOptions');
        if (search) search.value = '';
        if (hidden) hidden.value = '';
        if (list) list.replaceChildren();
        this.diagnosisComboboxItems = [];
        this.diagnosisComboboxActive = -1;
        this.setDiagnosisComboboxOpen(false);
        this.updateClientPathStatus();
    },

    onLocalizationChange() {
        $('diagnosis').value = '';
        this.updateClientPathStatus();
        this.renderDiagnosisComboboxOptions();
    },

    diagnosisLabel(code) {
        const item = this.allDiagnosisOptions().find(d => d.code === code);
        return item ? `${item.code} — ${item.label}` : code;
    },

    setDiagnosisComboboxOpen(open) {
        const search = $('diagnosisSearch');
        const list = $('diagnosisOptions');
        if (!search || !list) return;
        search.setAttribute('aria-expanded', open ? 'true' : 'false');
        list.classList.toggle('is-hidden', !open);
        if (!open) {
            search.removeAttribute('aria-activedescendant');
        }
    },

    renderDiagnosisComboboxOptions({ open = document.activeElement === $('diagnosisSearch') } = {}) {
        const search = $('diagnosisSearch');
        const list = $('diagnosisOptions');
        if (!search || !list) return;
        const localization = $('diagnosisLocalization').value;
        const query = search.value;
        const items = (localization || query.trim())
            ? this.filterDiagnosisOptions(localization, query)
            : [];
        this.diagnosisComboboxItems = items;
        if (!items.length) {
            this.diagnosisComboboxActive = -1;
            list.replaceChildren(el('div', { class: 'diagnosis-combobox__empty', text: 'Ничего не найдено' }));
            this.setDiagnosisComboboxOpen(open && !!query.trim());
            return;
        }
        if (this.diagnosisComboboxActive < 0 || this.diagnosisComboboxActive >= items.length) {
            this.diagnosisComboboxActive = 0;
        }
        list.replaceChildren(frag(items.map((item, index) => {
            const id = `diagnosis-option-${index}`;
            const active = index === this.diagnosisComboboxActive;
            return el('button', {
                type: 'button',
                class: `diagnosis-combobox__option${active ? ' is-active' : ''}`,
                id,
                role: 'option',
                'aria-selected': active ? 'true' : 'false',
                on: {
                    mousedown: (event) => event.preventDefault(),
                    click: () => this.selectDiagnosisOption(item),
                },
            }, [
                el('span', { class: 'diagnosis-combobox__code', text: item.code }),
                el('span', { class: 'diagnosis-combobox__label', text: item.label }),
            ]);
        })));
        $('diagnosisSearch').setAttribute('aria-activedescendant', `diagnosis-option-${this.diagnosisComboboxActive}`);
        this.setDiagnosisComboboxOpen(open);
    },

    selectDiagnosisOption(item) {
        $('diagnosis').value = item.code;
        $('diagnosisSearch').value = `${item.code} — ${item.label}`;
        this.setDiagnosisComboboxOpen(false);
    },

    onDiagnosisSearchInput() {
        $('diagnosis').value = '';
        this.diagnosisComboboxActive = 0;
        this.renderDiagnosisComboboxOptions({ open: true });
    },

    onDiagnosisSearchKeydown(event) {
        if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
        if (event.key === 'Escape') {
            if ($('diagnosisSearch').getAttribute('aria-expanded') !== 'true') return;
            event.preventDefault();
            event.stopPropagation();
            this.setDiagnosisComboboxOpen(false);
            return;
        }
        const items = this.diagnosisComboboxItems || [];
        if (!items.length) {
            this.renderDiagnosisComboboxOptions({ open: true });
            return;
        }
        event.preventDefault();
        if (event.key === 'ArrowDown') {
            this.diagnosisComboboxActive = (this.diagnosisComboboxActive + 1) % items.length;
            this.renderDiagnosisComboboxOptions({ open: true });
        } else if (event.key === 'ArrowUp') {
            this.diagnosisComboboxActive = (this.diagnosisComboboxActive - 1 + items.length) % items.length;
            this.renderDiagnosisComboboxOptions({ open: true });
        } else if (event.key === 'Enter') {
            this.selectDiagnosisOption(items[this.diagnosisComboboxActive]);
        }
    },

    updateStageFields() {
        const stage = $('stage').value;
        const groups = {
            primaryAppointmentGroup: stage === 'primary-appointment',
            examGroup: stage === 'exam',
            appointmentGroup: stage === 'appointment',
            consultGroup: stage === 'consult',
            treatmentGroup: stage === 'treatment' || stage === 'treatment-prep',
        };
        for (const [id, visible] of Object.entries(groups)) {
            $(id).classList.toggle('is-hidden', !visible);
        }
    },

    buildEventsFromForm(stage) {
        const value = (id) => ($(id).value || null);
        if (stage === 'primary-appointment') {
            const actualDate = value('primaryAppointmentDate');
            if (!actualDate) return [];
            return [{ date: null, time: null, treatmentType: null, actualDate, actualTime: value('primaryAppointmentTime'), matchedPlan: null, noPlan: true }];
        }
        let date = null, time = null, treatmentType = null;
        if (stage === 'exam') { date = value('examDate'); time = value('examTime'); }
        else if (stage === 'appointment') { date = value('appointmentDate'); time = value('appointmentTime'); }
        else if (stage === 'consult') { date = value('consultDate'); time = value('consultTime'); }
        else if (stage === 'treatment' || stage === 'treatment-prep') {
            date = value('treatmentDate'); time = value('treatmentTime'); treatmentType = value('treatmentType');
        }
        if (!date && !time && !treatmentType) return [];
        return [{ date, time, treatmentType }];
    },

    showFormError(message) {
        const box = $('addFormError');
        box.textContent = message;
        box.classList.remove('is-hidden');
        box.focus();
    },

    clearPgiResultDateError() {
        const input = $('pgiResultDate');
        const error = $('pgiResultDateError');
        if (!input || !error) return;
        error.textContent = '';
        error.classList.add('is-hidden');
        input.removeAttribute('aria-invalid');
        input.classList.remove('input--invalid');
    },

    showPgiResultDateError(message) {
        const input = $('pgiResultDate');
        const error = $('pgiResultDateError');
        if (!input || !error) return;
        error.textContent = message;
        error.classList.remove('is-hidden');
        input.setAttribute('aria-invalid', 'true');
        input.classList.add('input--invalid');
        input.focus();
    },

    // WP2.4-A: пока запрос создания не завершен, повторное нажатие кнопки и
    // Enter второй запрос не отправляют. Это защита от двойной отправки формы,
    // а не от сетевых повторов (ключ идемпотентности — этап WP2.4-B).
    setAddPatientPending(pending) {
        this.addPatientPending = pending;
        const button = $('submitAddBtn');
        if (!button) return;
        button.disabled = pending;
        button.setAttribute('aria-busy', pending ? 'true' : 'false');
        button.textContent = pending ? 'Добавление…' : this.addPatientUncertain ? 'Проверить результат' : 'Добавить пациента';
        for (const node of $('addForm').querySelectorAll('input,select,textarea')) node.disabled=pending || !!this.addPatientUncertain || (node.id==='doctor' && ['doctor','consilium_chair'].includes(this.user?.roleId));
        $('createSaveStatus').textContent=this.addPatientUncertain ? 'Результат запроса не подтвержден. Поля зафиксированы. Проверка повторит тот же запрос с прежним ключом. Проверьте результат сейчас, не заводите карточку заново.' : pending ? 'Сохранение. Дождитесь результата.' : '';
    },

    async addPatient(event) {
        event.preventDefault();
        if (this.addPatientPending) return;
        if (!this.can('createPatients') || this.sessionExpired) return;
        this.clearCreateFieldErrors();
        const fio = $('fio').value.trim();
        const stage = $('stage').value;
        const head = $('head').value;
        const diagnosis = $('diagnosis').value;

        if (!fio) return this.showFormError('Укажите ФИО пациента.');
        if (!diagnosis) return this.showFormError('Выберите локализацию и диагноз (код МКБ-10).');
        if (!stage) return this.showFormError('Выберите текущий этап лечения.');
        if (!head) return this.showFormError('Выберите заведующего.');
        if ($('pgiResult').value && !$('pgiResultDate').value) {
            this.showFormError('Проверьте дату результата ПГИ.');
            this.showPgiResultDateError('Укажите дату результата ПГИ.');
            return;
        }
        if (stage === 'primary-appointment' && !$('primaryAppointmentDate').value) {
            return this.showFormError('Для первичного приёма укажите фактическую дату — это обязательное поле.');
        }

        const doctorSelect = $('doctor');
        const doctorUserId = doctorSelect.value || null;
        const doctorLabel = doctorSelect.selectedOptions.length
            ? (doctorUserId ? doctorSelect.selectedOptions[0].textContent : '')
            : '';
        let payload = {
            name: fio,
            age: parseInt($('age').value, 10) || 0,
            phone: $('phone').value,
            policyNumber: $('policyNumber').value,
            priority: $('priority').value,
            stage,
            diagnosis,
            pgiResult: $('pgiResult').value,
            pgiResultDate: $('pgiResultDate').value || null,
            nosology: this.suggestedNosologyForDiagnosis(diagnosis),
            doctor: doctorLabel,
            treatingDoctorUserId: doctorUserId,
            head,
            complaint: $('complaint').value,
            events: this.buildEventsFromForm(stage),
        };
        // WP2.4-C: уже данное в этой форме подтверждение возможного дубля отправляется
        // снова — повтор после потерянного ответа идет тем же телом и тем же ключом
        // (сервер вернет уже созданную карточку). Сервер сверяет его с актуальным списком.
        if (this.addPatientDuplicateConfirmation) payload.duplicateConfirmation = this.addPatientDuplicateConfirmation;

        if (this.addPatientUncertain && this.addPatientSentBody) payload=JSON.parse(this.addPatientSentBody);
        let created;
        for (;;) {
            // Изменились отправляемые данные — это новая операция и новый ключ
            // (в том числе после подтверждения возможного дубля, WP2.4-C).
            const payloadText = JSON.stringify(payload);
            if (!this.addPatientKey || (this.addPatientSentBody !== null && this.addPatientSentBody !== payloadText)) {
                this.addPatientKey = newIdempotencyKey();
            }
            this.addPatientSentBody = payloadText;
            this.setAddPatientPending(true);
            try {
                created = await apiPostIdempotent('/api/patients', payload, this.addPatientKey);
                break;
            } catch (e) {
                // Unknown outcomes freeze the exact body/key; only an explicit replay is permitted.
                this.addPatientUncertain = this.addPatientUncertain || !e.status || e.status>=500 || e.status===401 || !!e.obsolete || e.data?.code==='ACCESS_CONTEXT_CHANGED';
                this.setAddPatientPending(false);
                const fields={name:'fio',age:'age',phone:'phone',policyNumber:'policyNumber',diagnosis:'diagnosis',treatingDoctorUserId:'doctor',head:'head',pgiResultDate:'pgiResultDate'};
                if (e.status===422 && Array.isArray(e.data?.detail)) for (const issue of e.data.detail) for (const part of issue.loc||[]) if (fields[part]) this.showCreateFieldError(fields[part]);
                if (this.isDuplicateLimitExceeded(e)) {
                    this.showFormError('Карточка не создана. ' + apiErrorMessage(e.status, e.data));
                    return;
                }
                if (this.isPossibleDuplicate(e)) {
                    const answer = await this.askDuplicateConfirmation(e.data, {
                        title: 'Возможный дубль пациента', confirmLabel: 'Создать новую карточку',
                        reasonLabel: 'Причина, по которой нужна отдельная карточка',
                    });
                    if (!answer) {
                        this.showFormError('Карточка не создана: в вашей области уже есть карточка с таким номером полиса ОМС.');
                        return;
                    }
                    this.addPatientDuplicateConfirmation = {
                        reason: answer.reason, matchedPatientIds: (e.data.matches || []).map(m => m.id),
                    };
                    payload.duplicateConfirmation = this.addPatientDuplicateConfirmation;
                    continue;
                }
                this.showFormError('Не удалось создать пациента: ' + e.message);
                return;
            }
        }
        this.setAddPatientPending(false);
        this.addPatientUncertain = false;
        this.addPatientKey = null;
        this.addPatientSentBody = null;
        this.addPatientDuplicateConfirmation = null;
        this.replacePatientInCache(created);
        ui.closeModal('addModal');
        ui.toast('Пациент добавлен.', 'good');
        try {
            await this.loadActivity();
            this.fillStaticSelects();
        } catch (e) { /* карточка уже создана; обновление сводок не критично */ }
        this.openPatient(created.id);
    },

    /* ========================================= ВОЗМОЖНЫЕ ДУБЛИ ПАЦИЕНТОВ */
    // WP2.4-D. Раздел виден только разработчику и заместителю главного врача по
    // онкологии; каждое действие сервер проверяет сам. Сведения о пациентах
    // выводятся только как текст (el(..., {text})), без разметки.

    DUPLICATE_DISCLAIMER: 'Совпадение данных не доказывает, что это один пациент.',
    // Реестр загружается страницами: сервер отдает не более 200 строк за запрос.
    DUPLICATE_PAGE_SIZE: 50,
    duplicatesOffset: 0,
    DUPLICATE_STATE_LABELS: {
        open: 'Новый',
        under_review: 'Техническая проверка',
        needs_clinical_review: 'Нужно клиническое рассмотрение',
        not_duplicate: 'Не дубль',
        resolved: 'Решено: карточка помечена ошибочной',
    },
    DUPLICATE_REASON_LABELS: {
        policy: 'Совпадает номер полиса ОМС',
        name_age: 'Совпадают ФИО и возраст',
        name_diagnosis: 'Совпадают ФИО и диагноз',
        name_nosology: 'Совпадают ФИО и локализация',
        phone: 'Совпадает телефон (слабый признак)',
    },
    DUPLICATE_STRENGTH_LABELS: { strong: 'Сильные признаки', medium: 'Средние признаки', weak: 'Слабые признаки' },
    DUPLICATE_ACTION_LABELS: {
        technical_review_started: 'Начата техническая проверка',
        technical_note: 'Технический комментарий',
        not_duplicate: 'Решение: не дубль',
        needs_clinical_review: 'Передано на клиническое рассмотрение',
        marked_erroneous: 'Карточка помечена ошибочной',
        reopened: 'Кандидат открыт повторно',
        mark_reverted: 'Пометка снята',
    },

    duplicateStateChip(state) {
        const tone = state === 'resolved' ? 'good' : state === 'needs_clinical_review' ? 'danger'
            : state === 'not_duplicate' ? 'neutral' : 'warning';
        return el('span', { class: `chip chip--${tone}`, text: this.DUPLICATE_STATE_LABELS[state] || state });
    },

    duplicatePatientLine(p) {
        if (!p || !p.exists) return el('span', { class: 'muted', text: 'Карточка отсутствует' });
        const parts = [p.name, p.age ? `${p.age} лет` : ''].filter(Boolean).join(' · ');
        return el('span', {}, [
            el('span', { text: parts }),
            p.erroneous ? el('span', { class: 'chip chip--danger', text: 'Ошибочная' }) : null,
        ]);
    },

    async renderDuplicates({ resetPage = false } = {}) {
        if (!this.can('viewDuplicateRegistry')) return this.showView('patients');
        if (resetPage) this.duplicatesOffset = 0;
        $('duplicatesScanBtn').classList.toggle('is-hidden', !this.can('scanDuplicates'));
        const list = $('duplicatesList');
        list.replaceChildren(el('p', { class: 'muted', text: 'Загрузка…' }));
        $('duplicatesDetail').replaceChildren();
        try {
            const params = new URLSearchParams();
            const state = $('duplicatesStateFilter').value;
            const strength = $('duplicatesStrengthFilter').value;
            if (state) params.set('state', state);
            if (strength) params.set('strength', strength);
            params.set('limit', String(this.DUPLICATE_PAGE_SIZE));
            params.set('offset', String(this.duplicatesOffset));
            let data = await apiGetJson(`/api/duplicates/candidates?${params}`);
            if (!data.items.length && data.total > 0 && this.duplicatesOffset > 0) {
                // Страница опустела (например, после решения по фильтру состояния) — последняя непустая.
                this.duplicatesOffset = Math.floor((data.total - 1) / this.DUPLICATE_PAGE_SIZE) * this.DUPLICATE_PAGE_SIZE;
                params.set('offset', String(this.duplicatesOffset));
                data = await apiGetJson(`/api/duplicates/candidates?${params}`);
            }
            this.duplicates = { data, currentId: null };
            this.renderDuplicatePager(data);
            this.renderDuplicateList(data);
            await this.renderErroneousCards();
        } catch (e) {
            list.replaceChildren(el('p', { class: 'muted', text: `Не удалось загрузить реестр: ${e.message}` }));
        }
    },

    renderDuplicatePager(data) {
        const first = data.total ? data.offset + 1 : 0;
        const last = data.offset + data.items.length;
        $('duplicatesPageInfo').textContent = data.total
            ? `Показаны ${first}–${last} из ${data.total}` : 'Нет кандидатов';
        $('duplicatesPrevBtn').disabled = data.offset <= 0;
        $('duplicatesNextBtn').disabled = last >= data.total;
    },

    async moveDuplicatesPage(step) {
        const data = this.duplicates && this.duplicates.data;
        if (!data) return;
        const next = this.duplicatesOffset + step * this.DUPLICATE_PAGE_SIZE;
        if (next < 0 || next >= data.total) return;
        this.duplicatesOffset = next;
        await this.renderDuplicates();
    },

    renderDuplicateList(data) {
        const stats = $('duplicatesStats');
        stats.replaceChildren(...Object.entries(data.stateCounts || {}).map(([state, count]) => el('div', { class: 'stat' }, [
            el('div', { class: 'stat__label', text: this.DUPLICATE_STATE_LABELS[state] || state }),
            el('div', { class: 'stat__value', text: String(count) }),
        ])));
        const scan = data.lastScan;
        $('duplicatesLastScan').textContent = scan
            ? `Последнее сканирование: ${this.formatDateTime(scan.startedAt)} — ${scan.status === 'completed'
                ? `проверено карточек: ${scan.patientsScanned}, пар: ${scan.pairsFound}` : `не завершено (${scan.errorCode || scan.status})`}`
            : 'Сканирование еще не выполнялось.';
        const list = $('duplicatesList');
        if (!data.items.length) {
            list.replaceChildren(el('p', { class: 'muted', text: 'Кандидатов нет.' }));
            return;
        }
        list.replaceChildren(el('ul', { class: 'list' }, data.items.map(item => el('li', { class: 'list-row' }, [
            el('div', {}, [
                el('div', {}, [this.duplicateStateChip(item.state),
                    el('span', { class: 'chip chip--neutral', text: this.DUPLICATE_STRENGTH_LABELS[item.strength] || item.strength })]),
                el('div', {}, [this.duplicatePatientLine(item.patients[0])]),
                el('div', {}, [this.duplicatePatientLine(item.patients[1])]),
                el('div', { class: 'muted', text: item.reasonCodes.map(c => this.DUPLICATE_REASON_LABELS[c] || c).join('; ') }),
                item.notFoundInLastScan ? el('div', { class: 'muted', text: 'Не найден при последнем сканировании' }) : null,
                item.signalsChangedAt ? el('div', { class: 'muted', text: 'Признаки изменились после решения — нужна повторная оценка' }) : null,
            ]),
            el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Открыть',
                on: { click: () => this.openDuplicateCandidate(item.id) } }),
        ]))));
    },

    async openDuplicateCandidate(id) {
        const box = $('duplicatesDetail');
        box.replaceChildren(el('p', { class: 'muted', text: 'Загрузка…' }));
        try {
            const data = await apiGetJson(`/api/duplicates/candidates/${encodeURIComponent(id)}`);
            this.duplicates.currentId = id;
            this.renderDuplicateDetail(data);
            box.scrollIntoView({ block: 'start' });
        } catch (e) {
            box.replaceChildren(el('p', { class: 'muted', text: `Не удалось открыть кандидата: ${e.message}` }));
        }
    },

    duplicateCardBlock(card, data) {
        if (!card.exists) return el('div', { class: 'panel panel--pad' }, el('p', { class: 'muted', text: 'Карточка отсутствует.' }));
        const allowed = data.allowedActions || {};
        const rows = [
            ['ФИО', card.name], ['Возраст', card.age ? String(card.age) : '—'], ['Полис ОМС', card.maskedPolicy || '—'],
            ['Диагноз', card.diagnosis || '—'], ['Этап', this.stageNames[card.stage] || card.stage || '—'], ['Лечащий врач', card.treatingDoctorName || '—'],
            ['Отделение', card.departments || '—'], ['Создана', this.formatDateTime(card.createdAt)],
        ];
        const allDeps = card.dependencies || [];
        const deps = allDeps.filter(d => d.kind !== 'access');
        const accessDeps = allDeps.filter(d => d.kind === 'access');
        const blocks = [
            el('div', {}, rows.map(([k, v]) => el('p', {}, [el('span', { class: 'muted', text: k + ': ' }), el('span', { text: v })]))),
            card.erroneous ? el('div', { class: 'alert alert--danger' }, [
                el('strong', { text: 'Карточка помечена ошибочной' }),
                el('p', { text: `С ${this.formatDateTime(card.markedAt)}. Исключена из активной работы; история сохранена.` }),
            ]) : null,
            deps.length ? el('div', { class: 'alert alert--warning' }, [
                el('strong', { text: 'Есть значимые клинические зависимости — пометка ошибочной невозможна' }),
                el('ul', {}, deps.map(d => el('li', { text: `${d.label}: ${d.count}` }))),
                el('p', { text: 'Нужно отдельное клиническое рассмотрение. Медицинские записи этой карточки не изменяются.' }),
            ]) : el('p', { class: 'muted', text: 'Значимых клинических зависимостей нет.' }),
            accessDeps.length ? el('div', { class: 'alert alert--warning' }, [
                el('strong', { text: 'Действует мобильный доступ пациента — пометка ошибочной невозможна' }),
                el('p', { text: 'Сначала отключите мобильный доступ в карточке пациента. При пометке он не отключается автоматически.' }),
            ]) : null,
        ];
        if ((allowed.markPatientIds || []).includes(card.id)) {
            blocks.push(el('button', { type: 'button', class: 'btn btn--danger', text: 'Пометить эту карточку ошибочной',
                on: { click: () => this.markDuplicateCard(data, card) } }));
        }
        if ((allowed.unmarkPatientIds || []).includes(card.id)) {
            blocks.push(el('button', { type: 'button', class: 'btn btn--ghost', text: 'Снять пометку',
                on: { click: () => this.unmarkErroneousCard(card.id, card.markId) } }));
        }
        return el('div', { class: 'panel panel--pad' }, blocks);
    },

    renderDuplicateDetail(data) {
        const allowed = data.allowedActions || {};
        const actions = [];
        const act = (label, handler, cls = 'btn btn--ghost') => el('button', { type: 'button', class: cls, text: label, on: { click: handler } });
        if (allowed.technicalStart) actions.push(act('Начать техническую проверку', () => this.duplicateTechnical(data, 'start')));
        if (allowed.technicalNote) actions.push(act('Технический комментарий', () => this.duplicateTechnical(data, 'note')));
        if (allowed.notDuplicate) actions.push(act('Не дубль', () => this.duplicateDecision(data, 'not_duplicate')));
        if (allowed.needsClinicalReview) actions.push(act('Передать на клиническое рассмотрение', () => this.duplicateDecision(data, 'needs_clinical_review')));
        if (allowed.reopen) actions.push(act('Открыть повторно', () => this.duplicateDecision(data, 'reopen')));
        const warnings = [];
        if (data.signalsOutdated) warnings.push('Признаки совпадения изменились после сканирования: сейчас — '
            + ((data.currentReasonCodes || []).map(c => this.DUPLICATE_REASON_LABELS[c] || c).join('; ') || 'совпадений нет')
            + '. Нужна повторная оценка.');
        if (data.cardsChangedSinceScan) warnings.push('Данные карточек изменились после сканирования.');
        if (data.signalsChangedAt) warnings.push('Признаки изменились после принятого решения — нужна повторная оценка.');
        const confirmations = data.confirmations || null;
        $('duplicatesDetail').replaceChildren(el('div', { class: 'panel panel--pad' }, [
            el('h2', { class: 'panel__title', text: 'Кандидат в дубли' }),
            el('p', { class: 'alert alert--info', text: data.disclaimer || this.DUPLICATE_DISCLAIMER }),
            el('div', {}, [this.duplicateStateChip(data.state),
                el('span', { class: 'chip chip--neutral', text: this.DUPLICATE_STRENGTH_LABELS[data.strength] || data.strength })]),
            el('p', { text: `Признаки при сканировании: ${data.reasonCodes.map(c => this.DUPLICATE_REASON_LABELS[c] || c).join('; ')}` }),
            ...warnings.map(w => el('p', { class: 'alert alert--warning', text: w })),
            el('div', { class: 'grid-2' }, data.patients.map(card => this.duplicateCardBlock(card, data))),
            actions.length ? el('div', { class: 'pagehead__actions' }, actions) : null,
            confirmations ? el('div', {}, [
                el('h3', { text: 'Подтверждения возможного дубля при создании или изменении полиса' }),
                confirmations.length ? el('ul', { class: 'list' }, confirmations.map(c => el('li', { class: 'list-row' }, [
                    el('span', { text: `${this.formatDateTime(c.createdAt)} · ${c.by || '—'} · совпадений: ${c.matchedPatientIds.length}` }),
                    el('span', { class: 'muted', dataset: { reasonFor: c.id } }),
                    el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Показать причину (запись в журнал)',
                        on: { click: (event) => this.showConfirmationReason(data.id, c.id, event.currentTarget) } }),
                ]))) : el('p', { class: 'muted', text: 'Подтверждений нет.' }),
            ]) : null,
            el('h3', { text: 'История разбора' }),
            data.reviews.length ? el('ul', { class: 'list' }, data.reviews.map(r => el('li', { class: 'list-row' }, [
                el('span', { text: `${this.formatDateTime(r.at)} · ${r.by || '—'} · ${this.DUPLICATE_ACTION_LABELS[r.action] || r.action}` }),
                r.reason ? el('span', { class: 'muted', text: r.reason }) : null,
                r.dependencies.length ? el('span', { class: 'muted', text: `Зависимости: ${r.dependencies.length}` }) : null,
            ]))) : el('p', { class: 'muted', text: 'Действий еще не было.' }),
            data.marks.length ? el('h3', { text: 'Пометки карточек' }) : null,
            data.marks.length ? el('ul', { class: 'list' }, data.marks.map(m => el('li', { class: 'list-row' }, [
                el('span', { text: `${this.formatDateTime(m.at)} · ${m.by || '—'} · ${m.action === 'mark' ? 'пометка' : 'снятие пометки'}` }),
                el('span', { class: 'muted', text: m.reason }),
            ]))) : null,
        ]));
    },

    askRegistryReason({ title, text, okLabel, required = true, label = 'Причина' }) {
        return new Promise(resolve => {
            $('registryReasonTitle').textContent = title;
            $('registryReasonText').textContent = text;
            $('registryReasonInput').value = '';
            $('registryReasonLabel').textContent = required ? `${label} (обязательно)` : label;
            $('registryReasonInput').required = required;
            $('registryReasonError').classList.add('is-hidden');
            $('registryReasonOkBtn').textContent = okLabel;
            const form = $('registryReasonForm');
            const finish = (value) => {
                form.removeEventListener('submit', onSubmit);
                $('registryReasonCancelBtn').removeEventListener('click', onCancel);
                ui.pendingRegistryReasonCancel = null;
                ui.closeModal('registryReasonModal');
                resolve(value);
            };
            const onSubmit = (event) => {
                event.preventDefault();
                const value = $('registryReasonInput').value.trim();
                if (required && !value) {
                    $('registryReasonError').textContent = 'Укажите причину.';
                    $('registryReasonError').classList.remove('is-hidden');
                    return;
                }
                finish(value);
            };
            const onCancel = () => finish(null);
            form.addEventListener('submit', onSubmit);
            $('registryReasonCancelBtn').addEventListener('click', onCancel);
            ui.pendingRegistryReasonCancel = onCancel;
            ui.openModal('registryReasonModal');
        });
    },

    async registryAction(request, success, reopenId) {
        try {
            await request();
            ui.toast(success, 'good');
        } catch (e) {
            ui.toast(e.message, 'danger');
        }
        await this.renderDuplicates();
        if (reopenId) await this.openDuplicateCandidate(reopenId);
    },

    async duplicateTechnical(data, action) {
        const comment = await this.askRegistryReason({
            title: action === 'start' ? 'Начать техническую проверку' : 'Технический комментарий',
            text: 'Технический разбор не является клиническим решением.',
            okLabel: 'Сохранить', required: action === 'note', label: 'Технический комментарий',
        });
        if (comment === null) return;
        await this.registryAction(() => apiPost(`/api/duplicates/candidates/${encodeURIComponent(data.id)}/technical-review`,
            { action, comment: comment || null, expectedVersion: data.version }), 'Сохранено.', data.id);
    },

    async duplicateDecision(data, decision) {
        const titles = { not_duplicate: 'Решение: не дубль', needs_clinical_review: 'Передать на клиническое рассмотрение',
            reopen: 'Открыть кандидата повторно' };
        const reason = await this.askRegistryReason({ title: titles[decision], text: this.DUPLICATE_DISCLAIMER + ' Укажите причину решения.',
            okLabel: 'Сохранить решение' });
        if (!reason) return;
        await this.registryAction(() => apiPost(`/api/duplicates/candidates/${encodeURIComponent(data.id)}/decision`,
            { decision, reason, expectedVersion: data.version }), 'Решение сохранено.', data.id);
    },

    async markDuplicateCard(data, card) {
        const reason = await this.askRegistryReason({
            title: 'Пометить карточку ошибочной',
            text: `Карточка «${card.name}» будет исключена из активной работы и станет доступна только для чтения. `
                + 'Она не удаляется, история не переносится. Сервер заново проверит клинические зависимости.',
            okLabel: 'Пометить ошибочной',
        });
        if (!reason) return;
        await this.registryAction(() => apiPost(`/api/duplicates/candidates/${encodeURIComponent(data.id)}/mark`,
            { patientId: card.id, reason, expectedVersion: data.version }), 'Карточка помечена ошибочной.', data.id);
    },

    async unmarkErroneousCard(patientId, markId) {
        const reason = await this.askRegistryReason({ title: 'Снять пометку «ошибочная»',
            text: 'Карточка вернется в обычную работу. История пометки сохранится.', okLabel: 'Снять пометку' });
        if (!reason) return;
        await this.registryAction(() => apiPost(`/api/duplicates/erroneous/${encodeURIComponent(patientId)}/unmark`,
            { markId, reason }), 'Пометка снята.');
    },

    async showConfirmationReason(candidateId, confirmationId, button) {
        try {
            const result = await apiPost(`/api/duplicates/candidates/${encodeURIComponent(candidateId)}/confirmations/`
                + `${encodeURIComponent(confirmationId)}/reason`);
            const target = button.parentElement.querySelector(`[data-reason-for="${CSS.escape(confirmationId)}"]`);
            if (target) target.textContent = result.reason;
            button.remove();
        } catch (e) {
            ui.toast(`Не удалось показать причину: ${e.message}`, 'danger');
        }
    },

    async runDuplicateScan() {
        if (!this.can('scanDuplicates')) return;
        const btn = $('duplicatesScanBtn');
        btn.disabled = true;
        try {
            const result = await apiPost('/api/duplicates/scans');
            ui.toast(`Сканирование завершено: карточек ${result.patientsScanned}, пар ${result.pairsFound}, новых ${result.pairsNew}.`, 'good');
        } catch (e) {
            ui.toast(`Сканирование не выполнено: ${e.message}`, 'danger');
        } finally {
            btn.disabled = false;
        }
        await this.renderDuplicates();
    },

    async renderErroneousCards() {
        const box = $('duplicatesErroneous');
        const data = await apiGetJson('/api/duplicates/erroneous');
        if (!data.items.length) {
            box.replaceChildren(el('p', { class: 'muted', text: 'Помеченных ошибочными карточек нет.' }));
            return;
        }
        box.replaceChildren(el('ul', { class: 'list' }, data.items.map(card => el('li', { class: 'list-row' }, [
            el('div', {}, [
                this.duplicatePatientLine(card),
                el('div', { class: 'muted', text: `Помечена ${this.formatDateTime(card.markedAt)} · ${card.markedBy || '—'}` }),
                el('div', { class: 'muted', text: card.markReason }),
            ]),
            el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Кандидат',
                on: { click: () => this.openDuplicateCandidate(card.candidateId) } }),
            this.can('markErroneous') ? el('button', { type: 'button', class: 'btn btn--ghost btn--sm', text: 'Снять пометку',
                on: { click: () => this.unmarkErroneousCard(card.id, card.markId) } }) : null,
        ]))));
    },

    /* ========================================= ОНКОЛОГИЧЕСКИЙ КОНСИЛИУМ */

    malignantDiagnosisOptions() {
        const unique = new Map();
        for (const item of this.allDiagnosisOptions()) {
            const code = String(item.code || '').trim().toUpperCase();
            if (!/^C(?:0[0-9]|[1-8][0-9]|9[0-7])(?:\.[0-9A-Z]{1,2})?$/.test(code)) continue;
            if (!unique.has(code)) unique.set(code, { code, label: item.label });
        }
        return [...unique.values()].sort((a, b) => a.code.localeCompare(b.code, 'ru', { numeric: true }));
    },

    validConsiliumDiagnosis(value, required = true) {
        const normalized = String(value || '').trim().toUpperCase();
        if (!normalized && !required) return '';
        return /^C(?:0[0-9]|[1-8][0-9]|9[0-7])(?:\.[0-9A-Z]{1,2})?$/.test(normalized)
            ? normalized : null;
    },

    // «Сегодня» консилиума — по времени учреждения (Europe/Moscow), а не по
    // часам и поясу компьютера сотрудника (WP2.3-B2). Без базы поясов в браузере —
    // фиксированное смещение UTC+3, как на сервере.
    consiliumToday() {
        try {
            return new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(new Date());
        } catch (error) {
            return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
        }
    },

    // WP2.3-B3 (B3-03): полные дата и время по Europe/Moscow для консилиума,
    // оформленного задним числом, и его причин — независимо от пояса компьютера
    // и давности. Общий formatDateTime() не меняется: он скрывает часы у старых
    // меток и показывает время в поясе браузера. Без базы поясов — UTC+3.
    formatMoscowDateTime(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        const pad = value => String(value).padStart(2, '0');
        let parts;
        try {
            parts = {};
            new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
            }).formatToParts(d).forEach(part => { parts[part.type] = part.value; });
        } catch (error) {
            const m = new Date(d.getTime() + 3 * 3600 * 1000);
            parts = {
                day: pad(m.getUTCDate()), month: pad(m.getUTCMonth() + 1), year: String(m.getUTCFullYear()),
                hour: pad(m.getUTCHours()), minute: pad(m.getUTCMinutes()),
            };
        }
        return `${parts.day}.${parts.month}.${parts.year}, ${parts.hour}:${parts.minute} МСК`;
    },

    localDateISO(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    },

    consiliumSelectedGroups(role) {
        const key = role === 'chair' ? 'chairGroupFilters' : 'groupFilters';
        const selected = this.consilium[key];
        return selected === null
            ? (this.consilium.meta?.groups || []).map(group => group.value)
            : (selected || []);
    },

    renderConsiliumGroupPicker(role) {
        if (!this.consilium.meta) return;
        const chair = role === 'chair';
        const key = chair ? 'chairGroupFilters' : 'groupFilters';
        const optionsId = chair ? 'consiliumChairGroupOptions' : 'consiliumDoctorGroupOptions';
        const summaryId = chair ? 'consiliumChairGroupSummary' : 'consiliumDoctorGroupSummary';
        const groups = this.consilium.meta.groups || [];
        const selected = this.consilium[key];
        const allSelected = selected === null;
        const selectedLabels = groups
            .filter(group => (selected || []).includes(group.value))
            .map(group => group.label);
        $(summaryId).textContent = allSelected
            ? 'Все консилиумные группы'
            : (!selectedLabels.length
                ? 'Группы не выбраны'
                : (selectedLabels.length === 1 ? selectedLabels[0] : `Выбрано групп: ${selectedLabels.length}`));

        const applySelection = (next) => {
            this.consilium[key] = next;
            this.renderConsiliumGroupPicker(role);
            if (chair) this.renderConsilium();
            else this.renderConsiliumSchedule();
        };
        $(optionsId).replaceChildren(frag([
            el('label', { class: 'consilium-group-picker__option consilium-group-picker__option--all' }, [
                el('input', {
                    type: 'checkbox', checked: allSelected,
                    on: { change: (event) => applySelection(event.target.checked ? null : []) },
                }),
                el('span', { text: 'Все консилиумные группы' }),
            ]),
            ...groups.map(group => el('label', { class: 'consilium-group-picker__option' }, [
                el('input', {
                    type: 'checkbox',
                    checked: allSelected || (selected || []).includes(group.value),
                    on: { change: (event) => {
                        const current = new Set(allSelected ? groups.map(item => item.value) : (selected || []));
                        if (event.target.checked) current.add(group.value);
                        else current.delete(group.value);
                        applySelection(current.size === groups.length ? null : [...current]);
                    } },
                }),
                el('span', { text: group.label }),
            ])),
        ]));
    },

    consiliumScheduleOpenedDates() {
        const group = $('consiliumScheduleGroup').value;
        return new Set((this.consilium.schedule || [])
            .filter(slot => slot.consiliumGroup === group)
            .map(slot => slot.scheduledDate));
    },

    renderConsiliumScheduleCalendar() {
        if (!this.can('consiliumChair')) return;
        const today = this.consiliumToday();
        const selected = $('consiliumScheduleDate').value;
        const baseValue = this.consilium.scheduleCalendarMonth || selected || today;
        const [year, month] = baseValue.split('-').map(Number);
        const firstDay = new Date(year, month - 1, 1);
        this.consilium.scheduleCalendarMonth = this.localDateISO(firstDay);
        $('consiliumScheduleMonthLabel').textContent = firstDay.toLocaleDateString('ru-RU', {
            month: 'long', year: 'numeric',
        });
        const [todayYear, todayMonth] = today.split('-').map(Number);
        const currentMonth = new Date(todayYear, todayMonth - 1, 1);
        $('consiliumSchedulePrevMonthBtn').disabled = firstDay <= currentMonth;
        const openedDates = this.consiliumScheduleOpenedDates();
        const leading = (firstDay.getDay() + 6) % 7;
        const daysInMonth = new Date(year, month, 0).getDate();
        const cells = Array.from({ length: leading }, () => el('span', { class: 'consilium-date-picker__blank' }));
        for (let day = 1; day <= daysInMonth; day += 1) {
            const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const isPast = value < today;
            const isOpened = openedDates.has(value);
            cells.push(el('button', {
                type: 'button',
                class: `consilium-date-picker__day${value === today ? ' is-today' : ''}${value === selected ? ' is-selected' : ''}`,
                text: String(day),
                disabled: isPast,
                title: isPast ? 'Дата уже прошла' : (isOpened ? 'Расписание для этой группы уже открыто' : ''),
                on: { click: () => {
                    $('consiliumScheduleDate').value = value;
                    $('consiliumScheduleDateButton').textContent = new Date(`${value}T12:00:00`).toLocaleDateString('ru-RU');
                    $('consiliumScheduleDatePicker').classList.add('is-hidden');
                    $('consiliumScheduleDateButton').setAttribute('aria-expanded', 'false');
                    this.renderConsiliumScheduleCalendar();
                } },
            }));
        }
        $('consiliumScheduleCalendarDays').replaceChildren(frag(cells));
    },

    syncConsiliumScheduleDateForGroup() {
        const selected = $('consiliumScheduleDate').value;
        const today = this.consiliumToday();
        if (selected && selected < today) {
            $('consiliumScheduleDate').value = '';
            $('consiliumScheduleDateButton').textContent = 'Выберите дату';
        }
        this.renderConsiliumScheduleCalendar();
    },

    consiliumGridReady(generation = this.consilium.gridGeneration) {
        return !this.sessionExpired && this.can('accessConsilium') && this.consilium.loaded
            && !this.consilium.loading && this.consilium.readState === 'ready'
            && this.consilium.snapshotEpoch === this.sessionEpoch && generation === this.consilium.gridGeneration;
    },

    setConsiliumReadPresentation(state) {
        $('consiliumReviewWorkspace').classList.add('is-hidden');
        if(state!=='ready') {this.beginRead('consilium-analytics');$('consiliumAnalyticsBody').replaceChildren();$('consiliumAnalyticsState').textContent='Обновите показатели для получения актуальных серверных данных.'; $('consiliumFavorites').classList.add('is-hidden');$('consiliumFavoritesList').replaceChildren(); }
        const ready = state === 'ready';
        this.consilium.readState = state;
        if (state==='loading') { $('consiliumLoadState').textContent='Загрузка расписания…';$('consiliumLoadState').classList.remove('is-hidden'); }
        if (!ready) this.consilium.gridGeneration = (this.consilium.gridGeneration || 0) + 1;
        const roots = ['consiliumChairScheduleWrap','consiliumDoctorScheduleWrap'];
        const focused = document.activeElement;
        if (!ready && !ui.openModals.length && roots.some(id => $(id).contains(focused))) $('consiliumRefreshBtn').focus();
        for (const id of roots) {
            $(id).inert = !ready;
            if (!ready) for (const button of $(id).querySelectorAll('button')) button.disabled = true;
        }
        $('consiliumScheduleEditor').setAttribute('aria-busy',state === 'loading' ? 'true' : 'false');
        $('consiliumStatsRow').classList.toggle('is-hidden',!ready);
        if (!ready) {
            $('consiliumRegistries').classList.add('is-hidden');
            $('consiliumRegistries').inert = true;
            $('consiliumAppointmentsPanel').classList.add('is-hidden');
            // A separate active clinical form retains its own input and original version.
            for (const id of ['consiliumDetailsModal','consiliumModal','consiliumDecisionModal']) {
                const modal=$(id); if (modal.hidden) continue;
                let notice=modal.querySelector('[data-consilium-read-notice]');
                if (!notice) { notice=el('p',{class:'alert','data-consilium-read-notice':'true',role:'status'});modal.querySelector('.modal__body').prepend(notice); }
                notice.textContent='Открытые данные и ввод относятся к предыдущему чтению расписания. Перед новым действием проверьте актуальность; автоматической записи нет.';
            }
        } else $('consiliumRegistries').inert = false;
        if (state === 'error') {
            $('consiliumLoadState').textContent='Не удалось обновить расписание. Повторите действие после проверки доступа.';
            $('consiliumLoadState').classList.remove('is-hidden');
            $('consiliumStatsRow').replaceChildren();
            for (const body of $('consiliumRegistries').querySelectorAll('tbody')) body.replaceChildren();
            this.consilium.registries = null;
        }
        this.syncConsiliumReviewState();
    },

    async loadConsilium() {
        const version=this.beginRead('consilium-load');
        const epoch=this.sessionEpoch;
        const current=()=>epoch===this.sessionEpoch&&this.isCurrentRead('consilium-load',version);
        const check=()=>{if(!current()){const error=new Error('Ответ расписания устарел');error.obsolete=true;throw error;}};
        this.setConsiliumReadPresentation('loading');
        this.consilium.loading = true;
        try {
            // Publish one complete client snapshot, never partial or superseded reads.
            const meta=this.consilium.meta || await apiGetJson('/api/consilium/meta');check();
            const chair=this.can('consiliumChair');
            const data=await apiGetJson('/api/consilium/appointments');check();
            const bookedData=this.can('bookConsilium')
                ? await apiGetJson('/api/consilium/booked-patients') : {patientIds:[]};check();
            const scheduleData=await apiGetJson('/api/consilium/schedule');check();
            const schedule=scheduleData.slots || [];
            const dates=[...new Set(schedule.map(slot=>slot.scheduledDate))].sort();
            const fallback=dates.find(date=>date>=this.consiliumToday()) || dates[0] || this.consiliumToday();
            const dateFilter=this.consilium.dateFilter || fallback;
            let registries=null;
            if (this.can('consiliumChair')) {
                const query = `?date=${encodeURIComponent(dateFilter)}`;
                registries=await apiGetJson(`/api/consilium/registries${query}`);
            }
            check();
            Object.assign(this.consilium,{snapshotEpoch:epoch,meta,appointments:data.appointments || [],blockedPatientIds:bookedData.patientIds || [],schedule});
            if(chair){
                this.consilium.registries=registries;
                this.consilium.dateFilter=dateFilter;
                $('consiliumScheduleGroup').replaceChildren(frag(meta.groups.map(group=>option(group.value,group.label))));
                this.syncConsiliumScheduleDateForGroup();this.renderConsiliumGroupPicker('chair');
                $('consiliumDateFilter').value=dateFilter;
            }else{
                this.renderConsiliumGroupPicker('doctor');
                const focused=this.consilium.focusId && this.consilium.appointments.find(item=>item.id===this.consilium.focusId);
                if(focused){this.consilium.doctorDate=focused.scheduledDate;this.consilium.groupFilters=[focused.consiliumGroup];this.renderConsiliumGroupPicker('doctor');}
                this.consilium.doctorDate ||= fallback;
                $('consiliumDoctorDate').value=this.consilium.doctorDate;
            }
            this.consilium.loaded=true;
        } catch(error) {
            if(current()&&!error.obsolete){
                this.consilium.loaded=false;this.consilium.schedule=[];this.consilium.appointments=[];
                $('consiliumChairScheduleTables').replaceChildren();$('consiliumDoctorScheduleTables').replaceChildren();
                this.setConsiliumReadPresentation('error');
            }
            throw error;
        } finally {
            if(current())this.consilium.loading=false;
        }
    },

    formatConsiliumDate(date, time) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
        const formatted = match ? `${match[3]}.${match[2]}.${match[1]}` : (date || '—');
        return `${formatted}, ${time || '—'}`;
    },

    renderConsiliumStats(rows = this.consilium.appointments || []) {
        const today = this.consiliumToday();
        const upcoming = rows.filter(item => item.scheduledDate >= today).length;
        const groups = new Set(rows.map(item => item.consiliumGroup)).size;
        const signed = rows.filter(item => item.status === 'signed').length;
        const withSpecialists = rows.filter(item => item.needsSurgeon || item.needsRadiotherapist).length;
        const stat = (label, value, meta) => el('div', { class: 'stat' }, [
            el('div', { class: 'stat__label', text: label }),
            el('div', { class: 'stat__value', text: String(value) }),
            el('div', { class: 'stat__meta', text: meta }),
        ]);
        $('consiliumStatsRow').replaceChildren(frag([
            stat('Всего записей', rows.length, this.can('consiliumChair') ? 'общая очередь консилиума' : 'ваши пациенты'),
            stat('Предстоящие', upcoming, 'сегодня и позже'),
            stat('Группы', groups, 'задействовано'),
            this.can('consiliumChair')
                ? stat('Подписано', signed, 'решение председателя')
                : stat('Нужны специалисты', withSpecialists, 'хирург или лучевой терапевт'),
        ]));
    },

    // Врач правит и удаляет запись, пока председатель не начал рассмотрение;
    // сервер проверяет то же самое и отвечает 409.
    consiliumEditable(item) {
        return ['recorded', 'needs_revision', 'revised'].includes(item.status);
    },

    renderConsiliumStatus(item) {
        return frag([
            el('span', { class: `consilium-status consilium-status--${item.status}`, text: item.statusLabel }),
            item.revisionComment ? el('div', { class: 'consilium-revision-comment', text: `Комментарий председателя: ${item.revisionComment}` }) : null,
            item.treatmentTypeLabel ? el('div', {
                class: 'consilium-treatment',
                text: item.treatmentScheme
                    ? `${item.treatmentTypeLabel}: ${item.treatmentSchemeCode ? item.treatmentSchemeCode + ' — ' : ''}${item.treatmentScheme}`
                    : item.treatmentTypeLabel,
            }) : null,
        ]);
    },

    renderConsiliumChairActions(item) {
        const generation=this.consilium.gridGeneration, epoch=this.sessionEpoch;
        const allowed=()=>epoch===this.sessionEpoch && this.consiliumGridReady(generation) && this.can('decideConsilium');
        return el('div', { class: 'consilium-actions' }, [
            item.status === 'signed' || item.status === 'needs_revision'
                ? null
                : el('button', {
                    type: 'button', class: 'btn btn--primary btn--sm',
                    text: item.status === 'in_review' ? 'Продолжить рассмотрение'
                        : item.status === 'revised' ? 'Рассмотреть повторно' : 'Рассмотреть',
                    on: { click: () => { if(allowed()) this.openConsiliumDecision(item.id); } },
                }),
            !this.can('useConsiliumFavorites') ? null : el('button', {
                type: 'button',
                class: `btn btn--ghost btn--sm${item.isFavorite ? ' is-favorite' : ''}`,
                text: item.isFavorite ? '★ В избранном' : '☆ В избранное',
                on: { click: () => {if(epoch===this.sessionEpoch&&this.consiliumGridReady(generation))this.toggleConsiliumFavorite(item);} },
            }),
        ]);
    },

    async renderConsilium({ reuseData = false } = {}) {
        const version=this.beginRead('consilium-render'),epoch=this.sessionEpoch;
        const current=()=>epoch===this.sessionEpoch&&this.isCurrentRead('consilium-render',version);
        const body = $('consiliumBody');
        const empty = $('consiliumEmpty');
        const chair = this.can('consiliumChair');
        const loadState=$('consiliumLoadState');
        loadState.textContent='Загрузка расписания…';loadState.classList.remove('is-hidden');
        this.setConsiliumReadPresentation('loading');
        $('consiliumAppointmentsPanel').classList.add('is-hidden');
        if (!this.consilium.loaded) {
            body.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'muted', text: 'Загрузка записей…' })));
        }
        try {
            if (!reuseData || !this.consilium.loaded) await this.loadConsilium();
        } catch (error) {
            if (!current() || error.obsolete) return;
            body.replaceChildren();
            this.consilium.loaded=false;this.consilium.schedule=[];this.consilium.appointments=[];
            $('consiliumChairScheduleTables').replaceChildren();$('consiliumDoctorScheduleTables').replaceChildren();
            this.setConsiliumReadPresentation('error');
            loadState.textContent='Не удалось обновить расписание. Повторите действие после проверки доступа.';
            empty.textContent = `Не удалось загрузить записи: ${error.message}`;
            empty.classList.remove('is-hidden');
            return;
        }

        if(!current())return;
        loadState.classList.add('is-hidden');this.setConsiliumReadPresentation('ready');
        const allRows = this.consilium.appointments || [];
        const showRecords = !chair && this.can('bookConsilium');
        $('consiliumAppointmentsPanel').classList.toggle('is-hidden', !showRecords);
        let rows = allRows;
        if (chair) {
            const selectedChairGroups = new Set(this.consiliumSelectedGroups('chair'));
            rows = allRows.filter(item =>
                item.scheduledDate === this.consilium.dateFilter
                && selectedChairGroups.has(item.consiliumGroup)
            );
        }
        const search = String(this.consilium.search || '').trim().toLowerCase();
        if (search) {
            rows = rows.filter(item =>
                String(item.patientName || '').toLowerCase().includes(search)
                || String(item.policyNumber || '').toLowerCase().includes(search)
            );
        }
        this.renderConsiliumStats(rows);
        this.renderConsiliumReviewWorkspace(rows);
        empty.textContent = chair
            ? 'В общей очереди консилиума пока нет записей.'
            : (this.patientPage?.summary.total
                ? 'Записей пока нет. Нажмите «Запись», чтобы направить пациента на консилиум.'
                : 'Сначала добавьте пациента в разделе «Пациенты».');
        if (chair && !rows.length) {
            empty.textContent = 'На выбранный день в этой консилиумной группе записей нет.';
        } else if (!chair && !rows.length) {
            empty.textContent = 'Вы пока не записали пациентов на консилиум.';
        }
        empty.classList.toggle('is-hidden', rows.length > 0);
        body.replaceChildren(frag(rows.map(item => {
            const specialists = [];
            if (item.needsSurgeon) specialists.push('Хирург');
            if (item.needsRadiotherapist) specialists.push('Лучевой терапевт');
            if (item.additionalParticipant) specialists.push(item.additionalParticipant);
            const diagnoses = item.additionalDiagnosis
                ? `${item.primaryDiagnosis}; ${item.additionalDiagnosis}`
                : item.primaryDiagnosis;
            return el('tr', {
                id: `consilium-row-${item.id}`,
                class: this.consilium.focusId === item.id ? 'consilium-row--focused' : '',
            }, [
                el('td', {class: 'cell-when', 'data-label': 'Дата и время'}, [
                    el('div', { class: 'cell-when__time', text: this.formatConsiliumDate(item.scheduledDate, item.scheduledTime) }),
                    el('div', { class: 'person__meta', text: item.hasBenefit ? 'Есть льгота' : 'Без льготы' }),
                ]),
                el('td', {'data-label': 'Пациент'}, [
                    el('button', {
                        type: 'button', class: 'consilium-patient-button', text: item.patientName,
                        on: { click: () => this.openConsiliumDetails(item) },
                    }),
                    el('div', { class: 'person__meta', text: item.treatingDoctorName }),
                    el('div', { class: 'person__meta', text: `Полис ОМС: ${item.policyNumber || 'не указан'}` }),
                    item.comment ? el('div', { class: 'consilium-comment', text: item.comment }) : null,
                    item.outsideSchedule ? el('span', { class: 'chip chip--warning', text: 'Вне расписания' }) : null,
                    item.backdated ? el('span', { class: 'chip chip--neutral', text: 'Оформлено задним числом' }) : null,
                ]),
                el('td', {'data-label': 'Группа', text: item.consiliumGroupLabel}),
                el('td', {class: 'consilium-diagnosis', 'data-label': 'Диагноз', text: diagnoses}),
                el('td', {'data-label': 'Участники'}, specialists.length
                    ? frag(specialists.map(label => el('span', { class: 'chip chip--neutral consilium-chip', text: label })))
                    : el('span', { class: 'muted', text: 'Не указаны' })),
                el('td', {'data-label': 'Статус'}, this.renderConsiliumStatus(item)),
                el('td', {class: 'cell-actions', 'data-label': 'Действия'}, chair
                    ? this.renderConsiliumChairActions(item)
                    : (this.can('editPatients') && this.consiliumEditable(item)
                        ? el('button', {
                            type: 'button', class: 'btn btn--ghost btn--sm', text: 'Изменить',
                            on: { click: () => this.openConsiliumModal(item.id) },
                        })
                        : null)),
            ]);
        })));
        this.renderConsiliumRegistries();
        this.renderConsiliumFavorites();
        $('consiliumInsights').classList.toggle('is-hidden',!this.can('consiliumChair'));
        this.renderConsiliumSchedule(rows);
        if (this.consilium.focusId) {
            const focused = $(`consilium-grid-row-${this.consilium.focusId}`) || $(`consilium-row-${this.consilium.focusId}`);
            if (focused) {
                focused.scrollIntoView({ behavior: 'smooth', block: 'center' });
                window.setTimeout(() => focused.classList.remove('consilium-row--focused'), 3500);
            }
            this.consilium.focusId = null;
        }
    },

    renderConsiliumSchedule(appointmentRows = this.consilium.appointments || []) {
        if (!this.consiliumGridReady()) return;
        const chair = this.can('consiliumChair');
        this.renderConsiliumDayNavigation();
        $('consiliumChairOnlyFreeBtn').setAttribute('aria-pressed', this.consilium.onlyFree ? 'true' : 'false');
        $('consiliumDoctorOnlyFreeBtn').setAttribute('aria-pressed', this.consilium.onlyFree ? 'true' : 'false');
        $('consiliumMineOnly').setAttribute('aria-pressed', this.consilium.mineOnly ? 'true' : 'false');
        $('consiliumScheduleEditor').classList.remove('is-hidden');
        $('consiliumScheduleManagement').classList.toggle('is-hidden', !chair);
        $('consiliumChairScheduleWrap').classList.toggle('is-hidden', !chair);
        $('consiliumDoctorScheduleWrap').classList.toggle('is-hidden', chair);
        if (!chair) {
            this.renderConsiliumDoctorSchedule();
            return;
        }
        const selectedGroups = this.consiliumSelectedGroups('chair');
        if (!selectedGroups.length) {
            $('consiliumChairScheduleTables').replaceChildren();
            $('consiliumScheduleEmpty').textContent = 'Выберите одну или несколько консилиумных групп.';
            $('consiliumScheduleEmpty').classList.remove('is-hidden');
            return;
        }
        const selectedGroupSet = new Set(selectedGroups);
        appointmentRows = appointmentRows.filter(item =>
            item.scheduledDate === this.consilium.dateFilter
            && selectedGroupSet.has(item.consiliumGroup)
            && (!String(this.consilium.search || '').trim()
                || String(item.patientName || '').toLowerCase().includes(String(this.consilium.search).trim().toLowerCase())
                || String(item.policyNumber || '').toLowerCase().includes(String(this.consilium.search).trim().toLowerCase()))
        );
        let slots = (this.consilium.schedule || []).filter(slot =>
            slot.scheduledDate === this.consilium.dateFilter
            && selectedGroupSet.has(slot.consiliumGroup)
        );
        const keyFor = item => `${item.scheduledDate}|${item.scheduledTime}|${item.consiliumGroup}`;
        const appointmentsBySlot = new Map(appointmentRows.map(item => [keyFor(item), item]));
        const scheduledKeys = new Set(slots.map(keyFor));
        const searchActive = Boolean(String(this.consilium.search || '').trim());
        if (searchActive) slots = slots.filter(slot => appointmentsBySlot.has(keyFor(slot)));
        let gridRows = [
            ...slots.map(slot => ({ slot, appointment: appointmentsBySlot.get(keyFor(slot)) || null })),
            ...appointmentRows
                .filter(item => !scheduledKeys.has(keyFor(item)))
                .map(appointment => ({
                    slot: {
                        id: `appointment-${appointment.id}`,
                        scheduledDate: appointment.scheduledDate,
                        scheduledTime: appointment.scheduledTime,
                        consiliumGroup: appointment.consiliumGroup,
                        consiliumGroupLabel: appointment.consiliumGroupLabel,
                        occupied: true,
                    },
                    appointment,
                })),
        ].sort((a, b) => keyFor(a.slot).localeCompare(keyFor(b.slot), 'ru'));
        if (this.consilium.onlyFree) gridRows = gridRows.filter(({ slot, appointment }) => !appointment && !slot.occupied);
        const groups = (this.consilium.meta?.groups || []).filter(group => selectedGroupSet.has(group.value));
        $('consiliumScheduleEmpty').textContent = searchActive
            ? 'По вашему запросу записей в сетке не найдено.'
            : 'Сетка пока не создана.';
        $('consiliumScheduleEmpty').classList.add('is-hidden');
        $('consiliumChairScheduleTables').replaceChildren(frag(groups.map(group => {
            const rows = gridRows.filter(({ slot }) => slot.consiliumGroup === group.value);
            return el('section', { class: 'consilium-schedule-group' }, [
                el('h3', { class: 'consilium-schedule-group__title', text: group.label }),
                rows.length ? this.renderConsiliumSlotCards(rows, true) : el('div', {
                    class: 'empty consilium-schedule-group__empty',
                    text: searchActive ? 'По вашему запросу записей не найдено.' : 'На выбранный день слотов нет.',
                }),
            ]);
        })));
    },

    renderConsiliumSlotCards(rows, chair, recordActions = null) {
        const generation=this.consilium.gridGeneration,epoch=this.sessionEpoch;
        const list=el('ul', {class:'consilium-slots', 'aria-label':'Сохраненные слоты'}, rows.map(({slot, appointment, record:scopedRecord, unavailableText}) => {
            const record = chair ? appointment : scopedRecord;
            const occupied = !!appointment || slot.occupied;
            const state = occupied ? 'busy' : slot.bookable ? 'free' : 'off';
            const actions = chair
                ? (appointment ? el('div', {class:'consilium-grid-markers'}, [
                    appointment.uvRuv ? el('span',{class:'chip chip--danger',text:'УВ/РУВ'}) : null,
                    appointment.outsideSchedule ? el('span',{class:'chip chip--warning',text:'Вне расписания'}) : null,
                    appointment.backdated ? el('span',{class:'chip chip--neutral',text:'Оформлено задним числом'}) : null,
                    this.renderConsiliumChairActions(appointment),
                ]) : occupied ? el('span',{class:'chip chip--neutral',text:'Занято'}) : el('div', {class:'consilium-grid-markers'}, [
                    slot.backdated ? el('span',{class:'chip chip--neutral',text:'Слот задним числом'}) : null,
                    el('button',{type:'button',class:'btn btn--ghost btn--sm',text: 'Удалить',
                        'aria-label':`Удалить свободный слот ${slot.scheduledTime}`,
                        on:{click:()=>this.deleteConsiliumScheduleSlot(slot.id)}}),
                ]))
                : record ? recordActions(record, appointment.isMine)
                    : occupied ? el('span',{class:'chip chip--neutral',text:'Занято'})
                    : slot.bookable ? el('button',{type:'button',class:'btn btn--primary btn--sm',text:'Запись',
                        'aria-label':`${slot.scheduledTime}: записать пациента`,on:{click:()=>this.openConsiliumModal(null, slot)}})
                    : el('span',{class:'muted',text:unavailableText || 'Время прошло'});
            return el('li', {class:`consilium-slot consilium-slot--${state}${appointment && this.consilium.focusId===appointment.id ? ' consilium-row--focused' : ''}`,
                ...(appointment ? {id:`consilium-grid-row-${appointment.id}`} : {}),
                'data-slot-state':state}, [
                el('div',{class:'consilium-slot__head'},[
                    el('strong',{class:'consilium-slot-time',text: slot.scheduledTime}),
                    el('span',{class:'consilium-slot__state',text:occupied?'Занято':slot.bookable?'Свободно':'Недоступно'}),
                ]),
                appointment ? (record ? el('button',{type:'button',class:'consilium-patient-button',text:appointment.patientName,
                    on:{click:()=>this.openConsiliumDetails(record)}}) : el('span',{text:appointment.patientName}))
                    : el('p',{class:'muted',text:occupied?'Сведения о пациенте недоступны':'Сохраненный слот председателя'}),
                appointment ? el('p',{class:'consilium-slot__clinical',text:`${appointment.primaryDiagnosis || '—'} · ${appointment.treatingDoctorName || '—'}`}) : null,
                chair && appointment?.comment ? el('p',{class:'consilium-comment',text:appointment.comment}) : null,
                el('div',{class:'consilium-slot__actions'},actions),
            ]);
        }));
        for (const button of list.querySelectorAll('button')) button.addEventListener('click',event=>{
            if (epoch!==this.sessionEpoch || !this.consiliumGridReady(generation)) {event.preventDefault();event.stopImmediatePropagation();}
        },true);
        return list;
    },

    renderConsiliumDayNavigation() {
        const chair=this.can('consiliumChair');
        const selected=(chair?this.consilium.dateFilter:this.consilium.doctorDate)||this.consiliumToday();
        const center=new Date(selected+'T12:00:00Z');
        if (!Number.isFinite(center.getTime())) return;
        $('consiliumDayNavigation').replaceChildren(frag(Array.from({length:7},(_,i)=>{
            const date=new Date(center);date.setUTCDate(date.getUTCDate()+i-3);
            const iso=date.toISOString().slice(0,10);
            return el('button',{type:'button',class:'consilium-day','aria-pressed':iso===selected?'true':'false',
                'aria-label':new Intl.DateTimeFormat('ru-RU',{dateStyle:'full',timeZone:'UTC'}).format(date),
                on:{click:async()=>{const epoch=this.sessionEpoch;if(chair){this.consilium.dateFilter=iso;$('consiliumDateFilter').value=iso;}
                    else {this.consilium.doctorDate=iso;$('consiliumDoctorDate').value=iso;}
                    await this.renderConsilium();
                    if(epoch===this.sessionEpoch&&!this.sessionExpired&&this.currentView==='consilium') $('consiliumDayNavigation').querySelector('[aria-pressed="true"]')?.focus();}}},[
                el('span',{text:new Intl.DateTimeFormat('ru-RU',{weekday:'short',timeZone:'UTC'}).format(date)}),
                el('strong',{text:String(date.getUTCDate())}),
            ]);
        })));
    },

    renderConsiliumDoctorSchedule() {
        const selectedDate = this.consilium.doctorDate;
        const selectedGroups = this.consiliumSelectedGroups('doctor');
        if (!selectedGroups.length) {
            $('consiliumDoctorScheduleTables').replaceChildren();
            $('consiliumDoctorScheduleEmpty').textContent = 'Выберите одну или несколько консилиумных групп.';
            $('consiliumDoctorScheduleEmpty').classList.remove('is-hidden');
            return;
        }
        // WP2.3-B2: свободные слоты — только из расписания председателя.
        if (!(this.consilium.schedule || []).length) {
            $('consiliumDoctorScheduleEmpty').textContent = 'Расписание председателя не создано: запись недоступна';
            $('consiliumDoctorScheduleEmpty').classList.remove('is-hidden');
        } else {
            $('consiliumDoctorScheduleEmpty').classList.add('is-hidden');
        }
        const selectedGroupSet = new Set(selectedGroups);
        let slots = (this.consilium.schedule || [])
            .filter(slot => (!selectedDate || slot.scheduledDate === selectedDate)
                && selectedGroupSet.has(slot.consiliumGroup))
            .sort((a, b) => `${a.scheduledTime}|${a.consiliumGroup}`.localeCompare(`${b.scheduledTime}|${b.consiliumGroup}`, 'ru'));
        const search = String(this.consilium.search || '').trim().toLowerCase();
        const matches = item => !search
            || String(item?.patientName || '').toLowerCase().includes(search)
            || String(item?.policyNumber || '').toLowerCase().includes(search);
        if (search) slots = slots.filter(slot => matches(slot.appointment));
        // Записи, которыми сотрудник управляет: врач — своих пациентов, заведующий —
        // пациентов отделения, кто бы их ни создал (сервер возвращает только их).
        const manageable = new Map((this.consilium.appointments || []).map(item => [item.id, item]));
        if (this.consilium.onlyFree) slots = slots.filter(slot => !slot.occupied);
        if (this.consilium.mineOnly) slots = slots.filter(slot => slot.appointment?.canManage);
        const groups = (this.consilium.meta?.groups || []).filter(group => selectedGroupSet.has(group.value));
        const recordActions = (record, isMine = false) => el('div', { class: 'consilium-grid-markers' }, [
            record.uvRuv ? el('span', { class: 'chip chip--danger', text: 'УВ/РУВ' }) : null,
            isMine ? el('span', { class: 'chip chip--warning', text: 'Моя запись' }) : null,
            record.outsideSchedule ? el('span', { class: 'chip chip--warning', text: 'Вне расписания' }) : null,
            record.backdated ? el('span', { class: 'chip chip--neutral', text: 'Оформлено задним числом' }) : null,
            this.consiliumEditable(record)
                ? el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Изменить',
                    on: { click: () => this.openConsiliumModal(record.id) },
                }) : el('span', { class: 'chip chip--neutral', text: record.statusLabel }),
        ]);
        const sections = groups.map(group => {
            const groupSlots = slots.filter(slot => slot.consiliumGroup === group.value);
            return el('section', { class: 'consilium-schedule-group' }, [
                el('h3', { class: 'consilium-schedule-group__title', text: group.label }),
                groupSlots.length ? this.renderConsiliumSlotCards(groupSlots.map(slot => {
                    const appointment=slot.appointment || null;
                    return {slot,appointment,record:appointment && appointment.canManage ? manageable.get(appointment.id) : null,
                        unavailableText:slot.bookable ? '' : 'Время прошло'};
                }), false, recordActions) : el('div', {
                    class: 'empty consilium-schedule-group__empty',
                    text: search ? 'По вашему запросу записей не найдено.' : 'На выбранный день слотов нет.',
                }),
            ]);
        });
        // Старые записи без слота председателя не скрываются и не переносятся
        // автоматически: отдельный блок с отметкой «Вне расписания».
        const outside = [...manageable.values()].filter(item => item.outsideSchedule
            && (!selectedDate || item.scheduledDate === selectedDate)
            && selectedGroupSet.has(item.consiliumGroup) && matches(item));
        if (outside.length) {
            sections.push(el('section', { class: 'consilium-schedule-group', id: 'consiliumOutsideSchedule' }, [
                el('h3', { class: 'consilium-schedule-group__title', text: 'Записи вне расписания' }),
                el('div', { class: 'table-wrap' }, [
                    el('table', { class: 'table consilium-doctor-schedule-table' }, [
                        el('thead', {}, el('tr', {}, [
                            el('th', { text: 'Время записи' }), el('th', { text: 'ФИО пациента' }),
                            el('th', { text: 'Код МКБ-10' }), el('th', { text: 'ФИО врача' }),
                            el('th', { text: '' }),
                        ])),
                        el('tbody', {}, outside.map(record => el('tr', {}, [
                            el('td', { class: 'consilium-slot-time', text: `${record.scheduledTime} · ${record.consiliumGroupLabel}` }),
                            el('td', {}, el('button', {
                                type: 'button', class: 'consilium-patient-button', text: record.patientName,
                                on: { click: () => this.openConsiliumDetails(record) },
                            })),
                            el('td', { class: 'consilium-diagnosis', text: record.primaryDiagnosis || '—' }),
                            el('td', { text: record.treatingDoctorName || '—' }),
                            el('td', { class: 'cell-actions' }, recordActions(record)),
                        ]))),
                    ]),
                ]),
            ]));
        }
        $('consiliumDoctorScheduleTables').replaceChildren(frag(sections));
    },

    renderConsiliumRegistries() {
        const chair = this.can('consiliumChair');
        $('consiliumRegistries').classList.toggle('is-hidden', !chair || !this.consiliumGridReady() || !this.consilium.registries);
        if (!chair || !this.consiliumGridReady() || !this.consilium.registries) return;
        const query=$('consiliumRegistrySearch').value.trim().toLocaleLowerCase('ru');
        const matches=item=>!query || [item.patientName,item.policyNumber,item.primaryDiagnosis].some(v=>String(v||'').toLocaleLowerCase('ru').includes(query));
        const surgical = (this.consilium.registries.surgical || []).filter(matches);
        const chemotherapy = (this.consilium.registries.chemotherapy || []).filter(matches);
        const goc = (this.consilium.registries.goc || []).filter(matches);
        const goc65 = (this.consilium.registries.goc65Plus || []).filter(matches);
        $('surgicalRegistryEmpty').classList.toggle('is-hidden', surgical.length > 0);
        $('chemoRegistryEmpty').classList.toggle('is-hidden', chemotherapy.length > 0);
        $('gocRegistryEmpty').classList.toggle('is-hidden', goc.length > 0);
        $('goc65RegistryEmpty').classList.toggle('is-hidden', goc65.length > 0);
        $('surgicalRegistryBody').replaceChildren(frag(surgical.map(item => el('tr', {}, [
            el('td', { text: this.formatConsiliumDate(item.scheduledDate, item.scheduledTime) }),
            el('td', {}, [
                el('button',{type:'button',class:'consilium-patient-button',text:item.patientName,on:{click:()=>{if(epoch===this.sessionEpoch&&this.consiliumGridReady(generation))this.openConsiliumDetails(item);}}}),
                el('div', { class: 'person__meta', text: item.treatingDoctorName }),
            ]),
            el('td', { text: item.policyNumber || 'Не указан' }),
            el('td', { class: 'consilium-diagnosis', text: item.primaryDiagnosis }),
            el('td', {}, el('label', { class: 'registry-check' }, [
                el('input', {
                    type: 'checkbox', checked: item.referralCompleted,
                    // Отдельное право; сервер проверяет его же.
                    disabled: !this.can('markReferralCompletion'),
                    on: { change: event => this.setSurgicalReferralCompleted(item.id, event.target.checked, event.target) },
                }),
                el('span', { text: item.referralCompleted ? 'Отмечено' : 'Поставить отметку' }),
            ])),
        ]))));
        $('chemoRegistryBody').replaceChildren(frag(chemotherapy.map(item => el('tr', {}, [
            el('td', { text: this.formatConsiliumDate(item.scheduledDate, item.scheduledTime) }),
            el('td', {}, [
                el('button',{type:'button',class:'consilium-patient-button',text:item.patientName,on:{click:()=>{if(epoch===this.sessionEpoch&&this.consiliumGridReady(generation))this.openConsiliumDetails(item);}}}),
                el('div', { class: 'person__meta', text: item.treatingDoctorName }),
            ]),
            el('td', { text: item.policyNumber || 'Не указан' }),
            el('td', { class: 'consilium-diagnosis', text: item.primaryDiagnosis }),
            el('td', { text: item.treatmentScheme ? `${item.treatmentSchemeCode ? item.treatmentSchemeCode + ' — ' : ''}${item.treatmentScheme}` : 'Не указана' }),
        ]))));
        $('gocRegistryBody').replaceChildren(frag(goc.map(item => el('tr', {}, [
            el('td', { text: this.formatConsiliumDate(item.scheduledDate, item.scheduledTime) }),
            el('td', {}, [
                el('button',{type:'button',class:'consilium-patient-button',text:item.patientName,on:{click:()=>{if(epoch===this.sessionEpoch&&this.consiliumGridReady(generation))this.openConsiliumDetails(item);}}}),
                el('div', { class: 'person__meta', text: item.treatingDoctorName }),
            ]),
            el('td', { text: item.policyNumber || 'Не указан' }),
            el('td', { class: 'consilium-diagnosis', text: item.primaryDiagnosis }),
            el('td', { text: item.treatmentScheme
                ? `${item.treatmentTypeLabel}: ${item.treatmentSchemeCode ? item.treatmentSchemeCode + ' — ' : ''}${item.treatmentScheme}`
                : item.treatmentTypeLabel || 'Не указано' }),
        ]))));
        $('goc65RegistryBody').replaceChildren(frag(goc65.map(item => el('tr', {}, [
            el('td', { text: this.formatConsiliumDate(item.scheduledDate, item.scheduledTime) }),
            el('td', {}, [
                el('button',{type:'button',class:'consilium-patient-button',text:item.patientName,on:{click:()=>{if(epoch===this.sessionEpoch&&this.consiliumGridReady(generation))this.openConsiliumDetails(item);}}}),
                el('div', { class: 'person__meta', text: item.treatingDoctorName }),
            ]),
            el('td', { text: item.policyNumber || 'Не указан' }),
            el('td', { class: 'consilium-diagnosis', text: item.primaryDiagnosis }),
            el('td', { text: item.treatmentScheme
                ? `${item.treatmentTypeLabel}: ${item.treatmentSchemeCode ? item.treatmentSchemeCode + ' — ' : ''}${item.treatmentScheme}`
                : item.treatmentTypeLabel || 'Не указано' }),
        ]))));
        const generation=this.consilium.gridGeneration,epoch=this.sessionEpoch;
        for(const table of $('consiliumRegistries').querySelectorAll('table')) {
            const labels=[...table.querySelectorAll('thead th')].map(n=>n.textContent);
            for(const row of table.querySelectorAll('tbody tr')) [...row.cells].forEach((cell,i)=>cell.dataset.label=labels[i]);
            for(const input of table.querySelectorAll('input')) input.addEventListener('change',event=>{
                if(epoch!==this.sessionEpoch || !this.consiliumGridReady(generation)) {event.preventDefault();event.stopImmediatePropagation();}
            },true);
        }
    },

    async deleteConsiliumAppointment(item) {
        const owner = this.consilium, epoch = this.sessionEpoch;
        const available = () => this.consilium === owner && epoch === this.sessionEpoch && !this.sessionExpired &&
            !$('consiliumModal').hidden && owner.editingId === item.id && !owner.formPending &&
            !owner.refreshPending && $('consiliumConflict').classList.contains('is-hidden');
        if (!available() || ui.topModal() !== 'consiliumModal') return;
        const confirmed = await ui.confirm({
            title: 'Удалить запись на консилиум?',
            text: `${item.patientName}. Слот ${this.formatConsiliumDate(item.scheduledDate, item.scheduledTime)} освободится для новой записи.`,
            okLabel: 'Удалить запись',
            danger: true,
        });
        if (!confirmed || !available()) return;
        const form = $('consiliumForm');
        const current = () => this.consilium === owner && epoch === this.sessionEpoch && !this.sessionExpired;
        owner.formPending = true;
        form.inert = true;
        try {
            await apiDelete(`/api/consilium/appointments/${encodeURIComponent(item.id)}?version=${encodeURIComponent(owner.editingVersion)}`);
            if (!current()) return;
            ui.closeModal('consiliumModal', {force: true});
            owner.editingId = null;
            owner.loaded = false;
            await this.renderConsilium();
            if (current()) ui.toast('Запись удалена, слот снова свободен.', 'good');
        } catch (error) {
            if (!current()) return;
            if (this.isConsiliumVersionConflict(error) || !error.status || error.status >= 500) {
                this.showConsiliumConflict({message: 'Удаление не подтверждено. Обновите данные перед новым действием. ' + error.message});
            } else ui.toast('Не удалось удалить запись: ' + error.message, 'danger');
        } finally {
            owner.formPending = false;
            form.inert = false;
        }
    },

    async generateConsiliumSchedule(event) {
        event.preventDefault();
        const errorNode = $('consiliumScheduleError');
        errorNode.classList.add('is-hidden');
        if (!$('consiliumScheduleDate').value) {
            errorNode.textContent = 'Выберите доступную дату в календаре.';
            errorNode.classList.remove('is-hidden');
            return;
        }
        try {
            const result = await apiPost('/api/consilium/schedule/generate', {
                scheduledDate: $('consiliumScheduleDate').value,
                consiliumGroup: $('consiliumScheduleGroup').value,
                startTime: $('consiliumScheduleStart').value,
                endTime: $('consiliumScheduleEnd').value,
                intervalMinutes: Number($('consiliumScheduleInterval').value),
            });
            this.consilium.schedule = result.slots || [];
            $('consiliumScheduleDate').value = '';
            $('consiliumScheduleDateButton').textContent = 'Выберите дату';
            this.renderConsiliumScheduleCalendar();
            this.renderConsiliumSchedule();
            // Время сегодняшнего интервала, которое уже прошло по Москве, не создается.
            const skipped = result.skippedPast
                ? ` Прошедшее время пропущено: ${result.skippedPast}.` : '';
            ui.toast(result.created
                ? `Создано свободных слотов: ${result.created}.${skipped}`
                : `Такие слоты уже существуют.${skipped}`, 'good');
        } catch (error) {
            errorNode.textContent = 'Не удалось создать сетку: ' + error.message;
            errorNode.classList.remove('is-hidden');
        }
    },

    async deleteConsiliumScheduleSlot(slotId) {
        if (!this.consiliumGridReady() || !(this.consilium.schedule || []).some(slot=>slot.id===slotId&&!slot.occupied&&slot.scheduledDate===(this.can('consiliumChair')?this.consilium.dateFilter:this.consilium.doctorDate))) return;
        try {
            await apiDelete(`/api/consilium/schedule/${encodeURIComponent(slotId)}`);
            const schedule = await apiGetJson('/api/consilium/schedule');
            this.consilium.schedule = schedule.slots || [];
            this.renderConsiliumSchedule();
            ui.toast('Свободный слот удалён.', 'good');
        } catch (error) {
            ui.toast('Не удалось удалить слот: ' + error.message, 'danger');
        }
    },

    async toggleConsiliumFavorite(item) {
        if(!this.can('useConsiliumFavorites') || !this.consiliumGridReady() || this.consilium.favoritePending)return;
        const epoch=this.sessionEpoch;this.consilium.favoritePending=true;
        try {
            if (item.isFavorite) {
                await apiDelete(`/api/consilium/favorites/${encodeURIComponent(item.patientId)}`);
                ui.toast('Пациент удалён из избранного.', 'good');
            } else {
                await apiPost(`/api/consilium/favorites/${encodeURIComponent(item.patientId)}`, {});
                ui.toast('Пациент добавлен в избранное консилиума.', 'good');
            }
            // Избранное — закладка внутри консилиума, доступ к карточке оно не даёт.
            this.consilium.loaded = false;
            await this.renderConsilium();
            if(epoch!==this.sessionEpoch || this.sessionExpired)return;
        } catch (error) {
            if(epoch!==this.sessionEpoch || this.sessionExpired || error.obsolete)return;
            ui.toast('Не удалось изменить избранное: ' + error.message, 'danger');
        } finally {if(epoch===this.sessionEpoch)this.consilium.favoritePending=false;}
    },

    async readConsiliumRecord(id, {archived = false} = {}) {
        const {appointments} = await apiGetJson('/api/consilium/appointments' + (archived ? '?archived=true' : ''));
        if (!Array.isArray(appointments)) throw new Error('Не удалось проверить список записей.');
        return appointments.find(item => item.id === id) || null;
    },

    async openConsiliumDetails(item) {
        if (!item?.id || !this.can('accessConsilium') || this.sessionExpired || this.consilium.archivePending) return;
        const owner = this.consilium, epoch = this.sessionEpoch, view = this.currentView;
        const read = this.beginRead('consilium-detail');
        const modal = $('consiliumDetailsModal');
        const current = () => this.consilium === owner && epoch === this.sessionEpoch && view === this.currentView &&
            !this.sessionExpired && this.isCurrentRead('consilium-detail', read) && !modal.hidden;
        owner.detailsItem = null;
        $('consiliumDetailsTitle').textContent = 'Запись на онкологический консилиум';
        $('consiliumDetailsBody').replaceChildren(el('p', {role: 'status', text: 'Проверяем доступ к записи…'}));
        $('consiliumDetailsRevisions').replaceChildren();
        $('consiliumDetailsRevisions').classList.add('is-hidden');
        $('consiliumDetailsConflict').classList.add('is-hidden');
        $('consiliumDetailsPrimaryAction').replaceChildren();
        for (const id of ['consiliumArchiveToggleBtn', 'consiliumBackdatingReasonsBtn']) $(id).classList.add('is-hidden');
        this.beginRead('consilium-history-consiliumDetailsRevisions');
        if (modal.hidden) ui.openModal('consiliumDetailsModal');
        modal.setAttribute('aria-busy', 'true');
        try {
            const fresh = await this.readConsiliumRecord(item.id, {
                archived: Boolean(item.archived && !this.can('consiliumChair')),
            });
            if (!current()) return;
            if (!fresh) {
                $('consiliumDetailsBody').replaceChildren(el('p', {role: 'status', text: 'Запись больше недоступна.'}));
                return;
            }
            this.renderConsiliumDetails(fresh);
        } catch (error) {
            if (current()) $('consiliumDetailsBody').replaceChildren(
                el('p', {role: 'alert', text: 'Не удалось проверить доступ к записи.'}),
                el('button', {type: 'button', class: 'btn btn--ghost', text: 'Обновить запись',
                    on: {click: () => this.openConsiliumDetails(item)}}),
            );
        } finally {
            if (current()) modal.setAttribute('aria-busy', 'false');
        }
    },

    renderConsiliumDetails(item) {
        const readonlyField = (label, value, wide = false) => el('div', { class: `field${wide ? ' field--wide' : ''}` }, [
            el('span', { class: 'field__label', text: label }),
            el('div', { class: 'consilium-detail-value', text: value || 'Не указано' }),
        ]);
        const specialists = [
            item.needsSurgeon ? 'Хирург' : '',
            item.needsRadiotherapist ? 'Лучевой терапевт' : '',
            item.additionalParticipant || '',
        ].filter(Boolean).join(', ') || 'Не требуются';
        $('consiliumDetailsTitle').textContent = `Запись: ${item.patientName}`;
        $('consiliumDetailsBody').replaceChildren(frag([
            item.status==='signed'?el('p',{class:'alert alert--info',text:'Подписанное решение · сведения и маршрут зафиксированы сервером на момент подписи. Последующие изменения карточки не заменяют этот снимок.'}):null,
            el('fieldset', { class: 'fieldset' }, [
                el('legend', { class: 'fieldset__legend', text: 'Пациент и запись' }),
                el('div', { class: 'grid-2' }, [
                    readonlyField('ФИО пациента', item.patientName),
                    readonlyField('Полис ОМС', item.policyNumber),
                    readonlyField('Консилиумная группа', item.consiliumGroupLabel),
                    readonlyField(item.backdated ? 'Дата и время проведения' : 'Дата и время', this.formatConsiliumDate(item.scheduledDate, item.scheduledTime)),
                    // WP2.3-B3: дата проведения и фактическое время внесения — раздельно.
                    item.backdated ? readonlyField('Внесено в систему', this.formatMoscowDateTime(item.createdAt)) : null,
                    item.backdated ? readonlyField('Отметка', 'Оформлено задним числом') : null,
                    readonlyField('Льгота', item.hasBenefit ? 'Да' : 'Нет'),
                    readonlyField('Лечащий врач', item.treatingDoctorName),
                ]),
            ]),
            el('fieldset', { class: 'fieldset' }, [
                el('legend', { class: 'fieldset__legend', text: 'Сведения для консилиума' }),
                el('div', { class: 'grid-2' }, [
                    readonlyField('Локализация', item.diagnosisLocalization),
                    readonlyField('Основной диагноз', item.primaryDiagnosis),
                    readonlyField('Дополнительный диагноз', item.additionalDiagnosis),
                    readonlyField('Участники', specialists),
                    readonlyField('Отметка УВ/РУВ', item.uvRuv ? 'Да' : 'Нет'),
                    readonlyField('Статус', item.statusLabel),
                    readonlyField('Назначенное лечение', item.treatmentTypeLabel),
                    item.routeContext ? readonlyField('Этап маршрута на момент решения', item.routeContext.stage
                        ? `${this.stageNames[item.routeContext.stage] || item.routeContext.stage}${item.routeContext.source === 'derived' ? ' (восстановлено по истории)' : ''}`
                        : 'Не установлен') : null,
                    readonlyField('Отметки ГОК', [item.goc ? 'ГОК' : '', item.goc65Plus ? 'ГОК 65+' : ''].filter(Boolean).join(', ')),
                ]),
                readonlyField('Схема лечения', item.treatmentScheme ? `${item.treatmentSchemeCode ? item.treatmentSchemeCode + ' — ' : ''}${item.treatmentScheme}` : '', true),
                readonlyField('Комментарий врача', item.comment, true),
                item.revisionComment ? readonlyField('Комментарий председателя', item.revisionComment, true) : null,
            ]),
        ]));
        this.renderConsiliumRevisionHistory('consiliumDetailsRevisions',item);
        // Архив — личное действие автора над подписанной записью; сервер
        // проверяет то же (автор, область видимости, подпись) и отвечает 409.
        const toggle = $('consiliumArchiveToggleBtn');
        const canArchive = this.currentView === 'consilium' && item.status === 'signed' &&
            this.can('bookConsilium') && !this.can('consiliumChair');
        toggle.classList.toggle('is-hidden', !canArchive);
        toggle.textContent = item.archived ? 'Восстановить из архива' : 'Перенести в архив';
        toggle.disabled = false;
        $('consiliumDetailsConflict').classList.add('is-hidden');
        const canReadReasons = item.backdated && this.user
            && ['consilium_chair', 'department_head'].includes(this.user.roleId);
        $('consiliumBackdatingReasonsBtn').classList.toggle('is-hidden', !canReadReasons);
        this.consilium.detailsItem = item;
        const chairAction = this.can('decideConsilium') && ['recorded', 'revised', 'in_review'].includes(item.status);
        const editAction = this.can('bookConsilium') && this.consiliumEditable(item);
        if (this.currentView === 'consilium' && (chairAction || editAction)) $('consiliumDetailsPrimaryAction').append(el('button', {
            id: 'consiliumDetailsAction', type: 'button', class: 'btn btn--primary',
            text: chairAction ? 'Открыть рассмотрение' : 'Изменить или перенести',
            on: {click: () => {
                if (this.consilium.detailsItem !== item || !this.consiliumGridReady()) return;
                ui.closeModal('consiliumDetailsModal');
                if (chairAction) void this.openConsiliumDecision(item.id);
                else void this.openConsiliumModal(item.id);
            }},
        }));
    },

    async toggleConsiliumArchive() {
        const item = this.consilium.detailsItem;
        if (!item || this.consilium.archivePending || this.sessionExpired || !$('consiliumDetailsConflict').classList.contains('is-hidden')) return;
        const epoch=this.sessionEpoch;this.consilium.archivePending=true;$('consiliumArchiveToggleBtn').disabled=true;
        const action = item.archived ? 'restore' : 'archive';
        try {
            await apiPost(`/api/consilium/appointments/${encodeURIComponent(item.id)}/${action}`, { version: item.version });
            ui.closeModal('consiliumDetailsModal',{force:true});
            this.consilium.detailsItem = null;
            this.consilium.loaded = false;
            await this.renderConsilium();
            if(epoch!==this.sessionEpoch || this.sessionExpired)return;
            ui.toast(action === 'archive' ? 'Запись перенесена в архив.' : 'Запись восстановлена из архива.', 'good');
        } catch (error) {
            if(epoch!==this.sessionEpoch || this.sessionExpired || error.obsolete)return;
            if (this.isConsiliumVersionConflict(error)) {
                // Повтор с прежней версией невозможен, пока данные не обновлены.
                $('consiliumDetailsConflictText').textContent = error.message;
                $('consiliumDetailsConflict').classList.remove('is-hidden');
                $('consiliumArchiveToggleBtn').disabled = true;
                return;
            }
            if(epoch===this.sessionEpoch&&!this.sessionExpired){$('consiliumDetailsConflictText').textContent='Результат не подтвержден. Проверьте состояние перед повтором. '+error.message;$('consiliumDetailsConflict').classList.remove('is-hidden');}
        } finally {if(epoch===this.sessionEpoch)this.consilium.archivePending=false;}
    },

    async setSurgicalReferralCompleted(appointmentId, completed, control=null) {
        if(!this.can('markReferralCompletion') || !this.consiliumGridReady() || this.consilium.referralPending)return;
        const epoch=this.sessionEpoch;this.consilium.referralPending=true;
        for(const node of $('surgicalRegistryBody').querySelectorAll('input'))node.disabled=true;
        try {
            await apiPost(`/api/consilium/appointments/${encodeURIComponent(appointmentId)}/referral-completion`, { completed });
            this.consilium.loaded = false;
            await this.renderConsilium();
            if(epoch!==this.sessionEpoch || this.sessionExpired)return;
            ui.toast(completed ? 'Направление отмечено как созданное.' : 'Отметка направления снята.', 'good');
        } catch (error) {
            if(epoch!==this.sessionEpoch || this.sessionExpired || error.obsolete)return;
            ui.toast('Не удалось сохранить отметку: ' + error.message, 'danger');
            this.consilium.loaded = false;
            await this.renderConsilium();
            if(epoch!==this.sessionEpoch || this.sessionExpired)return;
        } finally {if(epoch===this.sessionEpoch)this.consilium.referralPending=false;}
    },

    async exportConsiliumRegistry(kind) {
        if(!['chemotherapy','goc','goc-65-plus'].includes(kind) || !this.can('consiliumChair') || !this.consiliumGridReady() || this.consilium.exportPending)return;
        const epoch=this.sessionEpoch,generation=this.consilium.gridGeneration;this.consilium.exportPending=true;
        const buttons=['exportChemoRegistryBtn','exportGocRegistryBtn','exportGoc65RegistryBtn'];buttons.forEach(id=>$(id).disabled=true);
        try {
            const query=this.consilium.dateFilter?`?date=${encodeURIComponent(this.consilium.dateFilter)}`:'';
            const response=await apiFetch(`/api/consilium/registries/${kind}.xlsx${query}`,{headers:{'X-CSRF-Token':getCookie('clinic_csrf')||''}});
            const blob=await response.blob();
            if(!await this.checkSessionIdentity(epoch || 0))return;
            if(epoch!==this.sessionEpoch || !this.consiliumGridReady(generation))return;
            const match=(response.headers.get('content-disposition')||'').match(/filename="([^"]+)"/);
            const link=el('a',{href:URL.createObjectURL(blob),download:match?match[1]:kind+'.xlsx'});
            document.body.append(link);link.click();URL.revokeObjectURL(link.href);link.remove();
            ui.toast('Серверный Excel-реестр сформирован.','good');
        } catch(error) {if(epoch===this.sessionEpoch&&!this.sessionExpired)ui.toast('Не удалось сформировать Excel: '+error.message,'danger');}
        finally {if(epoch===this.sessionEpoch){this.consilium.exportPending=false;buttons.forEach(id=>$(id).disabled=!this.consiliumGridReady());}}
    },
    async exportChemotherapyRegistry() {await this.exportConsiliumRegistry('chemotherapy');},
    async exportGocRegistry() {await this.exportConsiliumRegistry('goc');},
    async exportGoc65Registry() {await this.exportConsiliumRegistry('goc-65-plus');},

    renderConsiliumFavorites() {
        const allowed=this.can('useConsiliumFavorites')&&this.consiliumGridReady();
        $('consiliumFavorites').classList.toggle('is-hidden',!allowed);
        if(!allowed)return;
        const rows=(this.consilium.appointments||[]).filter(x=>x.isFavorite),generation=this.consilium.gridGeneration,epoch=this.sessionEpoch;
        $('consiliumFavoritesList').replaceChildren(frag(rows.length?rows.map(item=>el('li',{class:'consilium-review-record'},[
            el('div',{},[el('strong',{text:item.patientName}),el('p',{class:'muted',text:item.statusLabel+' · '+this.formatConsiliumDate(item.scheduledDate,item.scheduledTime)})]),
            el('button',{type:'button',class:'btn btn--ghost',text:'Решение и история',on:{click:()=>{if(epoch===this.sessionEpoch&&this.consiliumGridReady(generation))this.openConsiliumDetails(item);}}}),
        ])):[el('li',{class:'empty',text:'Избранных записей пока нет. Добавьте пациента кнопкой «В избранное» в расписании.'})]));
    },

    async loadConsiliumAnalytics(event) {
        event?.preventDefault();if(!this.can('consiliumChair') || this.sessionExpired)return;
        const epoch=this.sessionEpoch,version=this.beginRead('consilium-analytics');
        const current=()=>epoch===this.sessionEpoch&&!this.sessionExpired&&this.isCurrentRead('consilium-analytics',version);
        const body=$('consiliumAnalyticsBody');body.replaceChildren();body.inert=true;$('consiliumAnalyticsState').textContent='Загрузка показателей…';
        const query=new URLSearchParams();if($('consiliumAnalyticsFrom').value)query.set('date_from',$('consiliumAnalyticsFrom').value);if($('consiliumAnalyticsTo').value)query.set('date_to',$('consiliumAnalyticsTo').value);
        try {
            const data=await apiGetJson('/api/consilium/analytics?'+query);if(!current())return;
            const metric=(label,value)=>el('p',{},[document.createTextNode(label),el('strong',{text:String(value??'—')})]);
            body.replaceChildren(el('div',{class:'consilium-insight-values'},[
                ...Object.entries({total:'Всего',signed:'Подписано',inReview:'На рассмотрении',awaiting:'Ожидают',returned:'На доработке',needsSpecialists:'Нужны специалисты'}).map(([key,label])=>metric(label,data.summary[key])),
                metric('Слоты',data.schedule.slots),metric('Занято',data.schedule.occupied),metric('Загрузка',data.schedule.loadPercent===null?'Нет расписания':data.schedule.loadPercent+'%'),metric('Вне расписания',data.schedule.outsideSchedule),
            ]),el('details',{},[el('summary',{text:'Детализация назначений и схем'}),el('ul',{},[...data.treatments,...data.schemes].map(x=>el('li',{text:[x.code,x.label,x.count].filter(v=>v!==undefined&&v!=='').join(' · ')})))]));
            body.inert=false;$('consiliumAnalyticsState').textContent='Актуальные серверные показатели за выбранный период.';
        }catch(error){if(current()){$('consiliumAnalyticsState').textContent='Не удалось обновить показатели: '+error.message;body.replaceChildren();}}
    },

    consiliumLocalizationKey(value = $('consiliumLocalization').value) {
        const normalized = String(value || '').trim().toLowerCase();
        return Object.keys(this.icd10Localizations).find(key =>
            key.toLowerCase() === normalized || this.icd10Localizations[key].label.toLowerCase() === normalized
        ) || '';
    },

    fillConsiliumDiagnosisList() {
        const localization = this.consiliumLocalizationKey();
        const diagnoses = localization
            ? this.icd10Localizations[localization].diagnoses
            : this.malignantDiagnosisOptions();
        $('consiliumDiagnosisOptions').replaceChildren(frag(
            diagnoses.map(item => option(item.code, item.label))
        ));
    },

    toggleConsiliumAdditionalDiagnosis(show) {
        $('consiliumAdditionalDiagnosisField').classList.toggle('is-hidden', !show);
        $('addConsiliumDiagnosisBtn').classList.toggle('is-hidden', show);
        $('addConsiliumDiagnosisBtn').setAttribute('aria-expanded', show ? 'true' : 'false');
        if (!show) $('consiliumAdditionalDiagnosis').value = '';
    },

    async prefillConsiliumDiagnosisFromPatient() {
        const owner = this.consilium;
        if (owner.editingId) return;
        const selected = $('consiliumPatient').value;
        const fields = ['consiliumPrimaryDiagnosis', 'consiliumPolicyNumber', 'consiliumLocalization'];
        if (owner.prefillPatientId !== selected) {
            for (const id of [...fields, 'consiliumComment', 'consiliumAdditionalParticipant']) $(id).value = '';
            this.toggleConsiliumAdditionalDiagnosis(false);
            $('consiliumUvRuv').checked = false;
            for (const id of ['consiliumBenefit', 'consiliumNeedsSurgeon', 'consiliumNeedsRadiotherapist']) $(id).value = 'no';
        }
        owner.prefillPatientId = selected;
        owner.verifiedPatient = null;
        $('submitConsiliumBtn').disabled = true;
        if (!selected) return;
        const epoch = this.sessionEpoch, read = this.beginRead('consilium-patient-prefill');
        const initial = fields.map(id => $(id).value);
        const current = () => this.consilium === owner && epoch === this.sessionEpoch && !this.sessionExpired &&
            !$('consiliumModal').hidden && !owner.editingId && $('consiliumPatient').value === selected &&
            this.isCurrentRead('consilium-patient-prefill', read);
        let patient;
        try {
            patient = await apiGetJson('/api/patients/' + encodeURIComponent(selected));
        } catch (error) {
            if (current()) {
                if ([403, 404].includes(error.status)) {
                    for (const id of [...fields, 'consiliumComment', 'consiliumAdditionalParticipant']) $(id).value = '';
                    this.toggleConsiliumAdditionalDiagnosis(false);
                }
                this.showConsiliumFormError('Не удалось подтвердить доступ к пациенту. Выберите пациента заново.');
            }
            return;
        }
        if (!current() || patient?.id !== selected) return;
        owner.verifiedPatient = {id: selected, epoch};
        $('submitConsiliumBtn').disabled = !$('consiliumConflict').classList.contains('is-hidden') || owner.formPending;
        if (fields.some((id, index) => $(id).value !== initial[index])) return;
        const diagnosis = this.validConsiliumDiagnosis(patient.diagnosis, false);
        $('consiliumPrimaryDiagnosis').value = diagnosis || '';
        $('consiliumPolicyNumber').value = patient.policyNumber || '';
        const diagnosisItem = this.allDiagnosisOptions().find(item => item.code === diagnosis);
        $('consiliumLocalization').value = diagnosisItem ? diagnosisItem.localizationLabel : '';
        this.fillConsiliumDiagnosisList();
        this.prefillConsiliumGroupFromDiagnosis();
    },

    consiliumGroupForDiagnosis(value = $('consiliumPrimaryDiagnosis').value) {
        const match = String(value || '').trim().toUpperCase().match(/^C(\d{2})(?:\.|$)/);
        if (!match) return '';
        const code = Number(match[1]);
        if ((code >= 0 && code <= 14) || (code >= 30 && code <= 32)) return 'head_neck';
        if ((code >= 15 && code <= 16) || (code >= 22 && code <= 25)) return 'abdominal';
        if (code === 34) return 'thoracic';
        if (code >= 51 && code <= 57) return 'gynecology';
        if (code >= 60 && code <= 68) return 'urology';
        if (code === 50) return 'breast';
        if (code >= 17 && code <= 20) return 'colorectal';
        return 'general';
    },

    prefillConsiliumGroupFromDiagnosis() {
        if (this.consilium.editingId) return;
        const recommendedKey = this.consiliumGroupForDiagnosis();
        if (!recommendedKey) return;
        const recommended = (this.consilium.meta?.groups || []).find(group => group.value === recommendedKey);
        if (!recommended) return;
        $('consiliumGroup').value = recommended.label;
        this.updateConsiliumAvailableSlots();
    },

    consiliumGroupKey(value = $('consiliumGroup').value) {
        const normalized = String(value || '').trim().toLowerCase();
        const group = (this.consilium.meta?.groups || []).find(item =>
            item.value.toLowerCase() === normalized || item.label.toLowerCase() === normalized
        );
        return group ? group.value : String(value || '').trim();
    },

    updateConsiliumAvailableSlots(record = null) {
        // Режим «задним числом» (WP2.3-B3): время — только выбранного исторического
        // слота председателя; обычные будущие слоты здесь не предлагаются.
        if (this.consilium.backdatedMode && !record) {
            const slot = this.consiliumBackdatedSlots().find(item => item.id === $('consiliumBackdatedSlot').value);
            $('consiliumTime').replaceChildren(slot
                ? option(slot.scheduledTime, slot.scheduledTime, true)
                : option('', 'Выберите исторический слот', true));
            if (slot) {
                $('consiliumDate').value = slot.scheduledDate;
                $('consiliumTime').value = slot.scheduledTime;
            }
            return;
        }
        const configured = this.consilium.schedule || [];
        let times = [];
        if (configured.length) {
            const group = this.consiliumGroupKey();
            const date = $('consiliumDate').value;
            // Только свободные будущие слоты председателя (bookable считает сервер
            // по Москве); текущий слот изменяемой записи остается в списке.
            times = configured
                .filter(slot => slot.scheduledDate === date && slot.consiliumGroup === group)
                .filter(slot => slot.bookable || (record
                    && slot.scheduledDate === record.scheduledDate
                    && slot.scheduledTime === record.scheduledTime
                    && slot.consiliumGroup === record.consiliumGroup))
                .map(slot => slot.scheduledTime);
            $('consiliumSlotHint').textContent = times.length
                ? 'Показаны свободные слоты из расписания председателя.'
                : 'На выбранную дату и группу свободных слотов нет.';
        } else {
            // Запасной список времени больше не используется (WP2.3-B2).
            $('consiliumSlotHint').textContent = 'Расписание председателя не создано: запись недоступна';
        }
        const isOriginalDate = !!record && $('consiliumDate').value === record.scheduledDate;
        if (isOriginalDate && !times.includes(record.scheduledTime)) times.unshift(record.scheduledTime);
        const currentValue = $('consiliumTime').value;
        const selected = isOriginalDate ? record.scheduledTime : (times.includes(currentValue) ? currentValue : '');
        $('consiliumTime').replaceChildren(frag([
            option('', 'Выберите свободный слот', !selected),
            ...[...new Set(times)].sort().map(time => option(
                time,
                isOriginalDate && time === record.scheduledTime ? `${time} — текущее время` : time,
                time === selected,
            )),
        ]));
    },

    async fillConsiliumPatientsForGroup(record = null, cursor = null, restarted = false) {
        const version=this.beginRead('consilium-candidates');
        const group=this.consiliumGroupKey();
        const known=(this.consilium.meta?.groups||[]).some(g=>g.value===group);
        const selected=record?.patientId || $('consiliumPatient').value;
        const q=$('consiliumPatientSearch')?.value || '';
        $('submitConsiliumBtn').disabled=true;
        $('consiliumPatient').replaceChildren(option('','Загрузка кандидатов…',true));
        $('consiliumPatientHint').textContent='Проверка доступных пациентов…';
        $('consiliumCandidatePager')?.replaceChildren();
        try {
            const p=new URLSearchParams({limit:'50',q});if(known)p.set('group',group);if(cursor)p.set('cursor',cursor);
            const data=await apiGetJson('/api/patients/workspace/patients?'+p);
            if(!this.isCurrentRead('consilium-candidates',version))return [];
            const rows=data.patients;
            if(record && !rows.some(p=>p.id===record.patientId)) {
                const detail=await this.refreshPatientRecord(record.patientId);
                if(!this.isCurrentRead('consilium-candidates',version))return [];
                rows.unshift(detail);
            }
            this.candidateRows=rows;
            const selectedId=rows.some(p=>p.id===selected)?selected:(rows[0]?.id||'');
            $('consiliumPatient').replaceChildren(frag([option('',rows.length?'Выберите пациента':'Нет подходящих пациентов',!selectedId),...rows.map(p=>option(p.id,`${p.name} · ${p.diagnosis||''}`,p.id===selectedId))]));
            $('consiliumPatient').value=selectedId;
            $('consiliumPatientHint').textContent=`Доступно по условиям: ${data.page.total}. Исключены пациенты с незавершенной записью на консилиум.`;
            let pager=$('consiliumCandidatePager');if(!pager){pager=el('div',{id:'consiliumCandidatePager'});$('consiliumPatientHint').after(pager);}
            this.consilium.candidatePaging ||= {trail:[null],index:0};
            if(!cursor)this.consilium.candidatePaging={trail:[null],index:0};
            pager.replaceChildren(this.boundedPager(data,this.consilium.candidatePaging,next=>this.fillConsiliumPatientsForGroup(record,next)));
            if (!record && !$('consiliumModal').hidden) await this.prefillConsiliumDiagnosisFromPatient();
            else $('submitConsiliumBtn').disabled = !record || !rows.length;
            return rows;
        } catch(error) {
            if(!this.isCurrentRead('consilium-candidates',version))return [];
            if(!restarted&&[409,410].includes(error.status)&&['PATIENT_QUERY_CHANGED','CURSOR_EXPIRED'].includes(error.data?.code))return this.fillConsiliumPatientsForGroup(record,null,true);
            this.candidateRows=[];$('consiliumPatient').replaceChildren(option('','Список недоступен',true));
            $('consiliumPatientHint').textContent='Не удалось получить доступных кандидатов. Повторите поиск после проверки доступа.';
            $('submitConsiliumBtn').disabled=true;
            ui.toast(error.message,'danger');return [];
        }
    },

    async openConsiliumModal(appointmentId = null, selectedSlot = null, options = {}) {
        if (this.sessionExpired || this.consilium.loading) return;
        if (selectedSlot) {
            if (!this.consiliumGridReady()) return;
            const fresh=this.consilium.schedule.find(slot=>slot.id===selectedSlot.id
                &&slot.scheduledDate===selectedSlot.scheduledDate&&slot.scheduledTime===selectedSlot.scheduledTime
                &&slot.consiliumGroup===selectedSlot.consiliumGroup&&slot.bookable&&!slot.occupied);
            if (!fresh || fresh.scheduledDate!==(this.can('consiliumChair')?this.consilium.dateFilter:this.consilium.doctorDate)) return;
            selectedSlot=fresh;
        }
        try {
            if (!this.consilium.meta || !this.consilium.loaded) await this.loadConsilium();
        } catch (error) {
            ui.toast('Не удалось подготовить форму: ' + error.message, 'danger');
            return;
        }
        const prepareEpoch=this.sessionEpoch,prepareVersion=this.readVersions['consilium-load'];
        this.consilium.editingId = appointmentId;
        const record = appointmentId
            ? this.consilium.appointments.find(item => item.id === appointmentId)
            : null;
        if (appointmentId && !record) return;
        this.consilium.editingVersion = record ? record.version : null;
        // Режим «задним числом» включается только явным действием (ниже).
        this.consilium.backdatedMode = false;
        this.resetConsiliumConflict();
        this.renderConsiliumRevisionHistory('consiliumFormRevisions', record);
        $('consiliumGroupOptions').replaceChildren(frag(
            (this.consilium.meta.groups || []).map(group => option(group.label, group.value))
        ));
        $('consiliumLocalizationOptions').replaceChildren(frag(
            Object.values(this.icd10Localizations).map(item => option(item.label, ''))
        ));
        this.fillConsiliumDiagnosisList();

        const today = this.consiliumToday();
        $('consiliumDate').min = today;
        const firstFree = !record ? (selectedSlot || (this.consilium.schedule || []).find(slot => slot.bookable)) : null;
        $('consiliumDate').value = record ? record.scheduledDate : (firstFree ? firstFree.scheduledDate : today);
        $('consiliumDate').disabled = !record;
        $('consiliumTime').disabled = !record;
        $('consiliumDoctor').value = (this.user && this.user.fullName) || '';
        $('consiliumBenefit').value = record && record.hasBenefit ? 'yes' : 'no';
        $('consiliumPolicyNumber').value = record ? record.policyNumber : '';
        $('consiliumGroup').value = record
            ? record.consiliumGroupLabel
            : (firstFree ? firstFree.consiliumGroupLabel : '');
        const patients = await this.fillConsiliumPatientsForGroup(record);
        if (prepareEpoch!==this.sessionEpoch || this.sessionExpired || this.consilium.loading || !this.consilium.loaded
            ||prepareVersion!==this.readVersions['consilium-load']) return;
        for (const notice of $('consiliumModal').querySelectorAll('[data-consilium-read-notice]')) notice.remove();
        $('consiliumPatient').disabled = !!record;
        $('consiliumGroup').readOnly = !!record;
        this.updateConsiliumAvailableSlots(record);
        if (!record && firstFree) $('consiliumTime').value = firstFree.scheduledTime;
        $('consiliumLocalization').value = record ? record.diagnosisLocalization : '';
        $('consiliumPrimaryDiagnosis').value = record ? record.primaryDiagnosis : '';
        $('consiliumAdditionalDiagnosis').value = record ? record.additionalDiagnosis : '';
        this.toggleConsiliumAdditionalDiagnosis(!!(record && record.additionalDiagnosis));
        this.fillConsiliumDiagnosisList();
        $('consiliumComment').value = record ? record.comment : '';
        $('consiliumAdditionalParticipant').value = record ? record.additionalParticipant : '';
        $('consiliumUvRuv').checked = !!(record && record.uvRuv);
        $('consiliumNeedsSurgeon').value = record && record.needsSurgeon ? 'yes' : 'no';
        $('consiliumNeedsRadiotherapist').value = record && record.needsRadiotherapist ? 'yes' : 'no';
        $('consiliumFormError').classList.add('is-hidden');
        $('consiliumModalTitle').textContent = record
            ? 'Изменение и перенос записи на консилиум'
            : 'Запись на онкологический консилиум';
        $('submitConsiliumBtn').textContent = record ? 'Сохранить изменения' : 'Создать запись';
        $('submitConsiliumBtn').disabled = !record || patients.length === 0;
        $('deleteConsiliumBtn').classList.toggle('is-hidden', !record || !this.consiliumEditable(record));
        $('deleteConsiliumBtn').disabled = false;
        // Повторная подача — отдельное действие после возврата (WP2.3-B1):
        // сохранение формы статус «На доработке» не меняет.
        $('resubmitConsiliumBtn').classList.toggle('is-hidden', !record || record.status !== 'needs_revision');
        $('resubmitConsiliumBtn').disabled = false;
        this.setConsiliumBackdatedMode(!record && !!options.backdated);
        if ($('consiliumModal').hidden) ui.openModal('consiliumModal');
        if (!record && patients.length) {
            $('consiliumPatient').value = patients[0].id;
            void this.prefillConsiliumDiagnosisFromPatient();
        }
    },

    // Свободные исторические слоты председателя (WP2.3-B3), новые сверху.
    consiliumBackdatedSlots() {
        return (this.consilium.schedule || [])
            .filter(slot => slot.backdated && !slot.occupied)
            .sort((a, b) => `${b.scheduledDate} ${b.scheduledTime}`.localeCompare(`${a.scheduledDate} ${a.scheduledTime}`));
    },

    // Режим «Оформить консилиум задним числом»: вместо свободного будущего слота —
    // исторический слот председателя и обязательная причина. Обычная запись не меняется.
    setConsiliumBackdatedMode(enabled) {
        this.consilium.backdatedMode = enabled;
        $('consiliumBackdatedFieldset').classList.toggle('is-hidden', !enabled);
        $('consiliumSlotFieldset').classList.toggle('is-hidden', enabled);
        $('consiliumBackdatedReason').value = '';
        if (!enabled) return;
        const slots = this.consiliumBackdatedSlots();
        $('consiliumBackdatedSlot').replaceChildren(frag([
            option('', slots.length ? 'Выберите исторический слот' : 'Свободных исторических слотов нет', true),
            ...slots.map(slot => option(slot.id,
                `${this.formatConsiliumDate(slot.scheduledDate, slot.scheduledTime)} · ${slot.consiliumGroupLabel}`)),
        ]));
        $('consiliumModalTitle').textContent = 'Оформление консилиума задним числом';
        $('submitConsiliumBtn').textContent = 'Оформить задним числом';
        this.updateConsiliumAvailableSlots();
        $('submitConsiliumBtn').disabled = !slots.length;
    },

    async applyConsiliumBackdatedSlot() {
        const slot = this.consiliumBackdatedSlots().find(item => item.id === $('consiliumBackdatedSlot').value);
        if (!slot) return;
        $('consiliumGroup').value = slot.consiliumGroupLabel;
        await this.fillConsiliumPatientsForGroup();
        this.updateConsiliumAvailableSlots();
        $('submitConsiliumBtn').disabled = false;
    },

    async openConsiliumBackdatedSlotModal() {
        try {
            if (!this.consilium.meta || !this.consilium.loaded) await this.loadConsilium();
        } catch (error) {
            ui.toast('Не удалось подготовить форму: ' + error.message, 'danger');
            return;
        }
        $('consiliumBackdatedSlotGroup').replaceChildren(frag(
            (this.consilium.meta.groups || []).map(group => option(group.value, group.label))
        ));
        $('consiliumBackdatedSlotDate').max = this.consiliumToday();
        $('consiliumBackdatedSlotDate').value = '';
        $('consiliumBackdatedSlotTime').value = '';
        $('consiliumBackdatedSlotReason').value = '';
        $('consiliumBackdatedSlotError').classList.add('is-hidden');
        ui.openModal('consiliumBackdatedSlotModal');
    },

    async submitConsiliumBackdatedSlot(event) {
        event.preventDefault();
        const errorNode = $('consiliumBackdatedSlotError');
        errorNode.classList.add('is-hidden');
        const payload = {
            scheduledDate: $('consiliumBackdatedSlotDate').value,
            scheduledTime: $('consiliumBackdatedSlotTime').value,
            consiliumGroup: $('consiliumBackdatedSlotGroup').value,
            reason: $('consiliumBackdatedSlotReason').value.trim(),
        };
        if (!payload.scheduledDate || !payload.scheduledTime || !payload.consiliumGroup || !payload.reason) {
            errorNode.textContent = 'Заполните дату, время, группу и причину позднего создания слота.';
            errorNode.classList.remove('is-hidden');
            return;
        }
        const button = $('submitConsiliumBackdatedSlotBtn');
        button.disabled = true;
        try {
            const slot = await apiPost('/api/consilium/schedule/backdated', payload);
            ui.closeModal('consiliumBackdatedSlotModal');
            ui.toast(`Слот задним числом создан: ${this.formatConsiliumDate(slot.scheduledDate, slot.scheduledTime)}, ${slot.consiliumGroupLabel}. Заведующий отделением может оформить в него запись.`, 'good');
            this.consilium.loaded = false;
            await this.renderConsilium();
        } catch (error) {
            errorNode.textContent = 'Не удалось создать слот: ' + error.message;
            errorNode.classList.remove('is-hidden');
        } finally {
            button.disabled = false;
        }
    },

    // Тексты причин — только председателю и заведующему; сервер проверяет права и
    // фиксирует обращение в журнале. Выводится только как текст (textContent).
    async showConsiliumBackdatingReasons(item) {
        const epoch=this.sessionEpoch,read=this.beginRead('consilium-backdating');
        const current=()=>epoch===this.sessionEpoch&&!this.sessionExpired&&this.isCurrentRead('consilium-backdating',read)&&this.consilium.detailsItem?.id===item.id&&!$('consiliumDetailsModal').hidden;
        const box = $('consiliumDetailsBody');
        const previous = $('consiliumBackdatingReasonsBox');
        if (previous) previous.remove();
        try {
            const data = await apiGetJson(`/api/consilium/appointments/${encodeURIComponent(item.id)}/backdating`);
            if(!current())return;
            const block = (label, reason) => reason ? el('div', { class: 'field field--wide' }, [
                el('span', { class: 'field__label', text: label }),
                el('div', { class: 'consilium-detail-value', text: reason.text }),
                el('div', { class: 'field__hint', text: [this.formatMoscowDateTime(reason.createdAt), reason.createdByName].filter(Boolean).join(' · ') }),
            ]) : null;
            box.append(el('fieldset', { class: 'fieldset', id: 'consiliumBackdatingReasonsBox' }, [
                el('legend', { class: 'fieldset__legend', text: 'Причины оформления задним числом' }),
                block('Причина позднего оформления записи', data.appointmentReason),
                block('Причина позднего создания слота', data.slotReason),
            ]));
        } catch (error) {
            if(!current())return;
            ui.toast('Не удалось показать причины: ' + error.message, 'danger');
        }
    },

    async openConsiliumArchive(history=false) {
        if(!this.can('accessConsilium') || (!history&&!this.can('bookConsilium')) || this.sessionExpired)return;
        this.consilium.archiveHistory=history;
        $('consiliumArchiveSubtitle').textContent=history?(this.can('consiliumChair')?'Все разрешенные подписанные решения, включая архивные.':'Подписанные записи в работе. Архив открывается отдельно кнопкой «Архив».'):'Архивные подписанные записи в вашей разрешенной области. Откройте медицинский снимок или восстановите запись.';
        $('consiliumArchiveTitle').textContent=history?'История подписанных решений':'Архив консилиумов';
        $('consiliumArchiveDate').value='';$('consiliumArchiveSearch').value='';
        ui.openModal('consiliumArchiveModal');await this.loadConsiliumArchive();
    },

    async loadConsiliumArchive() {
        const epoch=this.sessionEpoch,read=this.beginRead('consilium-archive');
        const current=()=>epoch===this.sessionEpoch&&!this.sessionExpired&&this.isCurrentRead('consilium-archive',read);
        this.consilium.archiveReady=false;this.consilium.archiveAppointments=[];
        $('consiliumArchiveBody').replaceChildren();$('consiliumArchiveTableWrap').classList.add('is-hidden');$('consiliumArchiveEmpty').classList.add('is-hidden');$('consiliumArchiveState').textContent='Загрузка подписанных записей…';
        try {
            const history=this.consilium.archiveHistory;
            const data=await apiGetJson('/api/consilium/appointments'+(history?'':'?archived=true'));if(!current())return;
            // Chairman receives all records regardless of archived query by the existing API.
            this.consilium.archiveAppointments=(data.appointments||[]).filter(item=>item.status==='signed'&&(history||item.archived));
            this.consilium.archiveReady=true;this.consilium.archiveEpoch=epoch;this.consilium.archiveRead=read;
            $('consiliumArchiveState').textContent='Серверные подписанные записи. Фильтры применяются к вашей разрешенной области.';this.renderConsiliumArchive();
        }catch(error){if(current()){$('consiliumArchiveState').textContent='Не удалось обновить список: '+error.message;this.consilium.archiveAppointments=[];}}
    },

    renderConsiliumArchive() {
        if(!this.consilium.archiveReady || this.consilium.archiveEpoch!==this.sessionEpoch || this.sessionExpired)return;
        const epoch=this.sessionEpoch,read=this.consilium.archiveRead;
        const date = $('consiliumArchiveDate').value;
        const query = $('consiliumArchiveSearch').value.trim().toLocaleLowerCase('ru');
        const rows = (this.consilium.archiveAppointments || []).filter(item => {
            if (date && item.scheduledDate !== date) return false;
            if (!query) return true;
            return String(item.patientName || '').toLocaleLowerCase('ru').includes(query)
                || String(item.policyNumber || '').toLocaleLowerCase('ru').includes(query);
        });
        const openDetails = (item) => {
            if(epoch!==this.sessionEpoch || !this.consilium.archiveReady || !this.isCurrentRead('consilium-archive',read))return;
            ui.closeModal('consiliumArchiveModal');
            this.openConsiliumDetails(item);
        };
        $('consiliumArchiveBody').replaceChildren(frag(rows.map(item=>el('tr',{class:'consilium-archive-row'},[
            el('td',{'data-label':'Дата и время',text:this.formatConsiliumDate(item.scheduledDate,item.scheduledTime)}),
            el('td',{'data-label':'Пациент'},[el('button',{type:'button',class:'consilium-patient-button',text:item.patientName,on:{click:()=>openDetails(item),keydown:event=>{if (event.key === 'Enter' || event.key === ' ') {event.preventDefault();openDetails(item);}}}}),el('div',{class:'muted',text:item.policyNumber||'Полис не указан'})]),
            el('td',{'data-label':'Группа',text:item.consiliumGroupLabel}),
            el('td',{'data-label':'Диагноз',text:item.primaryDiagnosis||'—'}),
            el('td',{'data-label':'Лечение',text:item.treatmentTypeLabel||'—'}),
            el('td',{'data-label':'Состояние',text:item.archived?'В архиве':'Подписано'}),
        ]))));
        $('consiliumArchiveEmpty').classList.toggle('is-hidden', rows.length !== 0);
        $('consiliumArchiveTableWrap').classList.toggle('is-hidden', rows.length === 0);
    },

    showConsiliumFormError(message) {
        const node = $('consiliumFormError');
        node.textContent = message;
        node.classList.remove('is-hidden');
        $('consiliumFormError').focus();
        node.scrollIntoView({ block: 'nearest' });
    },

    isConsiliumVersionConflict(error) {
        return !!(error && error.status === 409 && error.data && error.data.code === 'consilium_version_conflict');
    },

    resetConsiliumConflict() {
        this.consilium.unconfirmedBooking = null;
        $('consiliumConflict').classList.add('is-hidden');
        $('consiliumConflictDraft').classList.add('is-hidden');
        $('consiliumConflictDraftText').value = '';
    },

    // Запись изменилась после открытия формы: сервер ничего не сохранил.
    // Введенный текст остается в форме, а отправка с устаревшей версией
    // блокируется до явного «Обновить данные».
    showConsiliumConflict(error) {
        $('consiliumFormError').classList.add('is-hidden');
        $('consiliumConflictText').textContent = error.message;
        $('consiliumConflict').classList.remove('is-hidden');
        $('submitConsiliumBtn').disabled = true;
        $('resubmitConsiliumBtn').disabled = true;
        $('deleteConsiliumBtn').disabled = true;
        $('consiliumConflict').scrollIntoView({ block: 'nearest' });
        $('consiliumConflict').focus();
    },

    async refreshConsiliumAfterConflict() {
        if(this.consilium.refreshPending || this.consilium.formPending)return;
        const owner=this.consilium,epoch=this.sessionEpoch,form=$('consiliumForm');
        owner.refreshPending=true;
        form.inert=true;
        try {
        const appointmentId = this.consilium.editingId;
        const draft = $('consiliumComment').value;
        this.consilium.loaded = false;
        try {
            await this.loadConsilium();
        } catch (error) {
            ui.toast('Не удалось обновить данные: ' + error.message, 'danger');
            return;
        }
        if(epoch!==this.sessionEpoch || owner!==this.consilium || this.sessionExpired)return;
        if (!appointmentId && owner.unconfirmedBooking) {
            const pending = owner.unconfirmedBooking;
            const sameSlot = item => item.scheduledDate === pending.scheduledDate &&
                item.scheduledTime === pending.scheduledTime && item.consiliumGroup === pending.consiliumGroup;
            const existing = owner.appointments.find(item => item.patientId === pending.patientId && sameSlot(item));
            const free = owner.schedule.some(slot => sameSlot(slot) && !slot.occupied &&
                (pending.backdated ? slot.backdated : slot.bookable));
            if (existing || owner.blockedPatientIds.includes(pending.patientId) || !free) {
                $('consiliumConflictText').textContent = existing
                    ? 'Сервер вернул запись для пациента на выбранное время. Новая отправка заблокирована.'
                    : 'Сервер не подтвердил возможность записи. Новая отправка заблокирована.';
                return;
            }
            try {
                const patient = await apiGetJson('/api/patients/' + encodeURIComponent(pending.patientId));
                if (epoch !== this.sessionEpoch || owner !== this.consilium || this.sessionExpired ||
                    patient?.id !== pending.patientId || $('consiliumPatient').value !== pending.patientId) return;
            } catch {
                if (epoch === this.sessionEpoch && owner === this.consilium && !this.sessionExpired) {
                    $('consiliumConflictText').textContent = 'Доступ к пациенту не подтвержден. Новая отправка заблокирована.';
                }
                return;
            }
            owner.verifiedPatient = {id: pending.patientId, epoch};
            this.resetConsiliumConflict();
            $('submitConsiliumBtn').disabled = false;
            ui.toast('Сервер подтвердил свободное время. Проверьте поля перед новой отправкой.', 'warning');
            return;
        }
        const fresh = this.consilium.appointments.find(item => item.id === appointmentId);
        if (!fresh) {
            ui.closeModal('consiliumModal',{force:true});
            this.consilium.editingId = null;
            await this.renderConsilium();
            ui.toast('Запись больше недоступна для изменения.', 'warning');
            return;
        }
        await this.openConsiliumModal(appointmentId);
        if(epoch!==this.sessionEpoch || owner!==this.consilium || this.sessionExpired)return;
        // Свежие данные сервера — в форме; несохраненный текст показан рядом,
        // чтобы перенести его осознанно, а не отправить поверх чужой правки.
        if (draft && draft !== (fresh.comment || '')) {
            $('consiliumConflictDraftText').value = draft;
            $('consiliumConflictDraft').classList.remove('is-hidden');
        }
        await this.renderConsilium();
        } finally {
            owner.refreshPending=false;
            form.inert=false;
            if(epoch===this.sessionEpoch && owner===this.consilium && !this.sessionExpired && !$('consiliumModal').hidden)$('consiliumComment').focus();
        }
    },

    async refreshConsiliumDetailsAfterConflict() {
        const epoch=this.sessionEpoch,read=this.beginRead('consilium-detail-refresh');
        const current=()=>epoch===this.sessionEpoch&&!this.sessionExpired&&this.isCurrentRead('consilium-detail-refresh',read);
        const appointmentId = this.consilium.detailsItem && this.consilium.detailsItem.id;
        this.consilium.loaded = false;
        try {
            await this.loadConsilium();
        } catch (error) {
            if(!current())return;
            ui.toast('Не удалось обновить данные: ' + error.message, 'danger');
            return;
        }
        if(!current())return;
        ui.closeModal('consiliumDetailsModal');
        await this.renderConsilium();
        if(!current())return;
        let fresh = this.consilium.appointments.find(item => item.id === appointmentId);
        if (!fresh && this.can('bookConsilium') && !this.can('consiliumChair')) {
            const archive = await apiGetJson('/api/consilium/appointments?archived=true');
            if(!current())return;
            fresh = (archive.appointments || []).find(item => item.id === appointmentId);
        }
        if (fresh) this.openConsiliumDetails(fresh);
    },

    async resubmitConsiliumAppointment() {
        const appointmentId = this.consilium.editingId;
        if (!appointmentId || this.consilium.formPending || !$('consiliumConflict').classList.contains('is-hidden')) return;
        const epoch=this.sessionEpoch; let correctionsSaved=false;
        const formOwner=this.consilium,form=$('consiliumForm'),deleteButton=$('deleteConsiliumBtn'),deleteDisabled=deleteButton.disabled;
        formOwner.formPending=true;form.inert=true;deleteButton.disabled=true;
        const button = $('resubmitConsiliumBtn');
        button.disabled = true;$('submitConsiliumBtn').disabled=true;
        try {
            // Сначала сохраняются исправления из формы (с проверкой версии), затем
            // отдельным действием запись отправляется на повторное рассмотрение.
            const saved = await this.saveConsiliumForm();
            if (!saved || epoch!==this.sessionEpoch) return;
            correctionsSaved=true;
            await apiPost(`/api/consilium/appointments/${encodeURIComponent(appointmentId)}/resubmit`, { version: saved.version });
            ui.closeModal('consiliumModal',{force:true});
            ui.toast('Запись отправлена на повторное рассмотрение.', 'good');
            this.consilium.editingId = null;
            this.consilium.loaded = false;
            await this.renderConsilium();
        } catch (error) {
            if (this.isConsiliumVersionConflict(error)) return this.showConsiliumConflict(error);
            if(epoch!==this.sessionEpoch || this.sessionExpired)return;
            const message=(correctionsSaved?'Исправления сохранены отдельным запросом. Отправка на рассмотрение не подтверждена. ':'Сохранение не подтверждено. ')+error.message;
            if(!error.status || error.status>=500)this.showConsiliumConflict({message:message+' Проверьте актуальное состояние перед повтором.'});
            else this.showConsiliumFormError(message);
        } finally {
            formOwner.formPending=false;form.inert=false;
            if(epoch===this.sessionEpoch && $('consiliumConflict').classList.contains('is-hidden'))deleteButton.disabled=deleteDisabled;
            if (epoch===this.sessionEpoch && $('consiliumConflict').classList.contains('is-hidden')) {button.disabled = false;$('submitConsiliumBtn').disabled=false;}
        }
    },

    // Данные формы записи или null (ошибка уже показана в форме).
    consiliumFormPayload() {
        const primaryDiagnosis = this.validConsiliumDiagnosis($('consiliumPrimaryDiagnosis').value);
        const additionalDiagnosis = this.validConsiliumDiagnosis($('consiliumAdditionalDiagnosis').value, false);
        if (!primaryDiagnosis) {
            this.showConsiliumFormError('Укажите основной диагноз кодом МКБ‑10 от C00 до C97.');
            return null;
        }
        if (additionalDiagnosis === null) {
            this.showConsiliumFormError('Дополнительный диагноз должен быть кодом МКБ‑10 от C00 до C97.');
            return null;
        }
        const enteredGroup = $('consiliumGroup').value.trim();
        const knownGroup = (this.consilium.meta.groups || []).find(group =>
            group.value.toLowerCase() === enteredGroup.toLowerCase() || group.label.toLowerCase() === enteredGroup.toLowerCase()
        );
        const localizationKey = this.consiliumLocalizationKey();
        const payload = {
            patientId: $('consiliumPatient').value,
            scheduledDate: $('consiliumDate').value,
            scheduledTime: $('consiliumTime').value,
            consiliumGroup: knownGroup ? knownGroup.value : enteredGroup,
            hasBenefit: $('consiliumBenefit').value === 'yes',
            policyNumber: $('consiliumPolicyNumber').value,
            diagnosisLocalization: localizationKey
                ? this.icd10Localizations[localizationKey].label
                : $('consiliumLocalization').value.trim(),
            primaryDiagnosis,
            additionalDiagnosis,
            comment: $('consiliumComment').value,
            additionalParticipant: $('consiliumAdditionalParticipant').value,
            needsSurgeon: $('consiliumNeedsSurgeon').value === 'yes',
            needsRadiotherapist: $('consiliumNeedsRadiotherapist').value === 'yes',
            uvRuv: $('consiliumUvRuv').checked,
        };
        if (!payload.patientId || !payload.scheduledDate || !payload.scheduledTime || !payload.consiliumGroup || !payload.diagnosisLocalization) {
            this.showConsiliumFormError('Заполните пациента, группу, дату, свободный слот и локализацию.');
            return null;
        }
        return payload;
    },

    // Изменение открытой записи с версией, которую видел пользователь (WP2.3-B1).
    // Возвращает обновленную запись; ошибки (в том числе конфликт версий) — исключением.
    async saveConsiliumForm() {
        const payload = this.consiliumFormPayload();
        if (!payload) return null;
        const saved = await apiPut(`/api/consilium/appointments/${encodeURIComponent(this.consilium.editingId)}`,
            { ...payload, version: this.consilium.editingVersion });
        this.consilium.editingVersion = saved.version;
        return saved;
    },

    async submitConsiliumAppointment(event) {
        event.preventDefault();
        if (this.sessionExpired || $('consiliumModal').hidden || this.consilium.formPending ||
            this.consilium.refreshPending || !$('consiliumConflict').classList.contains('is-hidden')) return;
        const verified = this.consilium.verifiedPatient;
        if (!this.consilium.editingId && (!verified || verified.id !== $('consiliumPatient').value ||
            verified.epoch !== this.sessionEpoch)) {
            this.showConsiliumFormError('Подтвердите доступ к выбранному пациенту перед сохранением.');
            return;
        }
        const formOwner=this.consilium,form=$('consiliumForm'),deleteButton=$('deleteConsiliumBtn'),deleteDisabled=deleteButton.disabled;
        formOwner.formPending=true;form.inert=true;deleteButton.disabled=true;const epoch=this.sessionEpoch;
        $('resubmitConsiliumBtn').disabled=true;
        const button = $('submitConsiliumBtn');
        button.disabled = true;
        let booking;
        try {
            const backdated = !this.consilium.editingId && this.consilium.backdatedMode;
            if (this.consilium.editingId) {
                if (!await this.saveConsiliumForm()) return;
            } else if (backdated) {
                const payload = this.consiliumFormPayload();
                if (!payload) return;
                const reason = $('consiliumBackdatedReason').value.trim();
                if (!$('consiliumBackdatedSlot').value || !reason) {
                    this.showConsiliumFormError('Выберите исторический слот и укажите причину позднего оформления.');
                    return;
                }
                booking = {...payload, backdated: true};
                await apiPost('/api/consilium/appointments/backdated', { ...payload, reason });
            } else {
                const payload = this.consiliumFormPayload();
                if (!payload) return;
                booking = payload;
                await apiPost('/api/consilium/appointments', payload);
            }
            if (epoch !== this.sessionEpoch || this.sessionExpired) return;
            ui.closeModal('consiliumModal',{force:true});
            ui.toast(this.consilium.editingId ? 'Запись обновлена.'
                : (backdated ? 'Консилиум оформлен задним числом.' : 'Пациент записан на консилиум.'), 'good');
            this.consilium.editingId = null;
            this.consilium.loaded = false;
            await this.renderConsilium();
        } catch (error) {
            if (this.isConsiliumVersionConflict(error)) return this.showConsiliumConflict(error);
            if(epoch!==this.sessionEpoch || this.sessionExpired)return;
            if (!error.status || error.status >= 500) {
                if (booking) {
                    const {patientId, scheduledDate, scheduledTime, consiliumGroup, backdated} = booking;
                    formOwner.unconfirmedBooking = {patientId, scheduledDate, scheduledTime, consiliumGroup, backdated};
                }
                this.showConsiliumConflict({message: 'Результат сохранения не подтвержден. Ввод сохранен. Обновите данные перед новым действием.'});
            }
            else this.showConsiliumFormError('Не удалось сохранить запись: ' + error.message);
        } finally {
            formOwner.formPending=false;form.inert=false;
            if(epoch===this.sessionEpoch && $('consiliumConflict').classList.contains('is-hidden'))deleteButton.disabled=deleteDisabled;
            if (epoch===this.sessionEpoch && $('consiliumConflict').classList.contains('is-hidden')) {button.disabled = false;$('resubmitConsiliumBtn').disabled=false;}
        }
    },

    updateConsiliumSchemeVisibility() {
        const chemotherapy = $('consiliumTreatmentType').value === 'chemotherapy';
        $('consiliumSchemeField').classList.toggle('is-hidden', !chemotherapy);
        $('consiliumTreatmentScheme').required = chemotherapy;
        if (!chemotherapy) {
            $('consiliumTreatmentScheme').value = '';
            $('consiliumTreatmentSchemeCode').value = '';
        }
    },

    fillConsiliumTreatmentSchemes() {
        $('consiliumTreatmentSchemeOptions').replaceChildren(frag(
            (this.consilium.meta?.treatmentSchemes || []).map(item =>
                option(`${item.code} — ${item.name}`, item.name)
            )
        ));
    },

    syncConsiliumTreatmentScheme() {
        const value = $('consiliumTreatmentScheme').value.trim();
        const normalized = value.toLowerCase();
        const scheme = (this.consilium.meta?.treatmentSchemes || []).find(item =>
            item.code.toLowerCase() === normalized || item.name.toLowerCase() === normalized ||
            `${item.code} — ${item.name}`.toLowerCase() === normalized
        );
        $('consiliumTreatmentSchemeCode').value = scheme ? scheme.code : '';
        if (scheme && value.includes('—')) $('consiliumTreatmentScheme').value = scheme.name;
    },

    renderConsiliumReviewWorkspace(rows) {
        const box=$('consiliumReviewWorkspace');
        box.classList.toggle('is-hidden', !this.can('decideConsilium') || !this.consiliumGridReady());
        if (!this.can('decideConsilium') || !this.consiliumGridReady()) { $('consiliumReviewList').replaceChildren(); return; }
        const filter=$('consiliumReviewFilter').value;
        const visible=rows.filter(item=>filter==='all' || (filter==='awaiting' ? ['recorded','revised'].includes(item.status) : item.status===filter));
        const generation=this.consilium.gridGeneration, epoch=this.sessionEpoch;
        $('consiliumReviewList').replaceChildren(frag(visible.length ? visible.map(item=>el('li',{class:'consilium-review-record'},[
            el('div',{},[el('strong',{text:item.patientName}),el('div',{class:'muted',text:`${item.scheduledTime} · ${item.consiliumGroupLabel}`}),this.renderConsiliumStatus(item)]),
            el('div',{class:'consilium-actions'},[
                el('button',{type:'button',class:'btn btn--ghost',text:'Сведения и история',on:{click:()=>{
                    if(epoch===this.sessionEpoch && this.consiliumGridReady(generation))this.openConsiliumDetails(item);
                }}}),this.renderConsiliumChairActions(item),
            ]),
        ])) : [el('li',{class:'empty',text:'Нет записей с выбранным статусом.'})]));
    },

    consiliumDecisionValues() {
        return JSON.stringify(['consiliumTreatmentType','consiliumTreatmentScheme','consiliumTreatmentSchemeCode','consiliumGoc','consiliumGoc65Plus'].map(id=>$(id).type==='checkbox'?$(id).checked:$(id).value));
    },

    allowConsiliumDecisionClose(id) {
        if(id==='consiliumDetailsModal'&&this.consilium.archivePending&&!this.sessionExpired)return false;
        if (id === 'consiliumModal' && !this.consilium.formPending && !this.consilium.refreshPending) {
            this.beginRead('consilium-patient-prefill');
        }
        if (id === 'consiliumDetailsModal') {
            this.beginRead('consilium-detail');
            this.beginRead('consilium-history-consiliumDetailsRevisions');
            this.consilium.detailsItem = null;
            $('consiliumDetailsBody').replaceChildren();
            $('consiliumDetailsRevisions').replaceChildren();
            $('consiliumDetailsTitle').textContent = 'Запись на онкологический консилиум';
            $('consiliumDetailsPrimaryAction').replaceChildren();
        }
        if(id==='consiliumArchiveModal'){this.consilium.archiveReady=false;this.beginRead('consilium-archive');}
        if(id==='consiliumModal' && !this.sessionExpired && (this.consilium.formPending || this.consilium.refreshPending)) {ui.toast('Дождитесь завершения запроса. Автоматического повтора нет.','warning');return false;}
        if (!['consiliumDecisionModal','consiliumRevisionModal'].includes(id) || $(id).hidden || this.sessionExpired) return true;
        const ctx=this.consilium.decisionContext;
        if (!ctx) return true;
        if (ctx.busy) { ui.toast('Дождитесь результата запроса. Повторная отправка не выполняется.', 'warning'); return false; }
        const dirty=id==='consiliumRevisionModal' ? !!$('consiliumRevisionComment').value.trim() : this.consiliumDecisionValues()!==ctx.baseline;
        if (!dirty) return true;
        if (!ctx.confirming) {
            ctx.confirming=true;
            ui.confirm({title:'Закрыть без сохранения?',text:'Введенный текст будет удален из этой формы. Медицинское действие не выполняется.',okLabel:'Удалить ввод'}).then(ok=>{
                ctx.confirming=false;
                if(ok && ctx===this.consilium.decisionContext && ctx.epoch===this.sessionEpoch)ui.closeModal(id,{force:true});
            });
        }
        return false;
    },

    consiliumDecisionReady() {
        const ctx=this.consilium.decisionContext;
        return ctx && ctx.epoch===this.sessionEpoch && !ctx.busy && !ctx.confirmingSign && !ctx.blocked &&
            this.can('decideConsilium') && this.consiliumGridReady(ctx.generation);
    },

    renderConsiliumDecisionContext(record) {
        const field=(label,value)=>el('p',{},[el('strong',{text:label}),document.createTextNode(String(value||'Не указано'))]);
        $('consiliumDecisionContext').replaceChildren(frag([
            field('Статус сервера',record.statusLabel),field('Версия записи',record.version),
            field('Основной диагноз',record.primaryDiagnosis),field('Локализация',record.diagnosisLocalization),
            field('Комментарий направившего врача',record.comment),field('Лечащий врач',record.treatingDoctorName),
            record.revisionComment?field('Причина доработки',record.revisionComment):null,
        ]));
    },

    // Opening is read-only. All clinical transitions are explicit, separate requests.
    async openConsiliumDecision(appointmentId) {
        if (!this.can('decideConsilium') || !this.consiliumGridReady() || ui.topModal()) return;
        const epoch = this.sessionEpoch, generation = this.consilium.gridGeneration;
        const read = this.beginRead('consilium-decision-open');
        const current = () => epoch === this.sessionEpoch && this.currentView === 'consilium' &&
            this.consiliumGridReady(generation) && this.isCurrentRead('consilium-decision-open', read) && !ui.topModal();
        let record;
        try {
            record = await this.readConsiliumRecord(appointmentId);
        } catch {
            if (current()) ui.toast('Не удалось проверить актуальность записи.', 'warning');
            return;
        }
        if (!current()) return;
        if (!record || !['recorded', 'revised', 'in_review'].includes(record.status)) {
            ui.toast('Запись больше недоступна для рассмотрения.', 'warning');
            return;
        }
        this.consilium.decisionId=appointmentId;
        this.consilium.decisionContext={id:appointmentId,epoch:this.sessionEpoch,generation:this.consilium.gridGeneration,busy:false,blocked:false};
        $('consiliumDecisionPatient').textContent=`${record.patientName} · ${this.formatConsiliumDate(record.scheduledDate,record.scheduledTime)} · ${record.consiliumGroupLabel}`;
        $('consiliumTreatmentType').value=record.treatmentType||'';
        $('consiliumTreatmentScheme').value=record.treatmentScheme||'';
        $('consiliumTreatmentSchemeCode').value=record.treatmentSchemeCode||'';
        $('consiliumGoc').checked=!!record.goc;$('consiliumGoc65Plus').checked=!!record.goc65Plus;
        this.fillConsiliumTreatmentSchemes();this.updateConsiliumSchemeVisibility();
        $('consiliumDecisionModal').querySelector('[data-consilium-read-notice]')?.remove();
        $('consiliumDecisionError').classList.add('is-hidden');$('consiliumDecisionUncertain').classList.add('is-hidden');
        this.consilium.decisionContext.baseline=this.consiliumDecisionValues();
        this.renderConsiliumDecisionContext(record);this.syncConsiliumReviewState(record);
        this.renderConsiliumRevisionHistory('consiliumDecisionRevisions',record);
        ui.openModal('consiliumDecisionModal');
    },

    async refreshConsiliumDecision() {
        const ctx=this.consilium.decisionContext;
        if(!ctx || ctx.busy || ctx.epoch!==this.sessionEpoch || !this.can('decideConsilium'))return;
        ctx.busy=true;this.syncConsiliumReviewState(ctx.record);
        try {
            await this.renderConsilium();
            if(ctx!==this.consilium.decisionContext || ctx.epoch!==this.sessionEpoch || !this.consiliumGridReady())return;
            const record=this.consilium.appointments.find(item=>item.id===ctx.id);
            ctx.generation=this.consilium.gridGeneration;
            const unchangedIntake = ctx.action === 'review' && record && ctx.record &&
                ['recorded', 'revised'].includes(ctx.record.status) && record.status === 'in_review' &&
                Object.keys(ctx.record).every(key => ['status', 'statusLabel', 'version', 'reviewStartedAt', 'updatedAt'].includes(key) ||
                    JSON.stringify(record[key]) === JSON.stringify(ctx.record[key]));
            if (unchangedIntake) ctx.stale = false;
            else ctx.stale ||= Boolean(record && ctx.record && (record.version !== ctx.record.version || record.status !== ctx.record.status));
            ctx.blocked=!record || ctx.stale || !['recorded','revised','in_review'].includes(record.status);
            ctx.record=record;
            if (!record) {
                $('consiliumDecisionContext').replaceChildren();
                $('consiliumDecisionPatient').textContent = 'Запись больше недоступна.';
            }
            if(record){this.renderConsiliumDecisionContext(record);this.renderConsiliumRevisionHistory('consiliumDecisionRevisions',record);}
            $('consiliumDecisionError').textContent = ctx.blocked
                ? 'Серверное состояние изменилось. Ввод сохранен. Чтобы начать новое действие, откройте актуальную запись заново.'
                : '';
            $('consiliumDecisionError').classList.toggle('is-hidden',!ctx.blocked);
            $('consiliumDecisionUncertain').classList.add('is-hidden');
            $('consiliumRevisionError').classList.add('is-hidden');
        } finally { if(ctx===this.consilium.decisionContext){ctx.busy=false;this.syncConsiliumReviewState(ctx.record);} }
    },

    async runConsiliumDecisionAction(action,payload,path=null) {
        if(!this.consiliumDecisionReady())return;
        const ctx=this.consilium.decisionContext;ctx.busy=true;ctx.action=action;this.syncConsiliumReviewState(ctx.record);
        const errorId=action==='return'?'consiliumRevisionError':'consiliumDecisionError';
        try {
            // Preserve the displayed version for the server check, even after a fresh read.
            const fresh = await this.readConsiliumRecord(ctx.id);
            if (ctx !== this.consilium.decisionContext || ctx.epoch !== this.sessionEpoch ||
                !this.can('decideConsilium') || !this.consiliumGridReady(ctx.generation)) return;
            if (!fresh || fresh.version !== ctx.record.version || fresh.status !== ctx.record.status) {
                ctx.stale = true;
                if (!fresh) {
                    $('consiliumDecisionContext').replaceChildren();
                    $('consiliumDecisionPatient').textContent = 'Запись больше недоступна.';
                }
                throw new Error('Запись изменилась. Обновите данные.');
            }
            const record = await apiPost(
                path || `/api/consilium/appointments/${encodeURIComponent(ctx.id)}/${action}`,
                {...payload, version: ctx.record.version},
            );
            if(ctx!==this.consilium.decisionContext || ctx.epoch!==this.sessionEpoch)return;
            ctx.record=record;ctx.blocked=action!=='review';
            $(errorId).classList.add('is-hidden');
            if(action==='review') {
                await this.renderConsilium();
                if(ctx.epoch!==this.sessionEpoch || ctx!==this.consilium.decisionContext)return;
                ctx.generation=this.consilium.gridGeneration;this.renderConsiliumDecisionContext(record);
            } else {
                ui.closeModal('consiliumRevisionModal',{force:true});
                ui.closeModal('consiliumDecisionModal',{force:true});
                this.consilium.decisionId=null;this.consilium.decisionContext=null;
                await this.renderConsilium();
                ui.toast(action==='sign'?'Решение консилиума подписано.':'Запись возвращена врачу на доработку.','good');
            }
        } catch(error) {
            if(ctx!==this.consilium.decisionContext || ctx.epoch!==this.sessionEpoch || this.sessionExpired)return;
            ctx.blocked=![422,429].includes(error.status);
            $(errorId).textContent=`Действие не подтверждено: ${error.message} Ввод сохранен. Проверьте состояние перед повторным действием.`;
            $(errorId).classList.remove('is-hidden');
            $('consiliumDecisionUncertain').classList.toggle('is-hidden',!ctx.blocked);
        } finally { if(ctx===this.consilium.decisionContext){ctx.busy=false;this.syncConsiliumReviewState(ctx.record);} }
    },

    // История возвратов читается отдельным запросом: сервер отдаёт её только
    // председателю и автору записи.
    async renderConsiliumRevisionHistory(containerId, record) {
        const box = $(containerId), epoch=this.sessionEpoch, read=this.beginRead('consilium-history-'+containerId);
        const current=()=>epoch===this.sessionEpoch && this.isCurrentRead('consilium-history-'+containerId,read) && !this.sessionExpired;
        box.replaceChildren();
        box.classList.add('is-hidden');
        if (!record || !record.revisionCount) return;
        try {
            const data = await apiGetJson(`/api/consilium/appointments/${encodeURIComponent(record.id)}/revisions`);
            if(!current())return;
            const items = data.revisions || [];
            if (!items.length) return;
            box.replaceChildren(
                el('h3', { class: 'consilium-revision-history__title', text: 'История возвратов' }),
                el('ol', { class: 'consilium-revision-history__list' }, items.map(item => el('li', {}, [
                    el('div', { class: 'consilium-revision-history__meta', text: [
                        `Раунд ${item.round}`,
                        item.returnedAt ? this.formatDateTime(item.returnedAt) : '',
                        item.migrated ? 'перенесено из прежней версии' : item.returnedByName,
                    ].filter(Boolean).join(' · ') }),
                    el('div', { class: 'consilium-revision-history__text', text: item.comment }),
                    item.resubmittedAt ? el('div', { class: 'consilium-revision-history__meta', text: [
                        'Повторно отправлено',
                        this.formatDateTime(item.resubmittedAt),
                        item.resubmissionMigrated ? 'перенесено из прежней версии' : item.resubmittedByName,
                    ].filter(Boolean).join(' · ') }) : null,
                ]))),
            );
            box.classList.remove('is-hidden');
        } catch (error) {
            if(!current())return;
            box.replaceChildren(el('p', { class: 'muted', text: 'Историю возвратов загрузить не удалось.' }));
            box.classList.remove('is-hidden');
        }
    },

    syncConsiliumReviewState(record) {
        const ctx=this.consilium.decisionContext;
        if(!ctx)return;
        if(record)ctx.record=record;
        const inReview=ctx.record?.status==='in_review', ready=this.consiliumDecisionReady();
        $('consiliumReviewHint').classList.toggle('is-hidden',inReview || !['recorded','revised'].includes(ctx.record?.status));
        $('startConsiliumReviewBtn').classList.toggle('is-hidden',inReview);
        $('startConsiliumReviewBtn').disabled=!ready || !['recorded','revised'].includes(ctx.record?.status);
        $('signConsiliumBtn').disabled = !inReview;
        if(!ready)$('signConsiliumBtn').disabled=true;
        $('signConsiliumBtn').classList.toggle('is-hidden',!inReview);
        $('returnConsiliumBtn').classList.toggle('is-hidden',!inReview);
        $('returnConsiliumBtn').disabled=!ready || !inReview;
        $('confirmConsiliumRevisionBtn').disabled=!ready || !inReview;
        $('refreshConsiliumDecisionBtn').disabled=ctx.busy;
        $('refreshConsiliumRevisionBtn').disabled=ctx.busy;
        $('consiliumDecisionForm').setAttribute('aria-busy',String(ctx.busy));
        for(const node of $('consiliumDecisionForm').querySelectorAll('input,select,textarea'))node.disabled=ctx.busy;
        $('consiliumRevisionComment').disabled=ctx.busy;
        $('cancelConsiliumRevisionBtn').disabled=ctx.busy;
    },

    async startConsiliumReview() {
        const appointmentId=this.consilium.decisionId;
        await this.runConsiliumDecisionAction('review',{},`/api/consilium/appointments/${encodeURIComponent(appointmentId)}/review`);
    },

    async submitConsiliumDecision(event) {
        event.preventDefault();
        if (!this.consiliumDecisionReady() || this.consilium.decisionContext.record?.status !== 'in_review' ||
            ui.topModal() !== 'consiliumDecisionModal') return;
        const ctx = this.consilium.decisionContext;
        const treatmentType=$('consiliumTreatmentType').value,treatmentScheme=$('consiliumTreatmentScheme').value.trim();
        this.syncConsiliumTreatmentScheme();
        if(!treatmentType || (treatmentType==='chemotherapy'&&!treatmentScheme)) {
            $('consiliumDecisionError').textContent='Выберите лечение и, для химиотерапии, укажите схему.';
            $('consiliumDecisionError').classList.remove('is-hidden');return;
        }
        const values = this.consiliumDecisionValues();
        ctx.confirmingSign = true;
        const confirmed = await ui.confirm({
            title: 'Подписать решение консилиума?',
            text: 'Подписанное решение и медицинский снимок сохранятся без возможности изменить их.',
            okLabel: 'Подписать решение',
        });
        ctx.confirmingSign = false;
        if (!confirmed || this.consilium.decisionContext !== ctx || !this.consiliumDecisionReady() ||
            ui.topModal() !== 'consiliumDecisionModal' || values !== this.consiliumDecisionValues()) return;
        await this.runConsiliumDecisionAction('sign', {
            treatmentType, treatmentScheme: $('consiliumTreatmentScheme').value.trim(),
            treatmentSchemeCode: $('consiliumTreatmentSchemeCode').value.trim(),
            goc: $('consiliumGoc').checked, goc65Plus: $('consiliumGoc65Plus').checked,
        });
    },

    openConsiliumRevision() {
        if(!this.consiliumDecisionReady() || this.consilium.decisionContext.record?.status!=='in_review')return;
        $('consiliumRevisionComment').value='';$('consiliumRevisionError').classList.add('is-hidden');
        // Keep the decision draft in its original form underneath the return dialog.
        ui.openModal('consiliumRevisionModal');
    },

    async submitConsiliumRevision(event) {
        event.preventDefault();
        const comment=$('consiliumRevisionComment').value.trim();
        if(!comment){$('consiliumRevisionError').textContent='Комментарий для врача обязателен.';$('consiliumRevisionError').classList.remove('is-hidden');return;}
        await this.runConsiliumDecisionAction('return',{comment});
    },

    /* ================================================= СМЕНА ЛЕЧАЩЕГО ВРАЧА */

    async openDoctorModal(patientId) {
        const p = this.getPatient(patientId);
        if (!p) return;
        this.doctorModalPatientId = patientId;
        $('doctorModalCurrent').textContent =
            `Текущий врач: ${p.treatingDoctorName || p.doctor || 'не сопоставлен'}. Пациент: ${p.name}.`;
        let doctors = [];
        try {
            doctors = (await apiGetJson('/api/users/doctors')).doctors || [];
        } catch (e) {
            ui.toast('Не удалось загрузить список врачей: ' + e.message, 'danger');
            return;
        }
        $('doctorModalSelect').replaceChildren(frag([
            option('', '— Не сопоставлен —', !p.treatingDoctorUserId),
            ...doctors.map(d => option(d.id, d.fullName, d.id === p.treatingDoctorUserId)),
        ]));
        this.updateDoctorModalDept();
        ui.openModal('doctorModal');
    },

    async updateDoctorModalDept() {
        const userId = $('doctorModalSelect').value;
        const hint = $('doctorModalDept');
        if (!userId) {
            hint.textContent = 'Пациент попадёт в список «Несопоставленные лечащие врачи».';
            return;
        }
        try {
            const data = await apiGetJson('/api/departments');
            const names = data.departments
                .filter(d => d.doctors.some(doc => doc.id === userId))
                .map(d => d.name);
            hint.textContent = names.length
                ? `Отделение врача: ${names.join(', ')}`
                : 'Врач не состоит ни в одном отделении — заведующие его пациентов не увидят.';
        } catch (e) {
            hint.textContent = '';
        }
    },

    async submitDoctorChange(event) {
        event.preventDefault();
        const patientId = this.doctorModalPatientId;
        const userId = $('doctorModalSelect').value || null;
        const cached = this.getPatient(patientId);
        try {
            const updated = await apiPut(`/api/patients/${patientId}/treating-doctor`,
                { userId, expectedVersion: cached ? cached.version : undefined });
            this.replacePatientInCache(updated);
            ui.closeModal('doctorModal');
            ui.toast('Лечащий врач изменён. Область доступа обновлена.', 'good');
            this.refreshCurrent();
        } catch (e) {
            if (this.isStaleRecord(e)) {
                ui.closeModal('doctorModal');
                await this.reloadAfterStaleRecord(patientId, e);
                return;
            }
            ui.toast('Не удалось сменить врача: ' + e.message, 'danger');
        }
    },

    /* ======================================================== РАЗДЕЛ «СОТРУДНИКИ» */

    ROLE_LABELS: {
        developer: 'Разработчик',
        deputy_chief_oncology: 'Заместитель главного врача по онкологии',
        caop_head: 'Заведующий ЦАОП',
        department_head: 'Заведующий отделением',
        doctor: 'Врач',
        consilium_chair: 'Председатель онкологического консилиума',
    },
    STATUS_LABELS: { active: 'Активен', blocked: 'Заблокирован', deactivated: 'Деактивирован' },

    staffFilters: { query: '', role: '', department: '', status: '' },

    async loadStructureData() {
        const data = await apiGetJson('/api/departments');
        this.departments = data.departments || [];
        this.doctorsWithoutDepartment = data.doctorsWithoutDepartment || [];
    },

    managementReadTicket(key, params) {
        return {key, version:this.beginRead(key), epoch:this.sessionEpoch, owner:this.user?.id, access:this.user?.accessContext, params};
    },
    managementReadCurrent(ticket, params) {
        return !!ticket && !!this.user && !this.sessionExpired && !this.sessionReconciling &&
            ticket.owner===this.user.id && ticket.access===this.user.accessContext && ticket.epoch===this.sessionEpoch &&
            this.isCurrentRead(ticket.key,ticket.version) && ticket.params===params;
    },
    staffActionCurrent(user, ticket=this.staffReadTicket) {
        return this.can('manageUsers') && this.staffReadState==='ready' && this.managementReadCurrent(ticket,JSON.stringify(this.staffFilters)) &&
            (!user || this.staffUsers.includes(user));
    },
    setStaffReadState(state) {
        this.staffReadState=state;
        $('view-staff').setAttribute('aria-busy',String(state==='loading'));
        $('openStaffCreateBtn').disabled=state!=='ready';
        if(state==='ready')return;
        this.staffUsers=[];$('staffBody').replaceChildren();
        $('staffEmpty').classList.remove('is-hidden');
        $('staffEmpty').replaceChildren(el('span',{text:state==='loading'?'Загрузка сотрудников…':'Не удалось загрузить сотрудников. Фильтры сохранены.'}));
        if(state==='error')$('staffEmpty').append(el('button',{type:'button',class:'btn btn--ghost',text:'Повторить загрузку сотрудников',on:{click:()=>this.renderStaff()}}));
    },
    async renderStaff() {
        if (!this.can('manageUsers') || this.sessionExpired || this.sessionReconciling) return;
        const filters=structuredClone(this.staffFilters), ticket=this.managementReadTicket('staff',JSON.stringify(filters));
        this.staffReadTicket=ticket;this.setStaffReadState('loading');
        const current=()=>this.can('manageUsers')&&this.managementReadCurrent(ticket,JSON.stringify(this.staffFilters));
        try {
            const structure=await apiGetJson('/api/departments');if(!current())return;
            const params=new URLSearchParams();for(const [key,value] of Object.entries(filters))if(value)params.set(key,value);
            const data=await apiGetJson('/api/users'+(params.size?'?'+params:''));if(!current())return;
            this.departments=structure.departments||[];this.doctorsWithoutDepartment=structure.doctorsWithoutDepartment||[];
            this.staffUsers=data.users;this.setStaffReadState('ready');this.fillStaffFilterSelects();
            const empty=$('staffEmpty');empty.classList.toggle('is-hidden',!!this.staffUsers.length);
            empty.textContent='Сотрудники не найдены. Измените фильтры или создайте учетную запись.';
            $('staffBody').replaceChildren(frag(this.staffUsers.map(user=>this.staffRow(user))));
        } catch(error) { if(current())this.setStaffReadState('error'); }
    },

    fillStaffFilterSelects() {
        const roleSel = $('staffRoleFilter');
        if (!roleSel.options.length) {
            roleSel.replaceChildren(frag([
                option('', 'Все роли', true),
                ...Object.entries(this.ROLE_LABELS).map(([id, label]) => option(id, label)),
            ]));
            $('staffStatusFilter').replaceChildren(frag([
                option('', 'Все статусы', true),
                ...Object.entries(this.STATUS_LABELS).map(([id, label]) => option(id, label)),
            ]));
        }
        const deptSel = $('staffDeptFilter');
        const current = this.staffFilters.department;
        deptSel.replaceChildren(frag([
            option('', 'Все отделения', !current),
            ...this.departments.map(d => option(d.id, d.name, d.id === current)),
        ]));
    },

    staffRow(u) {
        const deptNames = (u.departments || []).map(d => d.name).join(', ') || '—';
        const statusChipClass = { active: 'chip--good', blocked: 'chip--danger', deactivated: 'chip--neutral' }[u.status] || 'chip--neutral';
        const ticket=this.staffReadTicket;
        const actionBtn = (label, handler) => el('button', {
            type: 'button', class: 'btn btn--ghost btn--sm', text: label, on: { click:()=>{if(this.staffActionCurrent(u,ticket))handler();} },
        });
        const actions = [actionBtn('Изменить', () => this.openStaffModal(u))];
        if (u.status === 'active') {
            actions.push(actionBtn('Блокировать', () => this.setStaffStatus(u, 'blocked')));
            actions.push(actionBtn('Деактивировать', () => this.setStaffStatus(u, 'deactivated')));
        } else {
            actions.push(actionBtn('Восстановить', () => this.setStaffStatus(u, 'active')));
        }
        actions.push(actionBtn('Сброс пароля', () => this.resetStaffPassword(u)));
        actions.push(actionBtn('Завершить сессии', () => this.terminateStaffSessions(u)));
        return el('tr', {}, [
            el('td', {}, el('div', { class: 'person__name', text: u.fullName })),
            el('td', {}, el('code', { text: u.username })),
            el('td', { text: u.roleLabel }),
            el('td', { text: deptNames }),
            el('td', {}, el('span', { class: `chip ${statusChipClass}`, text: this.STATUS_LABELS[u.status] || u.status })),
            el('td', { class: 'cell-when', text: u.lastLoginAt ? this.formatDateTime(u.lastLoginAt) : '—' }),
            el('td', { class: 'cell-actions' }, actions),
        ]);
    },

    openStaffModal(existing) {
        if(!this.staffActionCurrent(existing))return;
        this.staffEditorIdentity={owner:this.user.id,epoch:this.sessionEpoch,access:this.user.accessContext};
        this.staffModalUserId = existing ? existing.id : null;
        $('staffModalTitle').textContent = existing ? 'Изменить сотрудника' : 'Новый сотрудник';
        $('staffForm').reset();
        $('staffFormError').classList.add('is-hidden');
        $('staffRole').replaceChildren(frag(
            Object.entries(this.ROLE_LABELS).map(([id, label]) =>
                option(id, label, existing ? existing.roleId === id : id === 'doctor')),
        ));
        const selectedDepts = new Set((existing ? existing.departments : []).map(d => d.id));
        $('staffDepartments').replaceChildren(frag(
            this.departments
                .filter(d => d.status === 'active' || selectedDepts.has(d.id))
                .map(d => option(d.id, d.name, selectedDepts.has(d.id))),
        ));
        if (existing) {
            $('staffFullName').value = existing.fullName;
            $('staffUsername').value = existing.username;
            $('staffUsername').disabled = true;   // логин неизменяем
            $('staffPasswordField').classList.add('is-hidden');
            $('staffMustChangeField').classList.add('is-hidden');
        } else {
            $('staffUsername').disabled = false;
            $('staffPasswordField').classList.remove('is-hidden');
            $('staffMustChangeField').classList.remove('is-hidden');
            $('staffMustChange').checked = true;
        }
        ui.openModal('staffModal');
    },

    async submitStaffForm(event) {
        event.preventDefault();
        const identity=this.staffEditorIdentity;
        if(!this.can('manageUsers')||this.sessionExpired||this.sessionReconciling||!identity||identity.owner!==this.user?.id||identity.epoch!==this.sessionEpoch||identity.access!==this.user.accessContext)return;
        const errorBox = $('staffFormError');
        errorBox.classList.add('is-hidden');
        const departmentIds = [...$('staffDepartments').selectedOptions].map(o => o.value);
        try {
            if (this.staffModalUserId) {
                await apiPatch(`/api/users/${this.staffModalUserId}`, {
                    fullName: $('staffFullName').value,
                    roleId: $('staffRole').value,
                    departmentIds,
                });
                ui.toast('Данные сотрудника обновлены.', 'good');
            } else {
                if (!$('staffPassword').value) {
                    errorBox.textContent = 'Задайте временный пароль (не короче 15 символов).';
                    errorBox.classList.remove('is-hidden');
                    return;
                }
                await apiPost('/api/users', {
                    username: $('staffUsername').value.trim(),
                    fullName: $('staffFullName').value,
                    roleId: $('staffRole').value,
                    password: $('staffPassword').value,
                    mustChangePassword: $('staffMustChange').checked,
                    departmentIds,
                });
                ui.toast('Учётная запись создана.', 'good');
            }
            // Пароль не задерживается в DOM дольше необходимого
            $('staffPassword').value = '';
            ui.closeModal('staffModal');
            this.renderStaff();
        } catch (e) {
            errorBox.textContent = e.message;
            errorBox.classList.remove('is-hidden');
        }
    },

    async setStaffStatus(u, status) {
        const ticket=this.staffReadTicket;if(!this.staffActionCurrent(u,ticket))return;
        const texts = {
            blocked: `Заблокировать «${u.fullName}»? Все активные сессии будут завершены, вход станет невозможен.`,
            deactivated: `Деактивировать «${u.fullName}»? Учётная запись сохранится, но вход станет невозможен.`,
            active: `Восстановить доступ для «${u.fullName}»?`,
        };
        const confirmed = await ui.confirm({
            title: 'Изменить статус сотрудника?',
            text: texts[status],
            okLabel: 'Подтвердить',
            danger: status !== 'active',
        });
        if (!confirmed || !this.staffActionCurrent(u,ticket)) return;
        try {
            await apiPatch(`/api/users/${u.id}`, { status });
            ui.toast('Статус обновлён.', 'good');
            this.renderStaff();
        } catch (e) {
            ui.toast('Не удалось изменить статус: ' + e.message, 'danger');
        }
    },

    generateTempPassword() {
        const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
        const bytes = new Uint32Array(14);
        crypto.getRandomValues(bytes);
        return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
    },

    async resetStaffPassword(u) {
        const ticket=this.staffReadTicket;if(!this.staffActionCurrent(u,ticket))return;
        // Временный пароль показывается ровно один раз — в этом подтверждении.
        const tempPassword = this.generateTempPassword();
        const confirmed = await ui.confirm({
            title: 'Сбросить пароль?',
            text: `Новый временный пароль для «${u.fullName}»: ${tempPassword}\n`
                + 'Запишите его сейчас — он показывается только один раз. '
                + 'Все сессии сотрудника будут завершены, при входе потребуется смена пароля.',
            okLabel: 'Сбросить',
        });
        if (!confirmed || !this.staffActionCurrent(u,ticket)) return;
        try {
            await apiPost(`/api/users/${u.id}/reset-password`,
                { newPassword: tempPassword, mustChangePassword: true });
            ui.toast('Пароль сброшен. Сессии сотрудника завершены.', 'good');
        } catch (e) {
            ui.toast('Не удалось сбросить пароль: ' + e.message, 'danger');
        }
    },

    async terminateStaffSessions(u) {
        const ticket=this.staffReadTicket;if(!this.staffActionCurrent(u,ticket))return;
        const confirmed = await ui.confirm({
            title: 'Завершить сессии?',
            text: `Все активные сессии «${u.fullName}» будут завершены немедленно.`,
            okLabel: 'Завершить',
        });
        if (!confirmed || !this.staffActionCurrent(u,ticket)) return;
        try {
            const r = await apiPost(`/api/users/${u.id}/terminate-sessions`);
            ui.toast(`Завершено сессий: ${r.terminated}.`, 'good');
        } catch (e) {
            ui.toast('Не удалось завершить сессии: ' + e.message, 'danger');
        }
    },

    /* ======================================================== РАЗДЕЛ «СТРУКТУРА» */

    async renderStructure() {
        if (!this.can('manageDepartments')) return;
        const panel = $('structurePanel');
        panel.replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
        let headUsers = [];
        let doctorUsers = [];
        try {
            await this.loadStructureData();
            const all = (await apiGetJson('/api/users')).users;
            headUsers = all.filter(u => u.roleId === 'department_head' && u.status === 'active');
            doctorUsers = all.filter(u => u.roleId === 'doctor' && u.status === 'active');
        } catch (e) {
            panel.replaceChildren(el('div', { class: 'empty', text: 'Не удалось загрузить структуру: ' + e.message }));
            return;
        }

        const nodes = [el('h2', { class: 'panel__title', text: 'Отделения' })];
        if (!this.departments.length) {
            nodes.push(el('p', { class: 'panel__text', text: 'Отделений пока нет. Создайте первое — «Новое отделение».' }));
        }
        nodes.push(...this.departments.map(d => this.departmentCard(d, headUsers, doctorUsers)));

        if (this.doctorsWithoutDepartment.length) {
            nodes.push(el('h2', { class: 'panel__title', text: 'Врачи без отделения' }));
            nodes.push(el('ul', { class: 'dept__doctors' },
                this.doctorsWithoutDepartment.map(d => el('li', { text: d.fullName }))));
        }
        panel.replaceChildren(frag(nodes));
        this.renderUnresolvedPanel();
    },

    departmentCard(d, headUsers, doctorUsers) {
        const memberIds = new Set(d.doctors.map(doc => doc.id));
        const addable = doctorUsers.filter(u => !memberIds.has(u.id));
        const headSelect = el('select', { class: 'select', 'aria-label': `Заведующий: ${d.name}` }, [
            option('', d.heads.length ? '— Снять заведующего —' : 'Выберите заведующего', !d.heads.length),
            ...headUsers.map(h => option(h.id, h.fullName, d.heads.some(x => x.id === h.id))),
        ]);
        const addDoctorSelect = el('select', { class: 'select', 'aria-label': `Добавить врача: ${d.name}` }, [
            option('', 'Выберите врача', true),
            ...addable.map(u => option(u.id, u.fullName)),
        ]);
        const archived = d.status === 'archived';
        return el('div', { class: 'dept' }, [
            el('div', { class: 'dept__head' }, [
                el('span', { class: 'dept__name', text: d.name }),
                el('span', {
                    class: `chip ${archived ? 'chip--neutral' : 'chip--good'}`,
                    text: archived ? 'Архив' : 'Активно',
                }),
                el('span', { class: 'muted', text: `Врачей: ${d.doctorCount}` }),
                !d.heads.length && !archived
                    ? el('span', { class: 'chip chip--warning', text: 'Без заведующего' }) : null,
                !archived ? el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Переименовать',
                    on: { click: () => this.renameDepartment(d) },
                }) : null,
                !archived ? el('button', {
                    type: 'button', class: 'btn btn--quiet btn--sm', text: 'Архивировать',
                    on: { click: () => this.archiveDepartment(d) },
                }) : null,
            ]),
            !archived ? el('div', { class: 'dept__row' }, [
                el('span', { class: 'dept__label', text: 'Заведующий:' }),
                headSelect,
                el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Назначить',
                    on: { click: () => this.assignHead(d, headSelect.value) },
                }),
            ]) : el('div', { class: 'dept__row' }, [
                el('span', { class: 'dept__label', text: 'Заведующий:' }),
                el('span', { text: d.heads.map(h => h.fullName).join(', ') || '—' }),
            ]),
            el('ul', { class: 'dept__doctors' }, d.doctors.map(doc => el('li', {}, [
                el('span', { text: doc.fullName }),
                doc.status !== 'active'
                    ? el('span', { class: 'chip chip--neutral', text: this.STATUS_LABELS[doc.status] || doc.status }) : null,
                !archived ? el('button', {
                    type: 'button', class: 'btn btn--quiet btn--sm', text: 'Убрать из отделения',
                    on: { click: () => this.removeDoctorFromDept(d, doc) },
                }) : null,
            ]))),
            !archived ? el('div', { class: 'dept__row' }, [
                el('span', { class: 'dept__label', text: 'Добавить врача:' }),
                addDoctorSelect,
                el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Добавить',
                    on: { click: () => this.addDoctorToDept(d, addDoctorSelect.value) },
                }),
            ]) : null,
        ]);
    },

    async createDepartment() {
        const name = await ui.textPrompt({
            title: 'Новое отделение',
            label: 'Название отделения',
        });
        if (!name) return;
        try {
            await apiPost('/api/departments', { name });
            ui.toast('Отделение создано.', 'good');
            this.renderStructure();
        } catch (e) {
            ui.toast('Не удалось создать отделение: ' + e.message, 'danger');
        }
    },

    async renameDepartment(d) {
        const name = await ui.textPrompt({
            title: 'Переименовать отделение',
            label: 'Новое название',
            value: d.name,
        });
        if (!name || name === d.name) return;
        try {
            await apiPatch(`/api/departments/${d.id}`, { name });
            ui.toast('Отделение переименовано.', 'good');
            this.renderStructure();
        } catch (e) {
            ui.toast('Не удалось переименовать: ' + e.message, 'danger');
        }
    },

    async archiveDepartment(d) {
        const confirmed = await ui.confirm({
            title: 'Архивировать отделение?',
            text: `«${d.name}» перестанет участвовать в области видимости заведующих. `
                + 'Физическое удаление не выполняется: врачи, пациенты и история сохраняются.',
            okLabel: 'Архивировать',
        });
        if (!confirmed) return;
        try {
            await apiDelete(`/api/departments/${d.id}`);
            ui.toast('Отделение архивировано.', 'good');
            this.renderStructure();
        } catch (e) {
            ui.toast('Не удалось архивировать: ' + e.message, 'danger');
        }
    },

    async assignHead(d, headUserId) {
        try {
            if (headUserId) await apiPatch(`/api/departments/${d.id}`, { headUserId });
            else await apiPatch(`/api/departments/${d.id}`, { clearHead: true });
            ui.toast('Заведующий обновлён.', 'good');
            this.renderStructure();
        } catch (e) {
            ui.toast('Не удалось назначить заведующего: ' + e.message, 'danger');
        }
    },

    async addDoctorToDept(d, userId) {
        if (!userId) return;
        try {
            await apiPost(`/api/departments/${d.id}/doctors`, { userId });
            ui.toast('Врач добавлен в отделение.', 'good');
            this.renderStructure();
        } catch (e) {
            ui.toast('Не удалось добавить врача: ' + e.message, 'danger');
        }
    },

    async removeDoctorFromDept(d, doc) {
        const confirmed = await ui.confirm({
            title: 'Убрать врача из отделения?',
            text: `«${doc.fullName}» больше не будет относиться к «${d.name}». `
                + 'Пациенты врача выпадут из области видимости заведующего этого отделения.',
            okLabel: 'Убрать',
        });
        if (!confirmed) return;
        try {
            await apiDelete(`/api/departments/${d.id}/doctors/${doc.id}`);
            ui.toast('Связь врача с отделением удалена.', 'good');
            this.renderStructure();
        } catch (e) {
            ui.toast('Не удалось убрать врача: ' + e.message, 'danger');
        }
    },

    async renderUnresolvedPanel() {
        const panel = $('unresolvedPanel');
        let unresolved = [];
        try {
            unresolved = (await apiGetJson('/api/patients/unresolved')).patients;
        } catch (e) {
            panel.replaceChildren();
            return;
        }
        if (!unresolved.length) {
            panel.replaceChildren(frag([
                el('h2', { class: 'panel__title', text: 'Несопоставленные лечащие врачи' }),
                el('p', { class: 'panel__text', text: 'Все пациенты сопоставлены с учётными записями врачей.' }),
            ]));
            return;
        }
        let doctors = [];
        try {
            doctors = (await apiGetJson('/api/users/doctors')).doctors || [];
        } catch (e) { /* селекты будут пустыми */ }
        panel.replaceChildren(frag([
            el('h2', { class: 'panel__title', text: 'Несопоставленные лечащие врачи' }),
            el('p', {
                class: 'panel__text',
                text: 'Эти пациенты видны только Разработчику и глобальным read-only ролям. '
                    + 'Сопоставьте каждому существующую учётную запись врача — автоматический выбор '
                    + 'при неоднозначных ФИО намеренно не выполняется.',
            }),
            ...unresolved.map(p => {
                const select = el('select', { class: 'select', 'aria-label': `Врач для: ${p.name}` }, [
                    option('', 'Выберите учётную запись врача', true),
                    ...doctors.map(d => option(d.id, d.fullName)),
                ]);
                return el('div', { class: 'dept__row' }, [
                    el('span', { class: 'dept__label', text: p.name }),
                    el('span', { class: 'muted', text: p.legacyDoctor ? `было: ${p.legacyDoctor}` : 'врач не указан' }),
                    select,
                    el('button', {
                        type: 'button', class: 'btn btn--ghost btn--sm', text: 'Сопоставить',
                        on: { click: () => this.resolveLegacyDoctor(p, select.value) },
                    }),
                ]);
            }),
        ]));
    },

    async resolveLegacyDoctor(p, userId) {
        if (!userId) {
            ui.toast('Выберите учётную запись врача.', 'warning');
            return;
        }
        const confirmed = await ui.confirm({
            title: 'Подтвердить сопоставление?',
            text: `Пациент «${p.name}» будет закреплён за выбранным врачом. `
                + 'Врач и заведующий его отделения немедленно получат доступ.',
            okLabel: 'Сопоставить',
            danger: false,
        });
        if (!confirmed) return;
        try {
            await apiPut(`/api/patients/${p.id}/treating-doctor`, { userId, expectedVersion: p.version });
            await this.loadPatients();
            ui.toast('Пациент сопоставлен с врачом.', 'good');
            this.renderStructure();
        } catch (e) {
            ui.toast('Не удалось сопоставить: ' + e.message, 'danger');
        }
    },

    /* ========================================================= ЭКСПОРТ И ИМПОРТ */

    openExportModal() {
        this.exportSelectedIds = new Set();
        this.exportAllSelection=null;
        this.exportHeadFilter = null;
        $('exportSearchInput').value = '';
        this.renderExportHeadsFilter();
        this.renderExportPatientList('');
        ui.openModal('exportModal');
    },

    renderExportHeadsFilter() {
        const heads=this.patientPage?.heads||[];
        $('exportHeadsFilter').replaceChildren(frag([
            el('button',{type:'button',class:'chip-btn',text:'Все',on:{click:()=>this.filterExportByHead(null)}}),
            ...heads.map(h=>el('button',{type:'button',class:'chip-btn',text:h,on:{click:()=>this.filterExportByHead(h)}})),
        ]));
    },

    filterExportByHead(head) {
        this.exportHeadFilter = head; this.exportAllSelection=null;
        this.renderExportHeadsFilter();
        this.renderExportPatientList($('exportSearchInput').value);
    },

    async renderExportPatientList(query, cursor = null, restarted = false) {
        const version=this.beginRead('export-list');
        const p=new URLSearchParams({view:'page',limit:'50',sort:'name',include_terminal:'true'});
        if(query)p.set('q',query);if(this.exportHeadFilter)p.set('head',this.exportHeadFilter);if(cursor)p.set('cursor',cursor);
        try {
            const data=await apiGetJson('/api/patients?'+p);
            if(!this.isCurrentRead('export-list',version))return;
            this.exportPage=data;this.exportQuery=Object.fromEntries([...p].filter(([k])=>k!=='cursor'));
            this.exportPaging ||= {trail:[null],index:0};if(!cursor)this.exportPaging={trail:[null],index:0};
            const rows=data.patients.map(card=>el('label',{class:'pick'},[
                el('input',{type:'checkbox',disabled:!!this.exportAllSelection,checked:!!this.exportAllSelection||this.exportSelectedIds.has(card.id),'aria-label':`Выбрать: ${card.name}`,on:{change:e=>this.toggleExportSelection(card.id,e.target.checked)}}),
                el('div',{},[el('div',{class:'pick__name',text:card.name}),el('div',{class:'pick__meta',text:`${this.getCurrentStageLabel(card)} · ${card.head||''}`})]),
            ]));
            $('exportPatientList').replaceChildren(frag(rows.length?rows:[el('p',{class:'empty',text:'Нет результатов'})]));
            $('exportPatientList').append(this.boundedPager(data,this.exportPaging,next=>this.renderExportPatientList(query,next)));
            this.updateExportCount();
        } catch(error) {
            if(!this.isCurrentRead('export-list',version))return;
            if(!restarted&&[409,410].includes(error.status)&&['PATIENT_QUERY_CHANGED','CURSOR_EXPIRED'].includes(error.data?.code)){this.exportAllSelection=null;ui.toast('Выдача экспорта изменилась. Проверьте выбор.','warning');return this.renderExportPatientList(query,null,true);}
            ui.toast(error.message,'danger');
        }
    },

    toggleExportSelection(id, checked) {
        if (!this.exportSelectedIds) this.exportSelectedIds = new Set();
        if (checked) this.exportSelectedIds.add(id);
        else this.exportSelectedIds.delete(id);
        this.updateExportCount();
    },

    exportSelectAll() {
        if(!this.exportPage)return;
        this.exportAllSelection={query:{...this.exportQuery},revision:this.exportPage.page.revision,total:this.exportPage.page.total};
        this.exportSelectedIds.clear();
        ui.toast('Выбран весь серверный фильтр. Чтобы выбирать по одному, сначала снимите выбор.','good');
        this.renderExportPatientList($('exportSearchInput').value);this.updateExportCount();
    },

    exportSelectNone() {
        this.exportAllSelection=null;this.exportSelectedIds.clear();
        this.renderExportPatientList($('exportSearchInput').value);this.updateExportCount();
    },

    updateExportCount() {
        $('exportSelectedCount').textContent=this.exportAllSelection?this.exportAllSelection.total:(this.exportSelectedIds?.size||0);
        $('exportTotalCount').textContent=this.patientPage?.summary.total||0;
    },

    async confirmExport() {
        if (!this.exportAllSelection && (!this.exportSelectedIds || this.exportSelectedIds.size === 0)) {
            ui.toast('Выберите хотя бы одного пациента.', 'warning');
            return;
        }
        const confirmed = await ui.confirm({
            title: 'Скачать файл с медицинскими данными?',
            text: `В файл попадут данные ${this.exportAllSelection?.total || this.exportSelectedIds.size} пациент(ов): ФИО, диагнозы, контакты. Храните его так же осторожно, как медицинскую карту.`,
            okLabel: 'Скачать',
            danger: false,
        });
        if (!confirmed) return;

        try {
            const ids = Array.from(this.exportSelectedIds);
            const response = await apiFetch(this.exportAllSelection ? '/api/export/selection' : '/api/export?ids=' + encodeURIComponent(ids.join(',')), {
                ...(this.exportAllSelection ? {method:'POST',body:JSON.stringify({query:this.exportAllSelection.query,revision:this.exportAllSelection.revision})} : {}),
                rawResponse: true,
                headers: { 'X-CSRF-Token': getCookie('clinic_csrf') || '' },
            });
            const blob = await response.blob();
            const disposition = response.headers.get('content-disposition') || '';
            const match = disposition.match(/filename="([^"]+)"/);
            const url = URL.createObjectURL(blob);
            const link = el('a', { href: url, download: match ? match[1] : `patients_export_${new Date().toISOString().slice(0, 10)}.json` });
            document.body.append(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
            ui.closeModal('exportModal');
            ui.toast('Файл выгружен.', 'good');
        } catch (e) {
            ui.toast('Не удалось выполнить экспорт: ' + e.message, 'danger');
        }
    },

    triggerImport() {
        $('importFileInput').click();
    },

    handleImportFile(input) {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            ui.toast('Файл слишком большой (максимум 5 МБ).', 'danger');
            input.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = async (event) => {
            this.pendingImportRaw = event.target.result;
            await this.previewImport();
        };
        reader.onerror = () => ui.toast('Не удалось прочитать файл.', 'danger');
        reader.readAsText(file);
        input.value = '';
    },

    async previewImport() {
        try {
            const report = await apiPost('/api/import/preview', { raw: this.pendingImportRaw });
            if (!report.valid) {
                this.showImportErrors(report.errors, report.provenance, report.code);
                return;
            }
            this.showImportReviewModal(report);
        } catch (e) {
            ui.toast('Файл не прошёл проверку: ' + e.message, 'danger');
            this.pendingImportRaw = null;
        }
    },

    // Происхождение файла определяет сервер (подпись системы или её отсутствие);
    // здесь только показ статуса и сброс подтверждения для нового файла.
    renderImportProvenance(provenance) {
        const box = $('importProvenance');
        const confirmField = $('importUnsignedConfirmField');
        $('importUnsignedConfirm').checked = false;
        $('importPreserveIdsConfirm').checked = false;
        $('importHistoricalDecisionsConfirm').checked = false;
        $('importRepeatConfirm').checked = false;
        $('importDuplicateReason').value = '';
        $('importPreserveIdsField').classList.add('is-hidden');
        confirmField.classList.add('is-hidden');
        if (!provenance) {
            box.replaceChildren();
            return;
        }
        const views = {
            verified_signed: ['alert--info', 'Подпись системы проверена'],
            unsigned_legacy: ['alert--warning', 'Происхождение файла не подтверждено'],
            unsigned_external: ['alert--warning', 'Происхождение файла не подтверждено'],
            invalid_signature: ['alert--danger', 'Подпись недействительна — импорт заблокирован'],
            unsupported_signature: ['alert--danger', 'Подпись не может быть проверена — импорт заблокирован'],
        };
        const [tone, title] = views[provenance.status] || ['alert--danger', 'Происхождение файла не определено'];
        const danger = tone === 'alert--danger';
        box.replaceChildren(el('div', { class: `alert ${tone}`, role: danger ? 'alert' : null }, [
            el('strong', { text: title }),
            provenance.status === 'verified_signed' ? null : el('p', { text: provenance.message }),
            provenance.status === 'verified_signed' && provenance.generatedAt
                ? el('p', { text: `Выгрузка сформирована: ${provenance.generatedAt.slice(0, 16).replace('T', ' ')} UTC` })
                : null,
        ]));
        if (provenance.confirmationRequired) confirmField.classList.remove('is-hidden');
    },

    showImportErrors(errors, provenance, code) {
        this.importReport = null;
        this.renderImportProvenance(provenance);
        if (code === 'internal_ids_forbidden') {
            // Решение сервера не зависит от содержимого базы; объясняем правило.
            $('importReviewSummary').replaceChildren(el('div', { class: 'alert alert--danger', role: 'alert' }, [
                el('strong', { text: 'Этот файл нельзя импортировать от вашего имени' }),
                el('p', { text: errors[0] ? errors[0].message : '' }),
            ]));
            $('importModeSelect').disabled = true;
            $('confirmImportCommitBtn').disabled = true;
            ui.openModal('importReviewModal');
            return;
        }
        $('importReviewSummary').replaceChildren(frag([
            el('p', { class: 'alert alert--danger', text: `Файл не прошёл проверку и не будет импортирован. Ошибок: ${errors.length}.` }),
            ...errors.slice(0, 10).map(err => el('div', { class: 'plan-row' }, [
                el('span', { class: 'plan-row__date', text: `запись ${err.index === null || err.index === undefined ? '—' : err.index + 1}` }),
                el('span', { text: `${err.field}: ${err.message}` }),
            ])),
        ]));
        $('importModeSelect').disabled = true;
        $('confirmImportCommitBtn').disabled = true;
        ui.openModal('importReviewModal');
    },

    showImportReviewModal(report) {
        this.importReport = report;
        this.renderImportProvenance(report.provenance);
        $('importModeSelect').disabled = false;
        $('confirmImportCommitBtn').disabled = false;
        $('importReviewSummary').replaceChildren(frag([
            el('div', { class: 'stats' }, [
                el('div', { class: 'stat' }, [
                    el('div', { class: 'stat__label', text: 'Записей в файле' }),
                    el('div', { class: 'stat__value', text: String(report.totalRecords) }),
                ]),
                el('div', { class: 'stat' }, [
                    el('div', { class: 'stat__label', text: 'Новых' }),
                    el('div', { class: 'stat__value', text: String(report.newRecords) }),
                ]),
                el('div', { class: 'stat' }, [
                    el('div', { class: 'stat__label', text: 'Совпадают по ID' }),
                    el('div', { class: 'stat__value', text: String(report.existingMatches) }),
                ]),
            ]),
        ]));
        this.updateImportModeHint();
        ui.openModal('importReviewModal');
    },

    updateImportModeHint() {
        const mode = $('importModeSelect').value;
        const hints = {
            add: 'Записи из файла будут добавлены как новые карточки; существующие данные не изменятся. Подписанный файл разработчика сохраняет прежние идентификаторы только после отдельного подтверждения.',
            update: 'Совпадающие по идентификатору карточки не перезаписываются: допускается только дописать новые события. Если карточка изменилась после выгрузки, импорт будет отклонён.',
            replace: 'Только для пустой базы: существующие пациенты не удаляются. Если в базе есть пациенты, импорт будет отклонён.',
        };
        $('importModeHint').textContent = hints[mode] || '';
        this.renderImportConsiliumImpact(mode);
    },

    // Влияние режима на записи консилиума считает сервер (то же правило, что
    // отклонит импорт при подтверждении); здесь только показ.
    // Так же сервер считает удалённые события истории, которые режим стёр бы
    // или снова сделал активными; сервер повторит проверку при подтверждении.
    renderImportConsiliumImpact(mode) {
        const box = $('importConsiliumImpact');
        const impact = (this.importReport && this.importReport.consiliumImpact || {})[mode];
        const archive = (this.importReport && this.importReport.archivedEventsImpact || {})[mode];
        const duplicate = (this.importReport && this.importReport.duplicateImpact || {})[mode];
        // Совпадения с недоступными карточками сервер сообщает обобщённо, без деталей.
        const access = (this.importReport && this.importReport.accessImpact || {})[mode];
        const accessBlocked = Boolean(access && access.blocked);
        const consiliumBlocked = Boolean(impact && impact.blocked);
        const archiveBlocked = Boolean(archive && archive.blocked);
        const duplicateBlocked = Boolean(duplicate && duplicate.blocked);
        // Что update/replace сделали бы с существующими карточками (решение A).
        const overwrite = (this.importReport && this.importReport.overwriteImpact || {})[mode];
        const overwriteBlocked = Boolean(overwrite && overwrite.blocked);
        // Создание карточек с прежними id — отдельная отметка для этого режима (решение C).
        const preserve = (this.importReport && this.importReport.idPreservation || {})[mode];
        const preserveRequired = Boolean(preserve && preserve.required);
        $('importPreserveIdsField').classList.toggle('is-hidden', !preserveRequired);
        // Перенос исторических решений ОК — отдельная отметка для этого режима (WP2.2-B).
        const historical = (this.importReport && this.importReport.historicalDecisions || {})[mode];
        const historicalRequired = Boolean(historical && historical.required);
        $('importHistoricalDecisionsField').classList.toggle('is-hidden', !historicalRequired);
        // WP2.4-B (U4): вы уже импортировали этот файл — повтор только с отдельной отметкой.
        const previous = this.importReport && this.importReport.previouslyImported;
        const repeatRequired = Boolean(previous);
        $('importRepeatField').classList.toggle('is-hidden', !repeatRequired);
        // WP2.4-B (U9): повторяющиеся номера полисов в записях файла — режим, создающий карточки, недоступен.
        const policyDuplicates = (this.importReport && this.importReport.filePolicyDuplicates || {})[mode];
        const policyDuplicatesBlocked = Boolean(policyDuplicates && policyDuplicates.blocked);
        // WP2.4-C: записи файла совпадают по полису с карточками вашей области — нужна причина.
        const possible = (this.importReport && this.importReport.possibleDuplicates || {})[mode];
        const possibleRows = (possible && possible.rows) || [];
        // C-01: совпадений больше лимита — режим недоступен, подтверждать неполный список нельзя.
        const limitExceeded = Boolean(possible && possible.limitExceeded);
        $('importDuplicateField').classList.toggle('is-hidden', !possibleRows.length || limitExceeded);
        const provenance = this.importReport && this.importReport.provenance;
        // Неподписанный файл: без отдельной отметки подтверждения кнопка недоступна.
        const needsConfirmation = (Boolean(provenance && provenance.confirmationRequired) && !$('importUnsignedConfirm').checked)
            || (preserveRequired && !$('importPreserveIdsConfirm').checked)
            || (historicalRequired && !$('importHistoricalDecisionsConfirm').checked)
            || (repeatRequired && !$('importRepeatConfirm').checked)
            || (possibleRows.length > 0 && !$('importDuplicateReason').value.trim());
        const blocked = consiliumBlocked || archiveBlocked || duplicateBlocked || accessBlocked || overwriteBlocked
            || policyDuplicatesBlocked || limitExceeded || needsConfirmation || Boolean(this.importCommitPending);
        $('confirmImportCommitBtn').disabled = blocked;
        const overwriteAlert = overwrite && (overwrite.blocked || mode === 'update')
            ? el('div', { class: `alert ${overwrite.blocked ? 'alert--danger' : 'alert--info'}`, role: overwrite.blocked ? 'alert' : null }, [
                el('strong', { text: overwrite.blocked ? 'Этот режим импорта недоступен: возможна потеря данных' : 'Последствия обновления' }),
                mode === 'update'
                    ? el('ul', { class: 'import-consilium-impact' }, [
                        el('li', { text: `Карточек без изменений: ${overwrite.unchanged}` }),
                        el('li', { text: `Карточек, куда будут дописаны новые события: ${overwrite.updated} (событий: ${overwrite.appendedEvents})` }),
                        overwrite.conflicts ? el('li', { text: `Карточек с расхождениями: ${overwrite.conflicts}` }) : null,
                    ])
                    : null,
                overwrite.reason ? el('p', { text: overwrite.reason }) : null,
            ])
            : null;
        const preserveAlert = preserveRequired
            ? el('div', { class: 'alert alert--warning' }, [
                el('strong', { text: `Будут созданы карточки с прежними идентификаторами: ${preserve.patients}` }),
                el('p', { text: preserve.message }),
            ])
            : null;
        const duplicateAlert = duplicateBlocked
            ? el('div', { class: 'alert alert--danger', role: 'alert' }, [
                el('strong', { text: 'Этот режим импорта недоступен: записи уже есть в базе' }),
                el('p', { text: duplicate.reason }),
            ])
            : null;
        const archiveAlert = archiveBlocked
            ? el('div', { class: 'alert alert--danger', role: 'alert' }, [
                el('strong', { text: 'Этот режим импорта недоступен: удалённые события истории' }),
                el('ul', { class: 'import-consilium-impact' }, [
                    el('li', { text: `Пациентов с удалёнными событиями: ${archive.patients}` }),
                    el('li', { text: `Удалённых событий: ${archive.events}` }),
                ]),
                el('p', { text: archive.reason }),
                archive.advice ? el('p', { text: archive.advice }) : null,
            ])
            : null;
        const accessAlert = accessBlocked
            ? el('div', { class: 'alert alert--danger', role: 'alert' }, [
                el('strong', { text: 'Этот режим импорта недоступен' }),
                el('p', { text: access.reason }),
            ])
            : null;
        const historicalAlert = historicalRequired
            ? el('div', { class: 'alert alert--warning' }, [
                el('strong', { text: `Файл содержит решения ОК: ${historical.decisions}` }),
                el('p', { text: historical.message }),
            ])
            : null;
        // FIX1-P3: фактические даты из будущего в исторической выгрузке — импорт их не меняет, только предупреждает.
        const future = (this.importReport && this.importReport.futureFacts || {})[mode];
        const futureAlert = future && future.facts
            ? el('div', { class: 'alert alert--warning' }, [
                el('strong', { text: `Фактические даты позже сегодняшней: ${future.facts} (карточек: ${future.patients})` }),
                el('p', { text: future.message }),
            ])
            : null;
        // FIX2: неподтверждённые факты, переданные файлом (дата уже наступила), — отдельный показатель.
        const unverified = (this.importReport && this.importReport.unverifiedFacts || {})[mode];
        const unverifiedAlert = unverified && unverified.facts
            ? el('div', { class: 'alert alert--warning' }, [
                el('strong', { text: `Неподтверждённые фактические даты из файла: ${unverified.facts} (карточек: ${unverified.patients})` }),
                el('p', { text: unverified.message }),
            ])
            : null;
        const repeatAlert = repeatRequired
            ? el('div', { class: 'alert alert--warning' }, [
                el('strong', { text: 'Вы уже импортировали этот файл' }),
                el('p', { text: `Предыдущий импорт: ${this.formatDateTime(previous.importedAt)}; добавлено ${previous.added}, обновлено ${previous.updated}. Повторный импорт выполняется только после отдельной отметки ниже.` }),
            ])
            : null;
        const policyDuplicatesAlert = policyDuplicatesBlocked
            ? el('div', { class: 'alert alert--danger', role: 'alert' }, [
                el('strong', { text: 'Этот режим импорта недоступен: повторяющиеся номера полисов в файле' }),
                el('p', { text: policyDuplicates.reason }),
            ])
            : null;
        const limitAlert = limitExceeded
            ? el('div', { class: 'alert alert--danger', role: 'alert' }, [
                el('strong', { text: 'Этот режим импорта недоступен: слишком много совпадений номера полиса' }),
                el('p', { text: `Записи файла: ${(possible.limitExceededRows || []).join(', ')}. В вашей области доступа `
                    + 'больше 50 карточек с совпадающими номерами полиса ОМС. Подтвердить неполный список нельзя: '
                    + 'нужен ручной разбор этих карточек или исправление файла.' }),
            ])
            : null;
        const possibleAlert = possibleRows.length && !limitExceeded
            ? el('div', { class: 'alert alert--warning' }, [
                el('strong', { text: 'Возможные дубли среди ваших карточек' }),
                el('ul', { class: 'import-consilium-impact' }, possibleRows.map(r => el('li', {
                    text: `Запись ${r.row}: тот же номер полиса у ${r.matches.map(m => m.name).join(', ')}`,
                }))),
                el('p', { text: 'Совпадение номера полиса не доказывает, что это тот же пациент. Укажите причину импорта ниже.' }),
            ])
            : null;
        const extra = [overwriteAlert, archiveAlert, duplicateAlert, accessAlert, policyDuplicatesAlert, limitAlert, possibleAlert,
            repeatAlert, preserveAlert, historicalAlert, futureAlert, unverifiedAlert].filter(Boolean);
        if (!impact || !impact.records) {
            box.replaceChildren(...extra);
            return;
        }
        box.replaceChildren(el('div', { class: `alert ${consiliumBlocked ? 'alert--danger' : 'alert--info'}`, role: consiliumBlocked ? 'alert' : null }, [
            el('strong', { text: consiliumBlocked ? 'Этот режим импорта недоступен' : 'Записи онкоконсилиума' }),
            el('ul', { class: 'import-consilium-impact' }, [
                el('li', { text: `Будет затронуто записей консилиума: ${impact.records}` }),
                el('li', { text: `Из них подписанных решений: ${impact.signed}` }),
                el('li', { text: `Неподписанных и находящихся в работе: ${impact.unsigned}` }),
                impact.deletedWithHistory
                    ? el('li', { text: `Удалённых записей с сохранённой историей возвратов: ${impact.deletedWithHistory}` })
                    : null,
            ]),
            impact.reason ? el('p', { text: impact.reason }) : null,
            impact.advice ? el('p', { text: impact.advice }) : null,
        ]), ...extra);
    },

    closeImportReviewModal() {
        ui.closeModal('importReviewModal');
        this.pendingImportRaw = null;
        this.importReport = null;
        this.importCommitKey = null;
        this.importCommitSentBody = null;
        $('importUnsignedConfirm').checked = false;
        $('importPreserveIdsConfirm').checked = false;
        $('importHistoricalDecisionsConfirm').checked = false;
        $('importRepeatConfirm').checked = false;
        $('importDuplicateReason').value = '';
    },

    async confirmImportCommit() {
        if (!this.pendingImportRaw) return;
        const mode = $('importModeSelect').value;
        if (mode === 'replace') {
            const sure = await ui.confirm({
                title: 'Загрузить файл в пустую базу?',
                text: 'Режим «полная замена» выполняется только в пустую базу: существующие записи не удаляются, при наличии пациентов сервер отклонит импорт.',
                okLabel: 'Продолжить',
            });
            if (!sure) return;
        }
        const provenance = this.importReport && this.importReport.provenance;
        const body = { raw: this.pendingImportRaw, mode };
        if (provenance && provenance.confirmationRequired) {
            if (!$('importUnsignedConfirm').checked) return;
            // Подтверждение относится к этому файлу (его хешу из проверки) и режиму.
            body.unsignedConfirmation = { confirmed: true, fileSha256: provenance.fileSha256, mode };
        }
        const preserve = (this.importReport && this.importReport.idPreservation || {})[mode];
        if (preserve && preserve.required) {
            if (!$('importPreserveIdsConfirm').checked) return;
            // Отдельное согласие: этот файл, этот режим, создание карточек с прежними id.
            body.preserveIdsConfirmation = {
                confirmed: true, fileSha256: provenance.fileSha256, mode, action: 'create_with_internal_ids',
            };
        }
        const historical = (this.importReport && this.importReport.historicalDecisions || {})[mode];
        if (historical && historical.required) {
            if (!$('importHistoricalDecisionsConfirm').checked) return;
            // Отдельное согласие на перенос исторических решений ОК: этот файл, режим и число решений.
            body.historicalDecisionsConfirmation = {
                confirmed: true, fileSha256: provenance.fileSha256, mode,
                action: 'import_historical_consilium_decisions', decisions: historical.decisions,
            };
        }
        if (this.importReport && this.importReport.previouslyImported) {
            if (!$('importRepeatConfirm').checked) return;
            // WP2.4-B (U4): осознанный повтор файла, который вы уже импортировали: этот файл и режим.
            body.repeatImportConfirmation = {
                confirmed: true, fileSha256: provenance.fileSha256, mode, action: 'repeat_processed_file',
            };
        }
        const possible = (this.importReport && this.importReport.possibleDuplicates || {})[mode];
        if (possible && possible.limitExceeded) return;   // C-01: подтверждать неполный список нельзя
        if (possible && possible.rows && possible.rows.length) {
            const reason = $('importDuplicateReason').value.trim();
            if (!reason) return;
            // WP2.4-C: подтверждение всего набора совпадений из проверки файла; сервер сверит его заново.
            body.duplicateConfirmation = { reason, matchedPatientIds: possible.matchedPatientIds };
        }
        // WP2.4-B: ключ этой операции импорта. Те же данные — тот же ключ (безопасный
        // повтор потерянного ответа); другой режим или подтверждения — новый ключ.
        const bodyText = JSON.stringify(body);
        if (!this.importCommitKey || this.importCommitSentBody !== bodyText) this.importCommitKey = newIdempotencyKey();
        this.importCommitSentBody = bodyText;
        if (this.importCommitPending) return;
        this.importCommitPending = true;
        $('confirmImportCommitBtn').disabled = true;
        let result = null;
        try {
            result = await apiPostIdempotent('/api/import/commit', body, this.importCommitKey);
        } catch (e) {
            // Импорт не подтвержден сервером: окно и ключ остаются, повтор тех же
            // данных безопасен (при уже выполненном импорте сервер вернет его итог).
            if (this.isDuplicateLimitExceeded(e) && this.importReport) {
                // C-01: набор вырос сверх лимита — режим блокируется, поле причины скрыто.
                this.importReport.possibleDuplicates = {
                    ...(this.importReport.possibleDuplicates || {}),
                    [mode]: { rows: [], matchedPatientIds: [], limitExceeded: true, limitExceededRows: e.data.rows || [] },
                };
                $('importDuplicateReason').value = '';
                ui.toast('Импорт не выполнен. ' + apiErrorMessage(e.status, e.data), 'danger');
            } else if (this.isPossibleDuplicate(e) && this.importReport && e.data.rows) {
                // WP2.4-C: набор совпадений изменился — окно показывает актуальный список
                // от сервера, причину нужно указать заново для нового набора.
                this.importReport.possibleDuplicates = {
                    ...(this.importReport.possibleDuplicates || {}),
                    [mode]: { rows: e.data.rows, matchedPatientIds: e.data.matchedPatientIds || [] },
                };
                $('importDuplicateReason').value = '';
                ui.toast('Импорт не выполнен: совпадения с вашими карточками изменились после проверки файла. '
                    + 'Проверьте обновленный список и укажите причину снова.', 'danger');
            } else {
                ui.toast('Импорт не выполнен: ' + e.message, 'danger');
            }
        } finally {
            this.importCommitPending = false;
            if (!result && this.importReport) this.renderImportConsiliumImpact($('importModeSelect').value);
        }
        if (!result) return;
        // B-02: сервер подтвердил импорт — операция закрыта (окно и ключ сброшены).
        // Ошибка обновления экрана дальше не выдается за ошибку импорта.
        this.closeImportReviewModal();
        ui.toast(`Импорт завершён: добавлено ${result.added}, обновлено ${result.updated}, без изменений ${result.unchanged || 0}, пропущено ${result.skipped}.`
            + (result.futureFacts ? ` Фактических дат позже сегодняшней: ${result.futureFacts} — они отмечены в карточках как неподтверждённые.` : '')
            + (result.unverifiedFacts ? ` Неподтверждённых фактических дат из файла: ${result.unverifiedFacts} — отметка сохранена.` : ''),
            (result.futureFacts || result.unverifiedFacts) ? 'warning' : 'good');
        await this.refreshAfterSavedOperation('Импорт сохранен', async () => {
            await this.loadPatients();
            await this.loadActivity();
            this.fillStaticSelects();
            this.showView('patients');
        });
    },
    /* =============================================================== ПРИВЯЗКА */

    listenGlobal(target, type, handler) {
        target.addEventListener(type, handler, {signal: this.globalControls.signal});
    },

    syncSidebarFocus() {
        const sidebar=$('sidebar');if(!sidebar)return;
        const mobile=window.matchMedia('(max-width:860px)').matches;
        const open=$('appScreen').classList.contains('is-nav-open');
        if(mobile&&!open&&sidebar.contains(document.activeElement))$('sidebarToggle').focus();
        sidebar.inert=mobile&&!open;
        if(mobile)sidebar.setAttribute('aria-hidden',open?'false':'true');else sidebar.removeAttribute('aria-hidden');
    },

    bindStaticControls() {
        this.globalControls = new AbortController();
        this.bindPatientNavigation();
        const on = (id, event, handler) => {
            const node = $(id);
            if (node) node.addEventListener(event, handler);
        };

        document.querySelector('.skip-link')?.addEventListener('click', event => {
            event.preventDefault();
            $('workspaceMain').focus();
        });

        // Вход и выход
        $('loginForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            const errorBox = $('loginError');
            errorBox.classList.add('is-hidden');
            const button = $('loginSubmit');
            button.disabled = true;
            try {
                await this.login($('username').value, $('password').value);
                $('password').value = '';
            } catch (err) {
                this.showLoginFailure(err);
                errorBox.classList.remove('is-hidden');
                $('password').focus();
            } finally {
                button.disabled = false;
            }
        });

        // Обязательная смена временного пароля
        $('forcePasswordForm').addEventListener('submit', async (event) => {
            event.preventDefault();
            const errorBox = $('forcePasswordError');
            errorBox.classList.add('is-hidden');
            const pw1 = $('forceNewPassword').value;
            const pw2 = $('forceNewPassword2').value;
            if (pw1 !== pw2) {
                errorBox.textContent = 'Новые пароли не совпадают.';
                errorBox.classList.remove('is-hidden');
                return;
            }
            const button = $('forcePasswordSubmit');
            button.disabled = true;
            try {
                await this.submitForcedPasswordChange($('forceCurrentPassword').value, pw1);
                $('forceCurrentPassword').value = '';
                $('forceNewPassword').value = '';
                $('forceNewPassword2').value = '';
            } catch (err) {
                errorBox.textContent = err.status === 401
                    ? 'Временный пароль указан неверно.'
                    : err.message;
                errorBox.classList.remove('is-hidden');
            } finally {
                button.disabled = false;
            }
        });

        on('logoutBtn', 'click', () => this.logout());
        on('profileDeptsToggle', 'click', () => {
            const list = $('profileDeptsList');
            const open = list.classList.toggle('is-hidden');
            $('profileDeptsToggle').setAttribute('aria-expanded', open ? 'false' : 'true');
        });

        // Сотрудники
        on('openStaffCreateBtn', 'click', () => this.openStaffModal(null));
        on('closeStaffBtn', 'click', () => ui.closeModal('staffModal'));
        on('closeStaffIconBtn', 'click', () => ui.closeModal('staffModal'));
        $('staffForm').addEventListener('submit', (event) => this.submitStaffForm(event));
        on('staffSearchInput', 'input', (event) => {
            this.staffFilters.query = event.target.value;
            this.renderStaff();
        });
        on('staffRoleFilter', 'change', (event) => {
            this.staffFilters.role = event.target.value;
            this.renderStaff();
        });
        on('staffDeptFilter', 'change', (event) => {
            this.staffFilters.department = event.target.value;
            this.renderStaff();
        });
        on('staffStatusFilter', 'change', (event) => {
            this.staffFilters.status = event.target.value;
            this.renderStaff();
        });

        // Структура
        on('openDeptCreateBtn', 'click', () => this.createDepartment());
        on('unresolvedBannerBtn', 'click', () => this.navigateView('structure'));

        // Смена лечащего врача
        $('doctorForm').addEventListener('submit', (event) => this.submitDoctorChange(event));
        on('doctorCancelBtn', 'click', () => ui.closeModal('doctorModal'));
        on('doctorModalSelect', 'change', () => this.updateDoctorModalDept());

        // Онкологический консилиум
        on('openConsiliumBookingBtn', 'click', () => this.openConsiliumModal());
        on('openConsiliumArchiveBtn', 'click', () => this.openConsiliumArchive());
        on('openConsiliumHistoryBtn','click',()=>this.openConsiliumArchive(true));
        on('consiliumArchiveRefreshBtn','click',()=>this.loadConsiliumArchive());
        on('consiliumRegistrySearch','input',()=>this.renderConsiliumRegistries());
        $('consiliumAnalyticsForm').addEventListener('submit',event=>this.loadConsiliumAnalytics(event));
        on('closeConsiliumArchiveBtn', 'click', () => ui.closeModal('consiliumArchiveModal'));
        on('closeConsiliumArchiveIconBtn', 'click', () => ui.closeModal('consiliumArchiveModal'));
        on('consiliumRefreshBtn','click',()=>this.renderConsilium());
        on('consiliumArchiveDate', 'change', () => this.renderConsiliumArchive());
        on('consiliumArchiveSearch', 'input', () => this.renderConsiliumArchive());
        on('closeConsiliumBtn', 'click', () => ui.closeModal('consiliumModal'));
        on('closeConsiliumIconBtn', 'click', () => ui.closeModal('consiliumModal'));
        on('resubmitConsiliumBtn', 'click', () => this.resubmitConsiliumAppointment());
        for(const [kind,view] of [['events','calendar'],['checklists','checklists']]){
            const load=()=>view==='calendar'?this.renderCalendar():this.renderChecklistsView();
            on(kind+'WorkspaceSearch','submit',event=>{event.preventDefault();if(this.currentView!==view||this.sessionExpired)return;this.workspaceListState(kind).query=$(kind+'WorkspaceQuery').value.trim();void load();});
            on(kind+'WorkspaceReset','click',()=>{if(this.currentView!==view||this.sessionExpired)return;$(kind+'WorkspaceQuery').value='';this.workspaceListState(kind).query='';void load();});
            on(kind+'WorkspaceRefresh','click',()=>{if(this.currentView===view&&!this.sessionExpired)void load();});
        }

        on('consiliumBackdatedApptBtn', 'click', () => this.openConsiliumModal(null, null, { backdated: true }));
        on('consiliumBackdatedSlot', 'change', () => this.applyConsiliumBackdatedSlot());
        on('consiliumBackdatedSlotBtn', 'click', () => this.openConsiliumBackdatedSlotModal());
        on('closeConsiliumBackdatedSlotBtn', 'click', () => ui.closeModal('consiliumBackdatedSlotModal'));
        on('closeConsiliumBackdatedSlotIconBtn', 'click', () => ui.closeModal('consiliumBackdatedSlotModal'));
        $('consiliumBackdatedSlotForm').addEventListener('submit', (event) => this.submitConsiliumBackdatedSlot(event));
        on('consiliumBackdatingReasonsBtn', 'click', () => {
            if (this.consilium.detailsItem) this.showConsiliumBackdatingReasons(this.consilium.detailsItem);
        });
        on('consiliumConflictRefreshBtn', 'click', () => this.refreshConsiliumAfterConflict());
        on('consiliumDetailsConflictRefreshBtn', 'click', () => this.refreshConsiliumDetailsAfterConflict());
        on('deleteConsiliumBtn', 'click', () => {
            const item = this.consilium.appointments.find(record => record.id === this.consilium.editingId);
            if (item) this.deleteConsiliumAppointment(item);
        });
        on('consiliumPatient', 'change', () => this.prefillConsiliumDiagnosisFromPatient());
        on('consiliumPatientSearch','input',()=>{clearTimeout(this.candidateSearchTimer);this.candidateSearchTimer=setTimeout(async()=>{const record=this.consilium.appointments.find(a=>a.id===this.consilium.editingId);await this.fillConsiliumPatientsForGroup(record);},300);});
        on('consiliumLocalization', 'input', () => this.fillConsiliumDiagnosisList());
        on('consiliumPrimaryDiagnosis', 'input', () => this.prefillConsiliumGroupFromDiagnosis());
        on('addConsiliumDiagnosisBtn', 'click', () => this.toggleConsiliumAdditionalDiagnosis(true));
        on('removeConsiliumDiagnosisBtn', 'click', () => this.toggleConsiliumAdditionalDiagnosis(false));
        $('consiliumForm').addEventListener('submit', (event) => this.submitConsiliumAppointment(event));
        on('consiliumDateFilter', 'change', (event) => {
            this.consilium.dateFilter = event.target.value;
            this.renderConsilium();
        });
        on('consiliumTodayBtn', 'click', () => {
            this.consilium.dateFilter = this.consiliumToday();
            $('consiliumDateFilter').value = this.consilium.dateFilter;
            this.renderConsilium();
        });
        on('consiliumSearchInput', 'input', (event) => {
            this.consilium.search = event.target.value;
            this.scheduleRead('consilium-search', () => this.renderConsilium({ reuseData: true }), !event.target.value);
        });
        on('consiliumDoctorDate', 'change', (event) => {
            this.consilium.doctorDate = event.target.value;
            this.renderConsiliumSchedule();
        });
        on('consiliumChairOnlyFreeBtn', 'click', () => {
            this.consilium.onlyFree = !this.consilium.onlyFree;
            if (this.consilium.onlyFree) this.consilium.mineOnly = false;
            this.renderConsiliumSchedule();
        });
        on('consiliumDoctorOnlyFreeBtn', 'click', () => {
            this.consilium.onlyFree = !this.consilium.onlyFree;
            if (this.consilium.onlyFree) this.consilium.mineOnly = false;
            this.renderConsiliumSchedule();
        });
        on('consiliumMineOnly', 'click', () => {
            this.consilium.mineOnly = !this.consilium.mineOnly;
            if (this.consilium.mineOnly) this.consilium.onlyFree = false;
            this.renderConsiliumSchedule();
        });
        on('consiliumScheduleDateButton', 'click', () => {
            const picker = $('consiliumScheduleDatePicker');
            const opening = picker.classList.contains('is-hidden');
            picker.classList.toggle('is-hidden', !opening);
            $('consiliumScheduleDateButton').setAttribute('aria-expanded', opening ? 'true' : 'false');
            if (opening) this.renderConsiliumScheduleCalendar();
        });
        on('consiliumScheduleDatePicker','keydown',event=>{
            if(event.key==='Escape'){event.stopPropagation();$('consiliumScheduleDatePicker').classList.add('is-hidden');
                $('consiliumScheduleDateButton').setAttribute('aria-expanded','false');$('consiliumScheduleDateButton').focus();}
        });
        on('consiliumSchedulePrevMonthBtn', 'click', () => {
            const [year, month] = this.consilium.scheduleCalendarMonth.split('-').map(Number);
            this.consilium.scheduleCalendarMonth = this.localDateISO(new Date(year, month - 2, 1));
            this.renderConsiliumScheduleCalendar();
        });
        on('consiliumScheduleNextMonthBtn', 'click', () => {
            const [year, month] = this.consilium.scheduleCalendarMonth.split('-').map(Number);
            this.consilium.scheduleCalendarMonth = this.localDateISO(new Date(year, month, 1));
            this.renderConsiliumScheduleCalendar();
        });
        on('consiliumScheduleGroup', 'change', () => this.syncConsiliumScheduleDateForGroup());
        this.listenGlobal(document, 'click', (event) => {
            ['consiliumChairGroupPicker', 'consiliumDoctorGroupPicker'].forEach(id => {
                const picker = $(id);
                if (picker.open && !picker.contains(event.target)) picker.removeAttribute('open');
            });
            const dateField = document.querySelector('.consilium-schedule-date-field');
            if (dateField && !dateField.contains(event.target)) {
                $('consiliumScheduleDatePicker').classList.add('is-hidden');
                $('consiliumScheduleDateButton').setAttribute('aria-expanded', 'false');
            }
        });
        on('consiliumDoctorTodayBtn', 'click', () => {
            this.consilium.doctorDate = this.consiliumToday();
            $('consiliumDoctorDate').value = this.consilium.doctorDate;
            this.renderConsilium();
        });
        on('consiliumGroup', 'input', async () => {
            const record = this.consilium.editingId
                ? this.consilium.appointments.find(item => item.id === this.consilium.editingId)
                : null;
            const entered = $('consiliumGroup').value.trim().toLowerCase();
            const knownGroup = (this.consilium.meta?.groups || []).some(group =>
                group.value.toLowerCase() === entered || group.label.toLowerCase() === entered
            );
            if (knownGroup) {
                await this.fillConsiliumPatientsForGroup(record);
            }
            this.updateConsiliumAvailableSlots(record);
        });
        on('consiliumDate', 'change', () => this.updateConsiliumAvailableSlots(
            this.consilium.editingId
                ? this.consilium.appointments.find(item => item.id === this.consilium.editingId)
                : null
        ));
        $('consiliumScheduleForm').addEventListener('submit', (event) => this.generateConsiliumSchedule(event));
        on('exportChemoRegistryBtn', 'click', () => this.exportChemotherapyRegistry());
        on('exportGocRegistryBtn', 'click', () => this.exportGocRegistry());
        on('exportGoc65RegistryBtn', 'click', () => this.exportGoc65Registry());
        on('consiliumTreatmentType', 'change', () => this.updateConsiliumSchemeVisibility());
        on('consiliumTreatmentScheme', 'input', () => this.syncConsiliumTreatmentScheme());
        on('consiliumTreatmentScheme', 'change', () => this.syncConsiliumTreatmentScheme());
        on('closeConsiliumDecisionIconBtn', 'click', () => ui.closeModal('consiliumDecisionModal'));
        on('closeConsiliumDetailsIconBtn', 'click', () => ui.closeModal('consiliumDetailsModal'));
        on('closeConsiliumDetailsBtn', 'click', () => ui.closeModal('consiliumDetailsModal'));
        on('consiliumArchiveToggleBtn', 'click', () => this.toggleConsiliumArchive());
        on('refreshConsiliumDecisionBtn','click',()=>this.refreshConsiliumDecision());
        on('refreshConsiliumRevisionBtn','click',()=>this.refreshConsiliumDecision());
        on('consiliumReviewFilter','change',()=>this.renderConsilium({reuseData:true}));
        on('returnConsiliumBtn', 'click', () => this.openConsiliumRevision());
        on('startConsiliumReviewBtn', 'click', () => this.startConsiliumReview());
        $('consiliumDecisionForm').addEventListener('submit', (event) => this.submitConsiliumDecision(event));
        on('cancelConsiliumRevisionBtn', 'click', () => {
            ui.closeModal('consiliumRevisionModal');
        });
        $('consiliumRevisionForm').addEventListener('submit', (event) => this.submitConsiliumRevision(event));

        // Навигация
        for (const item of document.querySelectorAll('.nav__item')) {
            item.addEventListener('click', () => this.navigateView(item.dataset.view));
        }
        on('backToList', 'click', () => browserNavigation.navigate({screen: 'patients',
            registry: browserNavigation.committed?.route.registryReturn}));
        on('backToRegistrySource', 'click', () => {
            if (this.registrySource && this.navigationVisibility()[this.registrySource]) this.navigateView(this.registrySource);
        });
        on('backToF1', 'click', () => {
            const origin = this.f1CardOrigin;
            if (origin === 'calendar') {
                void browserNavigation.navigate({screen: origin, schedule: browserNavigation.committed?.route.scheduleReturn});
            } else if (origin === 'notifications') {
                void browserNavigation.navigate({screen: origin, internalInbox: true});
            } else if (origin === 'analytics') {
                void browserNavigation.navigate({screen: origin, analytics: browserNavigation.committed?.route.analyticsReturn});
            } else if (origin) this.navigateView(origin);
        });
        on('backToAnalyticsSource', 'click', () => {
            const source = this.analytics.source;
            if (source && this.navigationVisibility()[source]) this.navigateView(source);
        });
        on('backToScheduleSource', 'click', () => {
            if (this.workspaceListState('events').source === 'myDay') this.navigateView('myDay');
        });
        on('scheduleNotifications', 'click', () => browserNavigation.navigate({screen: 'notifications', internalInbox: true}));
        on('sidebarToggle', 'click', () => {
            const shell = $('appScreen');
            if (window.matchMedia('(min-width: 861px)').matches && this.can('consiliumChair')) {
                const collapsed = shell.classList.toggle('is-sidebar-collapsed');
                $('sidebarToggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                $('sidebarToggle').setAttribute('aria-label', collapsed ? 'Развернуть меню' : 'Свернуть меню');
                return;
            }
            const open = !shell.classList.contains('is-nav-open');
            shell.classList.toggle('is-nav-open', open);
            $('sidebarScrim').hidden = !open;
            $('sidebarToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        on('sidebarScrim', 'click', () => {
            $('appScreen').classList.remove('is-nav-open');
            $('sidebarScrim').hidden = true;
            $('sidebarToggle').setAttribute('aria-expanded', 'false');
        });

        // Тема
        on('themeToggle', 'click', () => this.toggleTheme());
        on('themeSelect', 'change', (event) => {
            localStorage.setItem('theme', event.target.value);
            this.applyTheme(event.target.value);
        });

        // ИИ-помощник
        on('aiAssistantBtn', 'click', () => this.openAIDrawer());
        on('aiAssistantClose', 'click', () => this.closeAIDrawer());
        on('aiAssistantRefresh','click',()=>this.refreshAIStatus(true));
        on('aiAssistantDrawer','keydown',event=>{if(event.key!=='Tab'||ui.topModal())return;const list=[...$('aiAssistantDrawer').querySelectorAll('button:not([disabled]),textarea:not([disabled]),a[href]')].filter(n=>n.offsetParent!==null);const first=list[0],last=list.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}});
        on('aiAssistantScrim', 'click', () => this.closeAIDrawer());
        on('aiAssistantClearBtn', 'click', () => this.clearAIConversation());
        $('aiAssistantForm').addEventListener('submit', (event) => this.sendAIMessage(event));
        $('aiFallbackForm').addEventListener('submit',event=>this.sendAIMessage(event));
        $('aiAssistantInput').addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.sendAIMessage();
            }
        });

        // Внутренний центр уведомлений
        on('internalNotificationsBell', 'click', () => {
            this.closeAIDrawer(false);
            this.openInternalNotificationsDrawer();
        });
        on('internalNotificationsClose', 'click', () => this.closeInternalNotificationsDrawer());
        on('internalNotificationsDrawer','keydown',(event)=>{
            if(event.key!=='Tab')return;
            const nodes=[...$('internalNotificationsDrawer').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(n=>n.offsetParent!==null);
            if(!nodes.length)return;const first=nodes[0],last=nodes[nodes.length-1];
            if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
            else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
        });
        on('internalNotificationsScrim', 'click', () => this.closeInternalNotificationsDrawer());
        on('internalNotificationsReadAllBtn', 'click', () => this.markAllInternalNotificationsRead());
        on('internalNotificationsFullReadAllBtn','click',()=>this.markAllInternalNotificationsRead());
        on('notificationsPrevBtn','click',()=>{this.notifications.offset=Math.max(0,this.notifications.offset-this.notifications.limit);this.renderNotifications();});
        on('notificationsNextBtn','click',()=>{this.notifications.offset+=this.notifications.limit;this.renderNotifications();});
        on('internalNotificationsFullBtn', 'click', () => {
            this.closeInternalNotificationsDrawer();
            this.navigateView('notifications');
        });
        on('internalNotificationsRefreshBtn', 'click', () => this.renderInternalNotificationCenter());
        on('internalNotificationsSearchInput', 'input', (event) => {
            this.internalNotifications.filters.query = event.target.value;
            this.internalNotifications.filters.offset = 0;
            this.scheduleRead('internal-full', this.renderInternalNotificationCenter, !event.target.value);
        });
        on('internalNotificationsTypeFilter', 'change', (event) => {
            this.internalNotifications.filters.type = event.target.value;
            this.internalNotifications.fullTab = 'all';
            this.internalNotifications.filters.offset = 0;
            this.renderInternalNotificationCenter();
        });
        on('internalNotificationsUnreadFilter', 'change', (event) => {
            this.internalNotifications.filters.unread = event.target.value;
            this.internalNotifications.fullTab = 'all';
            this.internalNotifications.filters.offset = 0;
            this.renderInternalNotificationCenter();
        });
        on('internalNotificationsPrevBtn', 'click', () => {
            const f = this.internalNotifications.filters;
            f.offset = Math.max(0, f.offset - f.limit);
            this.renderInternalNotificationCenter();
        });
        on('internalNotificationsNextBtn', 'click', () => {
            const f = this.internalNotifications.filters;
            f.offset += f.limit;
            this.renderInternalNotificationCenter();
        });

        const sidebarObserver=new MutationObserver(()=>this.syncSidebarFocus());
        sidebarObserver.observe($('appScreen'),{attributes:true,attributeFilter:['class']});
        this.globalControls.signal.addEventListener('abort',()=>sidebarObserver.disconnect(),{once:true});
        window.addEventListener('resize',()=>this.syncSidebarFocus(),{signal:this.globalControls.signal});
        this.syncSidebarFocus();

        // Фильтры списка
        on('resetPatientFiltersBtn', 'click', () => this.resetFilters());
        on('retryPatientListBtn', 'click', () => this.reloadPatientsAndRender());
        on('registryMoreFilters', 'keydown', event => {
            if (event.key === 'Escape' && $('registryMoreFilters').open && !ui.openModals.includes('filtersSheet')) {
                event.preventDefault();$('registryMoreFilters').open=false;$('registryMoreFilters').querySelector('summary').focus();
            }
        });
        this.listenGlobal(document, 'click', event => {
            if (!ui.openModals.includes('filtersSheet') && !$('registryMoreFilters').contains(event.target) && !$('filtersSheet').contains(event.target)) $('registryMoreFilters').open=false;
        });
        on('searchInput', 'input', (event) => {
            this.searchQuery = event.target.value;
            clearTimeout(this.patientSearchTimer);
            this.beginRead('patients');
            this.setPatientListState('loading');
            this.patientSearchTimer = setTimeout(() => this.reloadPatientsAndRender(), this.searchQuery ? 300 : 0);
        });
        on('filterStage', 'change', (event) => {
            this.stageFilter = event.target.value || null;
            this.reloadPatientsAndRender();
        });
        on('filterHead', 'change', (event) => {
            this.headFilter = event.target.value || null;
            this.reloadPatientsAndRender();
        });
        on('filterDeadline', 'change', (event) => {
            this.deadlineFilter = event.target.value || null;
            this.reloadPatientsAndRender();
        });
        on('filterAttention', 'change', (event) => {
            this.attentionFilter = event.target.value || null;
            this.reloadPatientsAndRender();
        });
        on('filterAttentionReason', 'change', (event) => {
            this.attentionReasonFilter = event.target.value || null;
            if (this.attentionReasonFilter && !this.attentionFilter) this.attentionFilter = 'active';
            this.reloadPatientsAndRender();
        });
        on('filterIncludeTerminal', 'change', event => {
            this.includeTerminal = event.target.checked;
            this.reloadPatientsAndRender();
        });
        on('sortOrderSelect', 'change', (event) => {
            this.sortOrder = event.target.value;
            this.reloadPatientsAndRender();
        });

        // Новый пациент
        on('openAddBtn', 'click', () => this.navigateView('create'));
        on('createBackBtn', 'click', () => this.requestCloseAddModal());
        on('closeAddBtn', 'click', () => this.requestCloseAddModal());
        on('closeAddIconBtn', 'click', () => this.requestCloseAddModal());
        $('addForm').addEventListener('submit', (event) => this.addPatient(event));
        $('addForm').addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target.tagName !== 'TEXTAREA') event.preventDefault();
        });
        on('diagnosisLocalization', 'change', () => this.onLocalizationChange());
        on('diagnosisSearch', 'input', () => this.onDiagnosisSearchInput());
        on('diagnosisSearch', 'focus', () => this.renderDiagnosisComboboxOptions({ open: true }));
        on('diagnosisSearch', 'keydown', (event) => this.onDiagnosisSearchKeydown(event));
        on('diagnosisSearch', 'blur', () => setTimeout(() => this.setDiagnosisComboboxOpen(false), 120));
        on('pgiResult', 'change', () => {
            if (!$('pgiResult').value) {
                $('pgiResultDate').value = '';
                this.clearPgiResultDateError();
            }
        });
        on('pgiResultDate', 'input', () => {
            if ($('pgiResultDate').value) this.clearPgiResultDateError();
        });
        on('pgiResultDate', 'change', () => {
            if ($('pgiResultDate').value) this.clearPgiResultDateError();
        });
        on('stage', 'change', () => this.updateStageFields());

        // Пациент требует внимания
        on('closeAttentionIconBtn', 'click', () => ui.closeModal('attentionModal'));
        on('closeAttentionBtn', 'click', () => ui.closeModal('attentionModal'));
        on('attentionReason', 'change', () => this.updateAttentionEventDateRequirement());
        $('attentionForm').addEventListener('submit', (event) => this.submitAttentionIssue(event));
        on('closeAttentionCloseIconBtn', 'click', () => ui.closeModal('attentionCloseModal'));
        on('cancelAttentionCloseBtn', 'click', () => ui.closeModal('attentionCloseModal'));
        $('attentionCloseForm').addEventListener('submit', (event) => this.submitCloseAttentionIssue(event));

        // Мобильные панели-листы: «Данные» и «Фильтры»
        on('openDataSheetBtn', 'click', () => ui.openModal('dataSheet'));
        on('closeDataSheetBtn', 'click', () => ui.closeModal('dataSheet'));
        on('sheetImportBtn', 'click', () => {
            ui.closeModal('dataSheet');
            this.triggerImport();
        });
        on('sheetExportBtn', 'click', () => {
            ui.closeModal('dataSheet');
            this.openExportModal();
        });
        on('openFiltersSheetBtn', 'click', () => this.openFiltersSheet());
        on('closeFiltersSheetBtn', 'click', () => this.closeFiltersSheet());
        on('applyFiltersSheetBtn', 'click', () => this.closeFiltersSheet());
        on('sheetResetFiltersBtn', 'click', () => this.resetFilters());

        // Качество данных
        on('qualitySearchInput', 'input', (event) => {
            this.quality.filters.query = event.target.value;
            this.scheduleQualitySearch();
        });
        on('qualitySeverityFilter', 'change', (event) => {
            this.quality.filters.severity = event.target.value;
            this.renderDataQuality();
        });
        on('qualityCategoryFilter', 'change', (event) => {
            this.quality.filters.category = event.target.value;
            this.renderDataQuality();
        });
        on('qualityCodeFilter', 'change', (event) => {
            this.quality.filters.code = event.target.value;
            this.renderDataQuality();
        });
        on('qualityDoctorFilter', 'change', (event) => {
            this.quality.filters.doctor = event.target.value;
            this.renderDataQuality();
        });
        on('qualityDepartmentFilter', 'change', (event) => {
            this.quality.filters.department = event.target.value;
            this.renderDataQuality();
        });
        on('qualitySortSelect', 'change', (event) => {
            this.quality.filters.sort = event.target.value;
            this.renderDataQuality();
        });
        on('openQualityFiltersSheetBtn', 'click', () => this.openQualityFiltersSheet());
        on('closeQualityFiltersSheetBtn', 'click', () => this.closeQualityFiltersSheet());
        on('applyQualityFiltersSheetBtn', 'click', () => this.closeQualityFiltersSheet());
        on('qualityResetFiltersBtn', 'click', () => this.resetQualityFilters());

        // Уведомления
        document.querySelectorAll('[data-notifications-tab]').forEach(button => {
            button.addEventListener('click', () => {
                this.notifications.activeTab = button.dataset.notificationsTab;
                this.renderNotificationsPage();
            });
        });
        on('notificationsSearchInput', 'input', (event) => {
            this.notifications.offset=0; this.notifications.filters.query = event.target.value;
            this.scheduleRead('notifications', this.renderNotifications, !event.target.value);
        });
        on('notificationsStatusFilter', 'change', (event) => {
            this.notifications.offset=0; this.notifications.filters.status = event.target.value;
            this.renderNotifications();
        });
        on('notificationsTemplateFilter', 'change', (event) => {
            this.notifications.offset=0; this.notifications.filters.template = event.target.value;
            this.renderNotifications();
        });
        on('notificationsDateFromFilter', 'change', (event) => {
            this.notifications.offset=0; this.notifications.filters.dateFrom = event.target.value;
            this.renderNotifications();
        });
        on('notificationsDateToFilter', 'change', (event) => {
            this.notifications.offset=0; this.notifications.filters.dateTo = event.target.value;
            this.renderNotifications();
        });
        on('notificationsDoctorFilter', 'change', (event) => {
            this.notifications.offset=0; this.notifications.filters.doctor = event.target.value;
            this.renderNotifications();
        });
        on('notificationsDepartmentFilter', 'change', (event) => {
            this.notifications.offset=0; this.notifications.filters.department = event.target.value;
            this.renderNotifications();
        });
        on('notificationsSortSelect', 'change', (event) => {
            this.notifications.offset=0; this.notifications.filters.sort = event.target.value;
            this.renderNotifications();
        });
        on('openNotificationsFiltersSheetBtn', 'click', () => this.openNotificationsFiltersSheet());
        on('closeNotificationsFiltersSheetBtn', 'click', () => this.closeNotificationsFiltersSheet());
        on('applyNotificationsFiltersSheetBtn', 'click', () => this.closeNotificationsFiltersSheet());
        on('notificationsResetFiltersBtn', 'click', () => this.resetNotificationsFilters());
        on('notificationsGenerateBtn', 'click', () => this.generateNotificationsDue());
        on('notificationsProcessBtn', 'click', () => this.processNotificationsDue());

        // Аналитика
        on('analyticsRefreshBtn', 'click', () => this.renderAnalytics());
        on('analyticsReportType', 'change', () => this.updateAnalyticsExportControls());
        on('analyticsExportBtn', 'click', () => this.exportAnalyticsCsv());
        on('analyticsDateFrom', 'change', (event) => {
            this.analytics.filters.dateFrom = event.target.value;
            this.updateAnalyticsPeriodPresetState();
            this.renderAnalytics();
        });
        on('analyticsDateTo', 'change', (event) => {
            this.analytics.filters.dateTo = event.target.value;
            this.updateAnalyticsPeriodPresetState();
            this.renderAnalytics();
        });
        document.querySelectorAll('[data-analytics-period]').forEach(button => {
            button.addEventListener('click', () => this.setAnalyticsPeriodPreset(button.dataset.analyticsPeriod));
        });
        on('analyticsStageFilter', 'change', (event) => {
            this.analytics.filters.stage = event.target.value;
            this.renderAnalytics();
        });
        on('analyticsNosologyFilter', 'change', (event) => {
            this.analytics.filters.nosology = event.target.value;
            this.renderAnalytics();
        });
        on('analyticsDoctorFilter', 'change', (event) => {
            this.analytics.filters.doctor = event.target.value;
            this.renderAnalytics();
        });
        on('analyticsDepartmentFilter', 'change', (event) => {
            this.analytics.filters.department = event.target.value;
            this.renderAnalytics();
        });
        on('analyticsAttentionReasonFilter', 'change', (event) => {
            this.analytics.filters.attentionReason = event.target.value;
            this.renderAnalytics();
        });
        on('analyticsResetFiltersBtn', 'click', () => this.resetAnalyticsFilters());

        // Экспорт
        on('openExportBtn', 'click', () => this.openExportModal());
        on('dataExportBtn', 'click', () => this.openExportModal());
        on('closeExportBtn', 'click', () => ui.closeModal('exportModal'));
        on('closeExportIconBtn', 'click', () => ui.closeModal('exportModal'));
        on('confirmExportBtn', 'click', () => this.confirmExport());
        on('exportSearchInput', 'input', (event) => (this.exportAllSelection=null,this.renderExportPatientList(event.target.value)));
        on('exportSelectAllBtn', 'click', () => this.exportSelectAll());
        on('exportSelectNoneBtn', 'click', () => this.exportSelectNone());

        // Импорт
        on('triggerImportBtn', 'click', () => this.triggerImport());
        on('dataImportBtn', 'click', () => this.triggerImport());
        on('importFileInput', 'change', (event) => this.handleImportFile(event.target));
        on('closeImportReviewBtn', 'click', () => this.closeImportReviewModal());
        on('closeImportIconBtn', 'click', () => this.closeImportReviewModal());
        on('confirmImportCommitBtn', 'click', () => this.confirmImportCommit());
        on('importModeSelect', 'change', () => {
            // Подтверждение даётся для конкретного режима: смена режима его сбрасывает.
            $('importUnsignedConfirm').checked = false;
            $('importPreserveIdsConfirm').checked = false;
            $('importHistoricalDecisionsConfirm').checked = false;
            $('importRepeatConfirm').checked = false;
            this.updateImportModeHint();
        });
        on('importUnsignedConfirm', 'change', () => this.renderImportConsiliumImpact($('importModeSelect').value));
        on('importPreserveIdsConfirm', 'change', () => this.renderImportConsiliumImpact($('importModeSelect').value));
        on('importHistoricalDecisionsConfirm', 'change', () => this.renderImportConsiliumImpact($('importModeSelect').value));
        on('importRepeatConfirm', 'change', () => this.renderImportConsiliumImpact($('importModeSelect').value));
        on('importDuplicateReason', 'input', () => this.renderImportConsiliumImpact($('importModeSelect').value));

        // Журнал аудита
        on('auditRefreshBtn', 'click', () => this.renderAudit());
        on('duplicatesRefreshBtn', 'click', () => this.renderDuplicates());
        on('duplicatesScanBtn', 'click', () => this.runDuplicateScan());
        on('duplicatesStateFilter', 'change', () => this.renderDuplicates({ resetPage: true }));
        on('duplicatesStrengthFilter', 'change', () => this.renderDuplicates({ resetPage: true }));
        on('duplicatesPrevBtn', 'click', () => this.moveDuplicatesPage(-1));
        on('duplicatesNextBtn', 'click', () => this.moveDuplicatesPage(1));

        this.listenGlobal(window, 'beforeunload', (event) => {
            const dirtyForm = !$('addModal').hidden && this.addFormState() !== this.addFormBaseline;
            if (!this.discardingSession && (dirtyForm || (this.sessionFieldDrafts && this.sessionFieldDrafts.size))) {
                event.preventDefault();
                event.returnValue = '';
            }
        });

        // Закрытие модалок: клик по подложке и Escape
        for (const modal of document.querySelectorAll('.modal')) {
            let downOnBackdrop = false;
            modal.addEventListener('mousedown', (event) => {
                downOnBackdrop = event.target === modal;
            });
            modal.addEventListener('click', (event) => {
                if (event.target === modal && downOnBackdrop) this.dismissModal(modal.id);
                downOnBackdrop = false;
            });
        }

        this.listenGlobal(document, 'keydown', (event) => {
            if (event.defaultPrevented || this.sessionExpired) return;
            if (event.key === 'Escape') {
                const top = ui.topModal();
                if (top) {
                    this.dismissModal(top);
                    return;
                }
                if (this.currentView==='create') { this.requestCloseAddModal(); return; }
                if ($('appScreen').classList.contains('is-nav-open')) {
                    $('appScreen').classList.remove('is-nav-open');
                    $('sidebarScrim').hidden = true;
                    $('sidebarToggle').setAttribute('aria-expanded', 'false');
                }
                if (!$('internalNotificationsDrawer').classList.contains('is-hidden')) {
                    this.closeInternalNotificationsDrawer();
                }
                if (!$('aiAssistantDrawer').classList.contains('is-hidden')) {
                    this.closeAIDrawer();
                }
                return;
            }
            ui.trapFocus(event);
        });
    },

    /** Закрытие окна «крестиком»/Escape должно вести себя как «Отмена». */
    dismissModal(id) {
        if (this.sessionExpired) return;
        if (id === 'addModal') { this.requestCloseAddModal(); return; }
        if (id === 'registryReasonModal' && ui.pendingRegistryReasonCancel) {
            ui.pendingRegistryReasonCancel();
            return;
        }
        if (id === 'confirmModal' && ui.pendingConfirmCancel) {
            ui.pendingConfirmCancel();
            return;
        }
        if (id === 'promptModal' && ui.pendingPromptCancel) {
            ui.pendingPromptCancel();
            return;
        }
        if (id === 'choiceModal' && ui.pendingChoiceCancel) {
            ui.pendingChoiceCancel();
            return;
        }
        if (id === 'textPromptModal' && ui.pendingTextPromptCancel) {
            ui.pendingTextPromptCancel();
            return;
        }
        if (id === 'importReviewModal') {
            this.closeImportReviewModal();
            return;
        }
        if (id === 'filtersSheet') {
            // Селекты нужно вернуть в тулбар, иначе они останутся в скрытой панели.
            this.closeFiltersSheet();
            return;
        }
        ui.closeModal(id);
    },
};

// History holds only document-local route keys. Authorization remains with app and the API.
const browserNavigation = {
    entries: new Map(),
    writes: new Set(),
    generation: 0,

    invalidate() {
        if (this.recovery) {
            const {route} = this.recovery;
            this.recovery = null;
            this.discardUnknownForm(route, true);
        }
        this.generation++;
        this.entries.clear();
        this.nonce = null;
        this.committed = null;
        this.intentPatient = null;
        this.correction = null;
        this.closeNavigationDialog();
    },

    closeNavigationDialog() {
        if (this.dialog && ui.pendingConfirmCancel === this.dialog && ui.topModal() === 'confirmModal') {
            this.dialog();
        }
        this.dialog = null;
    },

    entry(state) {
        if (!state || state.v !== 1 || !this.nonce || state.nonce !== this.nonce) return null;
        const saved = this.entries.get(state.route);
        return saved?.state.index === state.index ? saved : null;
    },

    sameRoute(a, b) {
        return a?.screen === b.screen && a?.tab === b.tab && a?.patientId === b.patientId;
    },

    save(route, replace) {
        const previous = replace ? this.entry(history.state) : this.committed;
        // Replacing an unknown position starts a new index segment. Other segments
        // stay navigable, but their relative offsets are not trusted.
        const segment = previous?.segment || {};
        const index = (previous?.state.index ?? 0) + (replace ? 0 : 1);
        if (replace) this.entries.delete(history.state?.route);
        else {
            for (const [key, entry] of this.entries) {
                if (entry.segment === segment && entry.state.index >= index) this.entries.delete(key);
            }
        }
        const state = {v: 1, index, nonce: this.nonce, route: newIdempotencyKey()};
        const query = new URLSearchParams({screen: route.screen});
        if (route.tab) query.set('tab', route.tab);
        const url = location.pathname + '?' + query;
        if (replace) history.replaceState(state, '', url);
        else history.pushState(state, '', url);
        this.committed = {state, route, segment};
        this.entries.set(state.route, this.committed);
    },

    reset(route = {screen: 'patients'}) {
        this.invalidate();
        this.nonce = newIdempotencyKey();
        this.save(route, true);
    },

    snapshot() {
        if (!this.committed || this.entry(history.state) !== this.committed) return null;
        if (this.committed.route.screen === 'analytics' && app.currentView === 'analytics') {
            const focused = document.activeElement?.dataset;
            this.committed.route.analytics = app.analyticsReturnContext(
                focused?.analyticsPatient, focused?.analyticsPosition && Number(focused.analyticsPosition));
        }
        return {nonce: this.nonce, committed: this.committed, entries: new Map(this.entries),
            owner: app.user.id, access: app.accessSignature(app.user)};
    },

    matchesSnapshot(previous, user) {
        if (!previous?.committed || previous.owner !== user.id || previous.access !== app.accessSignature(user)) return false;
        const {state} = previous.committed;
        return state.v === history.state?.v && state.index === history.state?.index &&
            state.route === history.state?.route && state.nonce === history.state?.nonce;
    },

    resume(previous) {
        if (!this.matchesSnapshot(previous, app.user)) return false;
        const {route} = previous.committed;
        if (!this.canNavigate(route)) return false;
        if (route.screen === 'patient' && (app.currentPatientId !== route.patientId || app.currentTab !== route.tab)) return false;
        if (route.screen === 'create' && !app.addFormActive) return false;
        if (route.screen === 'analytics') app.restoreAnalyticsContext(route.analytics);
        if (app.currentView !== route.screen) app.showView(route.screen);
        if (route.screen === 'patient' && route.f1Source === 'analytics') {
            app.f1CardOrigin = route.f1Source;
            app.updateCardSourceAction();
        }
        this.nonce = previous.nonce;
        this.committed = previous.committed;
        this.entries = previous.entries;
        return true;
    },

    replaceScreen(screen) {
        if (!this.nonce || !this.committed || app.sessionExpired) return;
        if (this.entry(history.state) === this.committed) this.save({screen}, true);
        else this.reset({screen});
    },

    forget(patientId) {
        if (patientId === this.intentPatient) {
            this.generation++;
            this.intentPatient = null;
            this.closeNavigationDialog();
        }
        for (const [key, entry] of this.entries) {
            if (entry.route.patientId === patientId) this.entries.delete(key);
        }
    },

    suppressFieldBlur() {
        const control = app.patientDraftControls?.get(document.activeElement);
        if (control) control.navigationBlur = true;
    },

    canNavigate(route) {
        if (route.screen === 'patient') {
            return typeof route.patientId === 'string' && app.TABS.some(tab => tab.key === route.tab);
        }
        if (route.screen === 'create') return app.can('createPatients');
        return app.navigationVisibility()[route.screen] === true;
    },

    restorePosition() {
        const position = this.entry(history.state);
        if (!position || !this.committed || position.segment !== this.committed.segment) return false;
        const delta = this.committed.state.index - position.state.index;
        if (delta) {
            this.correction = this.committed;
            history.go(delta);
        }
        return position === this.committed || Boolean(delta);
    },

    async pop(state) {
        this.suppressFieldBlur();
        this.recovery = null;
        const entry = this.entry(state);
        if (entry && entry === this.committed) {
            this.generation++;
            this.closeNavigationDialog();
            this.correction = null;
            return;
        }
        this.correction = null;
        if (!app.user || app.sessionExpired || app.sessionReconciling || !app.appReady) return;
        if (entry) {
            await this.navigate(entry.route, {entry});
            return;
        }
        await this.recoverUnknown();
    },

    currentRoute() {
        return app.currentView === 'patient'
            ? {screen: 'patient', tab: app.currentTab, patientId: app.currentPatientId}
            : {screen: app.currentView};
    },

    discardUnknownForm(route, locked = false) {
        if (route.screen === 'create') {
            ui.closeModal('addModal', {keepView: true});
            $('addForm').reset();
            app.addPatientKey = null;
            app.addPatientSentBody = null;
            app.addPatientDuplicateConfirmation = null;
            app.addPatientUncertain = false;
        }
        if (route.patientId) {
            for (const [key, draft] of app.sessionFieldDrafts) {
                if (draft.patientId === route.patientId) app.sessionFieldDrafts.delete(key);
            }
        }
        app.clearPatientNavigationView();
        $('view-patient').classList.add('is-hidden');
        $('view-create').classList.add('is-hidden');
        if (locked) app.currentView = 'patients';
        app.currentTab = 'overview';
    },

    async recoverUnknown({keep = false} = {}) {
        this.closeNavigationDialog();
        const route = this.currentRoute();
        const epoch = app.sessionEpoch || 0;
        const generation = ++this.generation;
        const owner = app.user.id;
        const access = app.accessSignature(app.user);
        const originalFocus = document.activeElement;
        const activeControl = app.patientDraftControls?.get(originalFocus);
        const marker = {v: 1, index: 0, nonce: this.nonce, route: newIdempotencyKey()};
        // The popped location may contain arbitrary parameters. Scrub it before requests.
        if (this.entry(history.state)) this.entries.delete(history.state.route);
        history.replaceState(marker, '', location.pathname + '?screen=patients');
        const recovery = {route};
        this.recovery = recovery;
        const samePage = () => this.recovery === recovery && this.generation === generation &&
            epoch === (app.sessionEpoch || 0) && owner === app.user?.id &&
            app.accessSignature(app.user) === access && !app.sessionExpired && !app.sessionReconciling &&
            history.state?.route === marker.route && history.state?.nonce === marker.nonce &&
            history.state?.index === marker.index && history.state?.v === marker.v;
        const current = () => samePage() && this.sameRoute(this.currentRoute(), route);
        const busy = () => this.writes.size || app.clinicalWriteInFlight || app.addPatientPending;
        const draft = () => route.screen === 'create'
            ? app.addFormState()
            : route.screen === 'patient'
                ? app.dirtyClinicalControls(true).map(node => [node, JSON.stringify(app.patientDraftControls.get(node).readValue())])
                : [];
        const differs = (a, b) => typeof a === 'string' ? a !== b :
            a.length !== b.length || a.some(([node, value], i) => node !== b[i][0] || value !== b[i][1]);
        const initial = draft();
        const hasDraft = typeof initial === 'string' ? initial !== app.addFormBaseline : initial.length > 0;
        const registry = {screen: 'patients'};
        const returnToRegistry = () => {
            this.discardUnknownForm(route);
            this.render(registry, null, null, true);
            this.save(registry, true);
            app.renderSessionFieldDrafts();
        };
        try {
            let stay = keep || Boolean(busy() || ui.topModal());
            if (!stay && hasDraft) {
                this.suppressFieldBlur();
                const choice = ui.confirm({
                    title: 'Уйти с формы?',
                    text: 'В форме есть несохраненный ввод. Можно остаться или явно удалить черновик и перейти в реестр.',
                    okLabel: 'Удалить черновик и перейти', danger: false,
                });
                this.dialog = ui.pendingConfirmCancel;
                stay = !(await choice);
            }
            if (!current()) return;
            // Changes made after approval are not part of its explicit discard.
            if (!stay && (busy() || differs(initial, draft()))) stay = true;
            if (stay && this.canNavigate(route) && route.patientId) {
                const patient = await apiGetJson('/api/patients/' + encodeURIComponent(route.patientId));
                if (!current()) return;
                if (patient?.id !== route.patientId) throw new Error('Карточка недоступна.');
            } else {
                if (!await app.checkSessionIdentity(epoch) || !current()) return;
            }
            if (!stay && (busy() || differs(initial, draft()))) {
                // A new decision is required for input entered during an access check.
                this.recovery = null;
                return this.recoverUnknown();
            }
            if (stay && this.canNavigate(route)) {
                // The GET is proof of access. Keep the in-place form and original edit versions.
                this.save(route, true);
                if (originalFocus?.isConnected) originalFocus.focus({preventScroll: true});
            } else if (app.navigationVisibility().patients) {
                returnToRegistry();
            }
        } catch (error) {
            if (!samePage() || error.obsolete) return;
            if (route.patientId && [403, 404].includes(error.status)) {
                this.forget(route.patientId);
                returnToRegistry();
            } else {
                // An unavailable access check cannot rebind a patient to history.
                app.expireSession();
            }
        } finally {
            if (this.recovery === recovery) {
                this.recovery = null;
                if (this.generation === generation) this.dialog = null;
            }
            if (activeControl && document.activeElement === originalFocus) activeControl.navigationBlur = false;
        }
    },

    async confirmExit(current, route) {
        if (this.writes.size || app.clinicalWriteInFlight || app.addPatientPending) {
            ui.toast('Дождитесь результата сохранения. Переход отложен.', 'warning');
            return false;
        }
        if (ui.topModal()) return false;
        this.suppressFieldBlur();
        if (app.currentView === 'create') {
            const result = app.confirmCloseAddModal(current);
            this.dialog = ui.topModal() === 'confirmModal' ? ui.pendingConfirmCancel : null;
            return await result && current() ? {create: app.addFormState()} : false;
        }
        const clinical = app.confirmClinicalNavigation(current);
        this.dialog = ui.topModal() === 'confirmModal' ? ui.pendingConfirmCancel : null;
        if (!await clinical || !current()) return false;
        const primary = this.primaryDraftValues();
        if (!primary.length) return {primary};
        const discard = route.patientId && route.patientId !== app.currentPatientId;
        const answer = ui.confirm({
            title: 'Перейти с несохраненным вводом?',
            text: discard
                ? 'При открытии другой карточки этот несохраненный ввод будет удален.'
                : 'Локальный черновик останется доступен. Для записи потребуется отдельное сохранение.',
            okLabel: discard ? 'Удалить черновик и перейти' : 'Оставить черновик и перейти',
            danger: false,
        });
        this.dialog = ui.pendingConfirmCancel;
        return await answer && current() ? {primary} : false;
    },

    primaryDraftValues() {
        return app.dirtyClinicalControls(true).filter(node => !app.patientDraftControls.get(node).navigationOnly)
            .map(node => [node, JSON.stringify(app.patientDraftControls.get(node).readValue())]);
    },

    async navigate(route, {entry, replace = false, allowed, prepare, focus, objectId, denied, registryOnDenial, historyAction, readFailed, cardOrigin} = {}) {
        if (!app.user || app.sessionExpired || app.sessionReconciling || !this.nonce) return false;
        if (this.correction && !replace) return false;
        this.closeNavigationDialog();
        const generation = ++this.generation;
        const epoch = app.sessionEpoch || 0;
        const user = app.user.id;
        const access = app.accessSignature(app.user);
        const positionKey = history.state?.route;
        const sourceView = app.currentView, sourcePatient = app.currentPatientId, sourceTab = app.currentTab;
        if (!entry && route.screen === 'patient') {
            const origin = cardOrigin || (sourceView === 'patient' && sourcePatient === route.patientId
                ? app.f1CardOrigin : sourceView === 'notifications' ? null : sourceView);
            if (['pulse', 'myDay', 'calendar', 'notifications', 'analytics'].includes(origin)) route = {...route, f1Source: origin};
            if (['myDay', 'calendar', 'notifications'].includes(origin) && historyAction?.kind === 'day-event') route = {...route, historyAction};
            if (sourceView === 'patient' && sourcePatient === route.patientId && this.committed?.route.scheduleReturn) {
                route = {...route, scheduleReturn: this.committed.route.scheduleReturn};
            }
            const registryReturn = sourceView === 'patients' ? app.registryContext(route.patientId)
                : sourceView === 'patient' && sourcePatient === route.patientId ? this.committed?.route.registryReturn : null;
            if (registryReturn) route = {...route, registryReturn};
            if (origin === 'analytics' && sourceView === 'patient' && this.committed?.route.analyticsReturn) {
                route = {...route, analyticsReturn: this.committed.route.analyticsReturn};
            }
        }
        const sameIntent = () => generation === this.generation && epoch === (app.sessionEpoch || 0)
            && user === app.user?.id && app.accessSignature(app.user) === access
            && !app.sessionExpired && !app.sessionReconciling && positionKey === history.state?.route;
        const current = () => sameIntent() && sourceView === app.currentView &&
            sourcePatient === app.currentPatientId && sourceTab === app.currentTab;
        let finished = false;
        let reading = false;
        const id = objectId || route.patientId;
        this.intentPatient = id;
        try {
            if (!this.canNavigate(route) || (allowed && !allowed())) {
                if (entry) {
                    finished = await this.navigate({screen: 'patients'}, {replace: true});
                }
                return false;
            }
            const same = !entry && !replace && this.sameRoute(this.committed?.route, route) &&
                app.currentView === route.screen && (route.screen !== 'patient' || app.currentTab === route.tab);
            if (same && cardOrigin !== 'notifications' && !objectId) return true;
            const consent = await this.confirmExit(current, route);
            if (!consent || !current() || (allowed && !allowed())) return false;
            reading = Boolean(id);
            const patient = id ? await apiGetJson('/api/patients/' + encodeURIComponent(id)) : null;
            reading = false;
            if (!id && !await app.checkSessionIdentity(epoch)) return false;
            if (!current() || !this.canNavigate(route) || (allowed && !allowed())) return false;
            if (id && patient?.id !== id) throw new Error('Карточка недоступна.');
            const values = new Map(consent.primary || []);
            if (this.writes.size || app.clinicalWriteInFlight || app.addPatientPending ||
                (consent.create !== undefined && app.addFormState() !== consent.create) ||
                app.dirtyClinicalControls().length || this.primaryDraftValues().some(([node, value]) => values.get(node) !== value)) {
                ui.toast('Появился несохраненный ввод. Переход отложен.', 'warning');
                return false;
            }
            if (prepare && !prepare(patient)) return false;
            // A click arriving while the browser is at an uncommitted entry cannot truncate it.
            if (!entry && !replace && this.entry(history.state) !== this.committed) {
                if (!this.restorePosition()) await this.recoverUnknown({keep: true});
                return false;
            }
            if (entry && route.historyAction?.kind === 'day-event') {
                const unavailable = f1Doctor.replayAction(app, patient, route.historyAction, route.f1Source === 'notifications');
                if (unavailable) {
                    ui.toast(unavailable, 'warning');
                    if (sourceView === 'myDay') f1Doctor.render(app, unavailable);
                    else if (sourceView === 'calendar') {
                        const schedule = app.workspaceListState('events');
                        void app.renderCalendar(schedule.trail[schedule.index]);
                    } else if (sourceView === 'notifications') void app.refreshInternalNotificationLists();
                    return false;
                }
                if (route.f1Source === 'myDay') focus = () => f1Doctor.focusAction(route.historyAction);
            }
            if (sourceView === 'patients' && this.committed?.route.screen === 'patients') {
                const registry = app.registryContext(route.patientId);
                this.committed.route.registry = registry;
                if (!entry && route.screen === 'patient') route = {...route, registryReturn: registry};
                clearTimeout(app.patientSearchTimer);
                app.pageLoading = false;
                app.beginRead('patients');
            }
            if (sourceView === 'calendar' && this.committed?.route.screen === 'calendar') {
                const schedule = app.scheduleContext(historyAction?.eventId);
                this.committed.route.schedule = schedule;
                if (!entry && route.screen === 'patient') route = {...route, scheduleReturn: schedule};
                app.beginRead('workspace-events');
                const state = app.workspaceListState('events');
                state.ready = false;
                state.rows = [];
                $('calendarPanel').replaceChildren();
            }
            if (sourceView === 'analytics' && this.committed?.route.screen === 'analytics') {
                const analytics = app.analyticsReturnContext(route.patientId);
                this.committed.route.analytics = analytics;
                if (!entry && route.screen === 'patient') route = {...route, analyticsReturn: analytics};
            }
            this.render(route, patient, focus, replace);
            if (entry) this.committed = entry;
            else if (same) this.committed.route = route;
            else if (replace) this.reset(route);
            else this.save(route, false);
            finished = true;
            return true;
        } catch (error) {
            if (!sameIntent() || error.obsolete) return false;
            if (id && [403, 404].includes(error.status)) {
                app.forgetDeniedPatient(id);
                if (entry || registryOnDenial) {
                    this.render({screen: 'patients'}, null, null, true);
                    this.reset();
                    finished = true;
                }
                if (denied) denied(error);
            } else if (reading && readFailed && current()) readFailed(error);
            ui.toast(id ? 'Карточка недоступна.' : error.message, 'warning');
            return false;
        } finally {
            if (!finished && entry && current() && !this.restorePosition()) {
                await this.recoverUnknown({keep: true});
            }
            if (generation === this.generation) {
                this.dialog = null;
                this.intentPatient = null;
            }
        }
    },

    render(route, patient, focus, clearPatient) {
        app.capturePatientEdits();
        if (app.currentView === 'create' && route.screen !== 'create') ui.closeModal('addModal', {keepView: true});
        if (route.screen === 'patient') {
            if (patient) app.patientDetails = new Map([[patient.id, patient]]);
            app.currentPatientId = route.patientId;
            app.currentTab = route.tab;
            app.showView('patient', {cardOrigin: route.f1Source ?? null});
            app.renderPatientView();
        } else if (route.screen === 'create') {
            app.openAddModal();
        } else {
            if (clearPatient) app.clearPatientNavigationView();
            if (route.screen === 'patients') {
                // Never render rows from a previous release while fetching the authorized page.
                app.patientRows = [];
                app.patientPage = null;
                app.patientListDirty = true;
                const registry = clearPatient ? null : route.registry;
                app.registrySource = registry?.source || null;
                app.pageTrail = registry?.trail.slice() || [null];
                app.pageIndex = registry?.index || 0;
                if (registry) Object.assign(app, registry.settings);
                app.syncRegistryControls();
                $('patientRegistryCount').textContent = '—';
                app.setPatientListState('loading');
            }
            if (route.screen === 'calendar') {
                const state = app.workspaceListState('events');
                const schedule = route.schedule;
                state.source = schedule?.source || null;
                if (schedule) state.query = schedule.query;
                state.index = schedule?.index || 0;
                state.trail = schedule?.trail.slice() || [null];
                state.focusEventId = schedule?.eventId || null;
            }
            if (route.screen === 'analytics') app.restoreAnalyticsContext(route.analytics);
            if (route.screen === 'notifications' && route.internalInbox) app.notifications.activeTab = 'inbox';
            app.showView(route.screen);
        }
        const target = focus?.() || (route.tab ? $('tab-' + route.tab) : $('view-' + route.screen)?.querySelector('h1'));
        if (target) {
            if (!target.matches('button, input, select, textarea, a[href], [tabindex]')) target.tabIndex = -1;
            target.focus({preventScroll: true});
            if (route.screen === 'patients' && route.registry?.patientId && !clearPatient) {
                app.registryFocus = {anchor: target, patientId: route.registry.patientId, read: app.readVersions.patients};
            }
        }
    },
};

// Только исходная пустая разметка и начальные настройки; медицинских данных здесь нет.
const pristineWorkspace = [...document.body.children].filter(node => node.tagName !== 'SCRIPT').map(node => node.cloneNode(true));
const pristineAppState = structuredClone(Object.fromEntries(Object.entries(app).filter(([, value]) => typeof value !== 'function')));
const authChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('clinic-auth') : null;
if (authChannel) authChannel.onmessage = event => {
    if (event.data === 'changing') app.expireSession();
    if (event.data === 'changed') app.reconcilePeerSession();
};
const revalidateVisibleWorkspace = () => {
    if (app.appReady && !app.sessionExpired && !browserNavigation.cachedPage && !browserNavigation.recovery) {
        void app.reconcilePeerSession({preserveHistory: true});
    }
};
window.addEventListener('focus', revalidateVisibleWorkspace);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') revalidateVisibleWorkspace();
});
window.addEventListener('keydown', event => {
    if (event.key === 'BrowserBack' || event.key === 'BrowserForward') {
        browserNavigation.suppressFieldBlur();
    }
}, {capture: true});
window.addEventListener('popstate', event => { void browserNavigation.pop(event.state); });
window.addEventListener('pagehide', event => {
    if (!event.persisted) return;
    browserNavigation.cachedPage = true;
    browserNavigation.invalidate();
    document.body.classList.add('session-locked');
});
window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    browserNavigation.cachedPage = false;
    if (!app.user || app.sessionExpired) return;
    // Cached DOM stays hidden until the existing identity/reconciliation barrier.
    app.capturePatientEdits();
    app.clearPatientNavigationView();
    if (app.currentView === 'create') ui.closeModal('addModal', {keepView: true});
    app.currentView = 'patients';
    void app.reconcilePeerSession();
});
if (location.search || location.hash || history.state) history.replaceState(null, '', location.pathname);
app.init();
