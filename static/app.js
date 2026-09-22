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

async function apiFetch(path, options) {
    options = options || {};
    const opts = Object.assign({ credentials: 'include' }, options);
    opts.headers = Object.assign({}, options.headers);
    const method = (opts.method || 'GET').toUpperCase();
    if (opts.body !== undefined) opts.headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') {
        const csrf = getCookie('clinic_csrf');
        if (csrf) opts.headers['X-CSRF-Token'] = csrf;
    }
    const response = await fetch(path, opts);
    if (!response.ok) {
        let detail = `Ошибка запроса (${response.status})`;
        try {
            const data = await response.json();
            if (data && typeof data.detail === 'string') detail = data.detail;
            else if (data && data.detail) detail = JSON.stringify(data.detail);
            else if (data && data.error) detail = data.error;
        } catch (e) { /* тело ответа не JSON */ }
        const err = new Error(detail);
        err.status = response.status;
        throw err;
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return response.json();
    return response;
}

const apiGetJson = (path) => apiFetch(path);
const apiPost = (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body === undefined ? {} : body) });
const apiPatch = (path, body) => apiFetch(path, { method: 'PATCH', body: JSON.stringify(body === undefined ? {} : body) });
const apiPut = (path, body) => apiFetch(path, { method: 'PUT', body: JSON.stringify(body === undefined ? {} : body) });
const apiDelete = (path) => apiFetch(path, { method: 'DELETE' });

/* --------------------------------------------------------------------------
   Модальные окна, подтверждения, уведомления
   -------------------------------------------------------------------------- */

const ui = {
    openModals: [],

    openModal(id) {
        const modal = $(id);
        modal.hidden = false;
        modal.dataset.returnFocus = document.activeElement && document.activeElement.id ? document.activeElement.id : '';
        this.openModals.push(id);
        const focusable = modal.querySelector('input, select, textarea, button');
        if (focusable) focusable.focus();
    },

    closeModal(id) {
        const modal = $(id);
        if (!modal || modal.hidden) return;
        modal.hidden = true;
        this.openModals = this.openModals.filter(m => m !== id);
        const returnId = modal.dataset.returnFocus;
        if (returnId && $(returnId)) $(returnId).focus();
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
    patients: [],
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
        template_disabled: 'Шаблон отключён',
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

    HEAD_OPTIONS: [
        'Шашолин Михаил Аркадьевич',
        'Глашева Зарина Муссаевна',
        'Иванюк Мария Алексеевна',
        'Крылова Виктория Сергеевна',
        'Салпагаров Магомет Хасанович',
        'Мехтиев Вадим Николаевич',
        'Крамская Людмила Викторовна',
        'Хацаюк Владимир Викторович',
    ],

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

    async init() {
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
            // Бэкенд недоступен — остаёмся на экране входа.
        }
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
        this.fillStaticSelects();
        await this.refreshAIStatus();
        await this.refreshInternalNotificationSummary();
        this.showView('patients');
        if (this.can('importData')) this.maybeOfferLegacyMigration();
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

        const navVisibility = {
            data: this.can('importData') || this.can('exportData'),
            staff: this.can('manageUsers'),
            structure: this.can('manageDepartments'),
            audit: this.can('viewAudit'),
        };
        for (const item of document.querySelectorAll('.nav__item')) {
            const view = item.dataset.view;
            if (view in navVisibility) item.classList.toggle('is-hidden', !navVisibility[view]);
        }

        $('readOnlyChip').classList.toggle('is-hidden', !this.isReadOnly());
        $('openAddBtn').classList.toggle('is-hidden', !this.can('createPatients'));
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
        if (!this.can('createPatients') || this.user.roleId === 'doctor') return;
        try {
            const data = await apiGetJson('/api/users/doctors');
            this.doctors = data.doctors || [];
        } catch (e) {
            // Селект просто останется пустым; создание отклонит сервер.
        }
    },

    /* --------------------------------------------------------------- Данные */

    async loadPatients() {
        const params = new URLSearchParams();
        if (this.attentionFilter) params.set('attention', this.attentionFilter);
        if (this.attentionReasonFilter) params.set('attention_reason', this.attentionReasonFilter);
        const query = params.toString();
        this.patients = await apiGetJson(`/api/patients${query ? '?' + query : ''}`);
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
        const index = this.patients.findIndex(x => x.id === updated.id);
        if (index === -1) this.patients.push(updated);
        else this.patients[index] = updated;
        if (this.user) this.refreshInternalNotificationSummary();
    },

    getPatient(id) {
        return this.patients.find(p => p.id === id) || null;
    },

    /* ------------------------------------------------------------ Навигация */

    showView(view) {
        this.currentView = view;
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

        if (view === 'patients') this.renderPatients();
        if (view === 'calendar') this.renderCalendar();
        if (view === 'checklists') this.renderChecklistsView();
        if (view === 'notifications') {
            this.renderNotificationsPage();
        }
        if (view === 'analytics') this.renderAnalytics();
        if (view === 'quality') this.renderDataQuality();
        if (view === 'audit') this.renderAudit();
        if (view === 'settings') this.renderSettings();
        if (view === 'data') this.renderMigrationPanel();
        if (view === 'staff') this.renderStaff();
        if (view === 'structure') this.renderStructure();
        window.scrollTo(0, 0);
    },

    openPatient(id) {
        this.currentPatientId = id;
        this.currentTab = 'overview';
        this.showView('patient');
        this.renderPatientView();
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

    async login(username, password) {
        const result = await apiPost('/api/auth/login', { username, password });
        this.user = result.user;
        if (this.user.mustChangePassword) this.showForcePasswordForm();
        else await this.enterApp();
    },

    async submitForcedPasswordChange(currentPassword, newPassword) {
        await apiPost('/api/auth/change-password',
            { currentPassword, newPassword });
        const me = await apiGetJson('/api/auth/me');
        this.user = me.user;
        $('forcePasswordForm').classList.add('is-hidden');
        $('loginForm').classList.remove('is-hidden');
        await this.enterApp();
    },

    async logout() {
        try {
            await apiPost('/api/auth/logout');
        } catch (e) {
            // Даже при сетевой ошибке сбрасываем клиентское состояние.
        }
        this.patients = [];
        this.ai.messages = [];
        this.ai.references = [];
        this.ai.patientContextId = null;
        this.ai.patientContextLabel = '';
        location.reload();
    },

    /* ------------------------------------------- Перенос старых данных браузера */

    maybeOfferLegacyMigration() {
        if (this.patients.length > 0) return;
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

            await apiPost('/api/migrate/localstorage/commit', { raw, mode: 'add' });
            await this.loadPatients();
            await this.loadActivity();

            const removeLocal = await ui.confirm({
                title: 'Удалить локальную копию?',
                text: 'Перенос завершён. Удалить исходные данные из хранилища этого браузера? Их можно оставить как резервную копию.',
                okLabel: 'Удалить копию',
            });
            if (removeLocal) {
                localStorage.removeItem('patients');
                localStorage.removeItem('user');
            }
            this.renderMigrationPanel();
            ui.toast('Данные перенесены на сервер.', 'good');
        } catch (e) {
            ui.toast('Перенос не выполнен: ' + e.message, 'danger');
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
            return { text: parts.join(''), status: 'состоялось' };
        }
        if (ev.date) parts.push(`план ${ev.date}${ev.time ? ' ' + ev.time : ''}`);
        else parts.push('план не указан');
        if (ev.actualDate) parts.push(`факт ${ev.actualDate}${ev.actualTime ? ' ' + ev.actualTime : ''}`);
        if (typeName) parts.push(typeName);
        if (ev.consiliumDecision) parts.push(`Решение: ${this.CONSILIUM_DECISION_LABELS[ev.consiliumDecision] || ev.consiliumDecision}`);
        const status = ev.actualDate ? (ev.matchedPlan ? 'состоялось по плану' : 'состоялось с отклонением') : (isPending ? 'ожидается' : 'без отметки');
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
        let filtered = this.patients.slice();
        if (!this.stageFilter && !this.searchQuery) {
            filtered = filtered.filter(p => !this.terminalStages.includes(p.stage));
        }
        if (this.stageFilter) filtered = filtered.filter(p => p.stage === this.stageFilter);
        if (this.headFilter) filtered = filtered.filter(p => p.head === this.headFilter);
        if (this.deadlineFilter) {
            filtered = filtered.filter(p => {
                const days = this.getPatientDeadlineDays(p);
                if (this.deadlineFilter === 'no-date') return days === null;
                if (days === null) return false;
                if (this.deadlineFilter === 'overdue') return days < 0;
                if (this.deadlineFilter === '0-3') return days >= 0 && days <= 3;
                if (this.deadlineFilter === '4-7') return days >= 4 && days <= 7;
                if (this.deadlineFilter === '7+') return days > 7;
                return true;
            });
        }
        if (this.searchQuery) {
            const q = this.searchQuery.toLowerCase();
            filtered = filtered.filter(p =>
                (p.name || '').toLowerCase().includes(q) ||
                (p.policyNumber || '').toLowerCase().includes(q) ||
                (p.diagnosis || '').toLowerCase().includes(q) ||
                (p.doctor || '').toLowerCase().includes(q) ||
                (p.head || '').toLowerCase().includes(q)
            );
        }
        const byDate = (value) => new Date(value).getTime() || 0;
        if (this.sortOrder === 'newest') filtered.sort((a, b) => byDate(b.arrival) - byDate(a.arrival));
        else if (this.sortOrder === 'oldest') filtered.sort((a, b) => byDate(a.arrival) - byDate(b.arrival));
        else if (this.sortOrder === 'updated-newest') filtered.sort((a, b) => byDate(b.updatedAt || b.arrival) - byDate(a.updatedAt || a.arrival));
        else if (this.sortOrder === 'updated-oldest') filtered.sort((a, b) => byDate(a.updatedAt || a.arrival) - byDate(b.updatedAt || b.arrival));
        else if (this.sortOrder === 'attention') filtered.sort((a, b) => {
            const ac = (a.attention && a.attention.activeCount) || 0;
            const bc = (b.attention && b.attention.activeCount) || 0;
            return bc - ac || (a.name || '').localeCompare(b.name || '', 'ru');
        });
        else if (this.sortOrder === 'first-visit-oldest') filtered.sort((a, b) =>
            (this.firstVisitTime(a) || Number.MAX_SAFE_INTEGER) - (this.firstVisitTime(b) || Number.MAX_SAFE_INTEGER) ||
            (a.name || '').localeCompare(b.name || '', 'ru')
        );
        else if (this.sortOrder === 'first-visit-newest') filtered.sort((a, b) =>
            (this.firstVisitTime(b) || -1) - (this.firstVisitTime(a) || -1) ||
            (a.name || '').localeCompare(b.name || '', 'ru')
        );
        else if (this.sortOrder === 'name') filtered.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
        return filtered;
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
        const p = this.getPatient(id);
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
        $('filterStage').replaceChildren(frag([
            option('', 'Все этапы', true),
            ...this.stageFilterOrder.map(s => option(s, this.stageNames[s])),
        ]));

        const heads = [...new Set(this.patients.map(p => p.head).filter(Boolean))].sort();
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
            ...this.HEAD_OPTIONS.map(h => option(h, h)),
        ]));

        $('treatmentType').replaceChildren(frag(this.treatmentTypeOptions()));

        this.fillDoctorSelect();
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
        if (this.user && this.user.roleId === 'doctor') {
            select.replaceChildren(option(this.user.id, this.user.fullName, true));
            select.disabled = true;
            hint.textContent = 'Пациент закрепляется за вами. Выбрать другого врача нельзя.';
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
        const total = this.patients.length;
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const fresh = this.patients.filter(p => new Date(p.arrival).getTime() >= weekAgo).length;
        const inTreatment = this.patients.filter(p => p.stage === 'treatment' || p.stage === 'treatment-prep').length;
        const done = this.patients.filter(p => p.stage === 'completed').length;
        const share = (n) => total ? `${(n / total * 100).toFixed(1)}% от всех` : 'нет данных';

        const stat = (label, value, meta, metaClass) => el('div', { class: 'stat' }, [
            el('div', { class: 'stat__label', text: label }),
            el('div', { class: 'stat__value', text: String(value) }),
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
        return [this.stageFilter, this.headFilter, this.deadlineFilter, this.attentionFilter, this.attentionReasonFilter].filter(Boolean).length;
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
        $('filtersSheetBody').append($('toolbarFilters'));
        $('openFiltersSheetBtn').setAttribute('aria-expanded', 'true');
        ui.openModal('filtersSheet');
    },

    closeFiltersSheet() {
        ui.closeModal('filtersSheet');
        $('openFiltersSheetBtn').setAttribute('aria-expanded', 'false');
        const toolbar = document.querySelector('#view-patients .toolbar');
        toolbar.append($('toolbarFilters'));
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
        this.reloadPatientsAndRender();
    },

    async reloadPatientsAndRender() {
        try {
            await this.loadPatients();
            this.fillStaticSelects();
            $('filterStage').value = this.stageFilter || '';
            $('filterHead').value = this.headFilter || '';
            $('filterDeadline').value = this.deadlineFilter || '';
            $('filterAttention').value = this.attentionFilter || '';
            $('filterAttentionReason').value = this.attentionReasonFilter || '';
            $('sortOrderSelect').value = this.sortOrder;
            this.renderPatients();
        } catch (e) {
            ui.toast(`Не удалось обновить список пациентов: ${e.message}`, 'warning');
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
        const count = this.patients.filter(p => !p.treatingDoctorUserId).length;
        if (!count) {
            banner.classList.add('is-hidden');
            return;
        }
        $('unresolvedBannerText').textContent =
            `Пациентов без сопоставленного лечащего врача: ${count}. `
            + 'Они не видны врачам и заведующим отделений.';
        banner.classList.remove('is-hidden');
    },

    renderPatients() {
        this.renderStats();
        this.updateFiltersButton();
        this.updateUnresolvedBanner();
        const filtered = this.getFiltered();
        const body = $('patientsBody');
        const empty = $('patientsEmpty');

        if (filtered.length === 0) {
            body.replaceChildren();
            empty.classList.remove('is-hidden');
            empty.textContent = this.patients.length === 0
                ? (this.can('createPatients')
                    ? 'Пациентов пока нет. Нажмите «Новый пациент», чтобы добавить первого.'
                    : 'В вашей области видимости пока нет пациентов.')
                : 'По выбранным условиям никого не найдено. Измените фильтры или поиск.';
            return;
        }
        empty.classList.add('is-hidden');

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
                role: 'button',
                tabindex: '0',
                'aria-label': `Открыть карточку: ${p.name}`,
                on: {
                    click: () => this.openPatient(p.id),
                    keydown: (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            this.openPatient(p.id);
                        }
                    },
                },
            }, [
                el('td', {}, el('div', { class: 'person' }, [
                    el('span', { class: `avatar avatar--${p.priority}`, text: this.initials(p.name) }),
                    el('div', {}, [
                        el('div', { class: 'person__name', text: p.name }),
                        el('div', { class: 'person__meta', text: `${p.age} лет · ${p.diagnosis || 'диагноз не указан'}` }),
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
                el('td', { class: 'cell-when' }, [
                    el('div', { class: 'cell-when__time', text: this.formatDateTime(p.updatedAt || p.arrival) }),
                    activity ? el('div', { class: 'cell-when__what', text: activity }) : null,
                ]),
                el('td', { class: 'cell-head' }, el('div', { class: 'cell-head__content' }, [
                    el('span', { text: p.head || '—' }),
                    el('span', { class: 'patient-row__chevron', 'aria-hidden': 'true', text: '›' }),
                ])),
            ]);
        })));
    },

    /* ========================================================== РЕНДЕР: КАРТОЧКА */

    renderPatientView() {
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
        if (this.currentTab === 'overview') this.renderPatientAttentionBlock(p.id);
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

    async refreshPatientRecord(patientId) {
        const updated = await apiGetJson(`/api/patients/${encodeURIComponent(patientId)}`);
        this.replacePatientInCache(updated);
        return updated;
    },

    renderPatientSide(p) {
        const percent = this.stageProgressPercent(p.stage);
        const nextNode = this.buildTimelineNodes(p).find(n => n.status === 'future' && n.isNext);

        $('patientSide').replaceChildren(frag([
            el('div', { class: 'pcard' }, [
                el('div', { class: 'pcard__head' }, [
                    el('span', { class: `avatar avatar--lg avatar--${p.priority}`, text: this.initials(p.name) }),
                    el('div', {}, [
                        el('h1', { class: 'pcard__name', text: p.name }),
                        el('div', { class: 'pcard__meta', text: `${p.age} лет · приоритет: ${this.PRIORITY_LABELS[p.priority] || p.priority}` }),
                        p.phone ? el('div', { class: 'pcard__phone', text: p.phone }) : null,
                        el('div', { class: 'pcard__sub', text: `Полис ОМС: ${p.policyNumber || 'Не указан'}` }),
                    ]),
                ]),
                this.statusChip(p),
                this.renderPatientAttentionSummary(p),

                el('div', { class: 'pcard__block' }, [
                    el('div', { class: 'pcard__label', text: 'Этап лечения' }),
                    el('div', { class: 'pcard__value', text: this.getCurrentStageLabel(p) }),
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
                    ...(p.stage === 'consult' && this.can('editPatients') ? this.renderConsiliumDecisionActions(p.id) : []),
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
                        on: { click: () => this.openAIDrawer(p.id) },
                    }),
                    this.can('deletePatients') ? el('button', {
                        type: 'button', class: 'btn btn--quiet', text: 'Удалить пациента',
                        on: { click: () => this.deletePatient(p.id) },
                    }) : null,
                ]),
            ]),
        ]));
    },

    renderConsiliumDecisionActions(patientId) {
        return [
            el('button', {
                type: 'button',
                class: 'btn btn--primary',
                text: 'Определение тактики лечения',
                on: {
                    click: () => this.advanceToStage(patientId, 'treatment-prep', this.stageNames['treatment-prep'], {
                        consiliumDecision: 'treatment_strategy_defined',
                    }),
                },
            }),
            el('button', {
                type: 'button',
                class: 'btn btn--ghost',
                text: 'Изменение тактики лечения',
                on: {
                    click: () => this.advanceToStage(patientId, 'treatment-prep', this.stageNames['treatment-prep'], {
                        consiliumDecision: 'treatment_strategy_changed',
                    }),
                },
            }),
            el('button', {
                type: 'button',
                class: 'btn btn--ghost',
                text: 'Направить на дообследование',
                on: {
                    click: () => this.advanceToStage(patientId, 'exam', this.stageNames.exam),
                },
            }),
            el('button', {
                type: 'button',
                class: 'btn btn--ghost',
                text: 'Диспансерное наблюдение',
                on: {
                    click: () => this.advanceToStage(patientId, 'dispensary-observation', this.stageNames['dispensary-observation'], {
                        consiliumDecision: 'dispensary_observation',
                    }),
                },
            }),
        ];
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
            'aria-controls': 'patientPanels',
            text: tab.label,
            on: {
                click: () => {
                    this.currentTab = tab.key;
                    this.renderTabs();
                    this.renderTabPanel(this.getPatient(this.currentPatientId));
                    this.applyReadOnlyToPatientView();
                    if (tab.key === 'overview') this.renderPatientAttentionBlock(this.currentPatientId);
                    if (tab.key === 'notifications') this.renderPatientNotificationsBlock(this.currentPatientId);
                },
            },
        }))));
    },

    renderTabPanel(p) {
        const panels = $('patientPanels');
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
    },

    /* --- Вкладка «Обзор» ---------------------------------------------------- */

    tabOverview(p) {
        return el('div', { class: 'overview' }, [
            el('div', {}, [
                el('div', { class: 'panel panel--pad' }, [
                    el('h2', { class: 'section-title', text: 'Маршрут лечения' }),
                    this.renderTimeline(p),
                    el('h2', { class: 'section-title', text: 'Лента событий' }),
                    this.renderFeed(p),
                ]),
            ]),
            el('div', {}, [
                this.patientAttentionCard(p),
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

        return el('div', { class: 'timeline' }, nodes.map((node, idx) => {
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

            return el('button', {
                type: 'button',
                class: `tl-step ${modifier} ${selectedKey === nodeKey ? 'is-selected' : ''}`,
                'aria-label': `${stageLabel}: ${stateText}. ${isNext ? 'Перевести пациента на этот этап' : 'Показать даты этапа'}`,
                on: { click: activate },
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
                type: 'button', class: 'btn btn--quiet btn--sm', text: 'Открыть полный чек-лист',
                on: {
                    click: () => {
                        this.currentTab = 'checklist';
                        this.renderTabs();
                        this.renderTabPanel(p);
                    },
                },
            }) : null,
        ]);
    },

    /* --- Вкладка «Данные» --------------------------------------------------- */

    field(label, control, hint) {
        return el('div', { class: 'field' }, [
            el('label', { class: 'field__label' }, label),
            control,
            hint ? el('p', { class: 'field__hint', text: hint }) : null,
        ]);
    },

    patientInput(p, fieldName, type, value, transform) {
        return el('input', {
            class: 'input', type, value: value === null || value === undefined ? '' : value,
            on: {
                change: (event) => this.updatePatientField(
                    p.id, fieldName, transform ? transform(event.target.value) : event.target.value
                ),
            },
        });
    },

    patientSelect(p, fieldName, optionNodes) {
        return el('select', {
            class: 'select',
            on: { change: (event) => this.updatePatientField(p.id, fieldName, event.target.value) },
        }, optionNodes);
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
                    this.HEAD_OPTIONS.map(h => option(h, h, p.head === h)))),
            ]),
        ]);
    },

    tabComplaints(p) {
        return el('div', { class: 'panel panel--pad' }, [
            el('h2', { class: 'section-title', text: 'Комментарии' }),
            el('textarea', {
                class: 'textarea', rows: '10', value: p.complaint || '',
                'aria-label': 'Комментарии',
                on: { change: (event) => this.updatePatientField(p.id, 'complaint', event.target.value) },
            }),
            el('p', { class: 'field__hint', text: 'Изменения сохраняются на сервере автоматически при выходе из поля.' }),
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

    eventInput(p, occIndex, eventIndex, fieldName, type, value, label) {
        return el('input', {
            class: 'input', type, value: value || '', 'aria-label': label,
            on: { change: (event) => this.updateEvent(p.id, occIndex, eventIndex, fieldName, event.target.value) },
        });
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
                        this.eventInput(p, occIndex, 0, 'actualDate', 'date', ev.actualDate, 'Фактическая дата'),
                        this.eventInput(p, occIndex, 0, 'actualTime', 'time', ev.actualTime, 'Фактическое время'),
                    ]),
                ]),
                this.noteField(p, occIndex, occ.note),
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

                return el('div', { class: 'event-card' }, [
                    el('div', { class: 'event-card__head' }, [
                        el('span', { class: 'event-card__title', text: events.length > 1 ? `Событие ${idx + 1}` : 'Дата события' }),
                        el('button', {
                            type: 'button', class: 'btn btn--icon', 'aria-label': `Удалить событие ${idx + 1}`, title: 'Удалить событие',
                            on: { click: () => this.removeEvent(p.id, occIndex, idx) },
                        }, icon('trash')),
                    ]),
                    statusNode,
                    ev.consiliumDecision ? el('div', { class: 'event-card__group' }, [
                        el('div', { class: 'event-card__legend', text: 'ОК' }),
                        el('span', {
                            class: 'chip chip--accent',
                            text: `Решение: ${this.CONSILIUM_DECISION_LABELS[ev.consiliumDecision] || ev.consiliumDecision}`,
                        }),
                    ]) : null,
                    el('div', { class: 'event-card__group' }, [
                        el('div', { class: 'event-card__legend', text: 'План' }),
                        el('div', { class: 'grid-2' }, [
                            this.eventInput(p, occIndex, idx, 'date', 'date', ev.date, 'Плановая дата'),
                            this.eventInput(p, occIndex, idx, 'time', 'time', ev.time, 'Плановое время'),
                        ]),
                    ]),
                    el('div', { class: 'event-card__group' }, [
                        el('div', { class: 'event-card__legend', text: stageKey === 'appointment' ? 'Факт (заполните после приёма)' : 'Факт' }),
                        el('div', { class: 'grid-2' }, [
                            this.eventInput(p, occIndex, idx, 'actualDate', 'date', ev.actualDate, 'Фактическая дата'),
                            this.eventInput(p, occIndex, idx, 'actualTime', 'time', ev.actualTime, 'Фактическое время'),
                        ]),
                    ]),
                    showType ? el('div', { class: 'event-card__group' }, [
                        el('div', { class: 'event-card__legend', text: 'Тип лечения' }),
                        el('select', {
                            class: 'select', 'aria-label': 'Тип лечения',
                            on: { change: (event) => this.updateEvent(p.id, occIndex, idx, 'treatmentType', event.target.value) },
                        }, this.treatmentTypeOptions(ev.treatmentType || '')),
                    ]) : null,
                ]);
            }),

            el('button', {
                type: 'button', class: 'btn btn--ghost',
                on: { click: () => this.addEvent(p.id, occIndex) },
            }, [icon('plus'), addLabels[stageKey]]),

            this.noteField(p, occIndex, occ.note),
        ]);
    },

    noteField(p, occIndex, note) {
        return el('div', { class: 'field' }, [
            el('label', { class: 'field__label', text: 'Примечание к этапу' }),
            el('textarea', {
                class: 'textarea', rows: '3', value: note || '',
                placeholder: 'Свободный комментарий по этому этапу…',
                on: { change: (event) => this.updateOccurrenceNote(p.id, occIndex, event.target.value) },
            }),
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
            return el('div', { class: 'panel' }, el('div', { class: 'empty', text: 'Для текущего этапа чек-лист не предусмотрен.' }));
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
                        el('span', { class: `chip chip--${ev.actualDate ? (ev.matchedPlan === false ? 'warning' : 'good') : 'neutral'}`, text: status }),
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
        if (f.query) params.set('search', f.query);
        if (f.severity) params.set('severity', f.severity);
        if (f.category) params.set('category', f.category);
        if (f.code) params.set('code', f.code);
        if (f.doctor) params.set('treating_doctor', f.doctor);
        if (f.department) params.set('department', f.department);
        if (f.sort) params.set('sort', f.sort);
        params.set('limit', '200');
        return params.toString();
    },

    async loadDataQuality() {
        const query = this.qualityParams();
        const summary = await apiGetJson('/api/data-quality/summary');
        const issues = await apiGetJson(`/api/data-quality/issues?${query}`);
        this.quality.summary = summary;
        this.quality.issues = issues.issues || [];
        this.quality.patients = issues.patients || [];
        this.quality.duplicateGroups = issues.duplicate_groups || [];
        this.quality.rules = issues.rules || {};
    },

    async renderDataQuality() {
        this.updateQualityFiltersButton();
        const body = $('qualityBody');
        const empty = $('qualityEmpty');
        const dupPanel = $('qualityDuplicatesPanel');
        body.replaceChildren();
        empty.classList.remove('is-hidden');
        empty.textContent = 'Загрузка…';
        dupPanel.replaceChildren();

        try {
            await this.loadDataQuality();
            this.renderQualityFiltersOptions();
            this.renderQualityStats();
            this.renderQualityRows();
            this.renderQualityDuplicates();
        } catch (e) {
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
            this.showView('structure');
            return;
        }
        const tab = action && action.tab ? action.tab : 'overview';
        this.openPatientTab(patientId, tab);
    },

    openPatientTab(id, tab) {
        this.currentPatientId = id;
        this.currentTab = tab || 'overview';
        this.showView('patient');
        this.renderPatientView();
    },

    /* ============================================================= ИИ-ПОМОЩНИК */

    async refreshAIStatus(force = false) {
        try {
            this.ai.status = await apiGetJson(`/api/ai/status${force ? '?refresh=true' : ''}`);
        } catch (e) {
            this.ai.status = { enabled: true, available: false, state: 'unavailable', reason: 'provider_unreachable', message: 'ИИ-помощник временно недоступен' };
        }
        this.updateAIButtonState();
        this.renderAIDrawer();
    },

    updateAIButtonState() {
        const button = $('aiAssistantBtn');
        if (!button) return;
        const status = this.ai.status || {};
        button.classList.toggle('is-muted', !status.available);
        button.setAttribute('aria-label', status.available ? 'Открыть ИИ-помощник' : 'Открыть состояние ИИ-помощника');
        button.title = status.available ? 'ИИ-помощник' : (status.message || 'ИИ-помощник не настроен');
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
        if (patientId) {
            const patient = this.getPatient(patientId);
            this.ai.patientContextId = patientId;
            this.ai.patientContextLabel = patient ? patient.name : 'Пациент';
        }
        this.ai.lastFocusId = document.activeElement && document.activeElement.id ? document.activeElement.id : '';
        this.closeInternalNotificationsDrawer(false);
        $('aiAssistantScrim').classList.remove('is-hidden');
        $('aiAssistantDrawer').classList.remove('is-hidden');
        $('aiAssistantDrawer').setAttribute('aria-hidden', 'false');
        $('aiAssistantBtn').setAttribute('aria-expanded', 'true');
        this.renderAIDrawer();
        if (this.ai.status && this.ai.status.available) {
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
            const focusId = this.ai.lastFocusId || 'aiAssistantBtn';
            if ($(focusId)) $(focusId).focus();
        }
    },

    setAIPatientContext(patientId) {
        const patient = this.getPatient(patientId);
        this.ai.patientContextId = patientId;
        this.ai.patientContextLabel = patient ? patient.name : 'Пациент';
        this.renderAIContext();
    },

    clearAIPatientContext() {
        this.ai.patientContextId = null;
        this.ai.patientContextLabel = '';
        this.renderAIContext();
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
        if (!status.available) {
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
        const mine = message.role === 'user';
        const children = [
            el('div', { class: 'ai-message__role', text: mine ? 'Вы' : 'Помощник' }),
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
                        on: { click: () => this.openPatientTab(ref.patientId, 'overview') },
                    }),
                ]);
            })));
        }
        return el('article', { class: `ai-message ${mine ? 'ai-message--user' : 'ai-message--assistant'}` }, children);
    },

    aiUnavailableText(status) {
        if (!status || status.available) return '';
        if (status.reason === 'model_missing') return status.message || 'Локальная модель не загружена.';
        if (status.reason === 'timeout') return 'Локальный AI-сервис не ответил вовремя.';
        if (status.reason === 'provider_error') return 'Локальный AI-сервис вернул некорректный ответ.';
        return 'Локальный AI-сервис недоступен.';
    },

    renderAIDrawer() {
        const status = this.ai.status || {};
        const messages = $('aiAssistantMessages');
        if (!messages) return;
        $('aiAssistantSubtitle').textContent = status.available
            ? 'Ответы по доступным данным системы'
            : 'Основная система продолжает работать';
        this.renderAIContext();
        this.renderAISuggestions();
        const statusBox = $('aiAssistantStatus');
        statusBox.classList.toggle('is-hidden', !this.ai.loading && !this.ai.lastError && status.available);
        statusBox.textContent = this.ai.loading
            ? 'Помощник готовит ответ…'
            : this.ai.lastError || (!status.available ? (status.message || 'ИИ-помощник недоступен') : '');
        $('aiAssistantInput').disabled = this.ai.loading || !status.available;
        $('aiAssistantSendBtn').disabled = this.ai.loading || !status.available;
        $('aiAssistantClearBtn').disabled = this.ai.loading || this.ai.messages.length === 0;
        $('aiAssistantForm').classList.toggle('is-hidden', !status.available);
        if (!status.available) {
            messages.replaceChildren(el('div', { class: 'ai-empty ai-empty--unavailable' }, [
                el('h3', { text: 'ИИ-помощник временно недоступен' }),
                el('p', { text: 'Основная система продолжает работать.' }),
                el('p', { text: this.aiUnavailableText(status) }),
                el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: 'Проверить снова',
                    on: { click: () => this.refreshAIStatus(true) },
                }),
            ]));
        } else {
            messages.replaceChildren(this.ai.messages.length
                ? frag(this.ai.messages.map(message => this.renderAIMessage(message)))
                : el('div', { class: 'ai-empty' }, [
                    el('h3', { text: 'Спросите о доступных пациентах, внимании или просрочках' }),
                    el('p', { text: 'История чата хранится только в текущей вкладке и очищается при выходе или перезагрузке.' }),
                ]));
        }
        messages.scrollTop = messages.scrollHeight;
    },

    async sendAIMessage(event) {
        if (event) event.preventDefault();
        const input = $('aiAssistantInput');
        const text = input.value.trim();
        if (!text || this.ai.loading) return;
        this.ai.loading = true;
        this.ai.lastError = '';
        this.ai.messages.push({ role: 'user', content: text });
        input.value = '';
        this.renderAIDrawer();
        try {
            const history = this.ai.messages
                .slice(0, -1)
                .filter(message => message.role === 'user' || message.role === 'assistant')
                .slice(-12)
                .map(message => ({ role: message.role, content: message.content }));
            const response = await apiPost('/api/ai/chat', {
                message: text,
                history,
                patientContextId: this.ai.patientContextId,
            });
            const refs = response.references || [];
            this.ai.references = refs;
            this.ai.status = { ...(this.ai.status || {}), enabled: true, available: true, state: 'available', reason: 'ok', message: 'ИИ-помощник доступен' };
            this.ai.messages.push({
                role: 'assistant',
                content: response.answer || 'В доступных данных системы такой информации нет.',
                references: refs,
            });
        } catch (e) {
            if (e.status === 503) {
                this.ai.status = { ...(this.ai.status || {}), enabled: true, available: false, state: 'unavailable', reason: 'provider_unreachable', message: 'ИИ-помощник временно недоступен' };
                this.ai.lastError = 'ИИ-помощник временно недоступен. Попробуйте ещё раз позже.';
            } else {
                this.ai.lastError = 'Не удалось получить ответ. Попробуйте ещё раз позже.';
            }
        } finally {
            this.ai.loading = false;
            this.renderAIDrawer();
        }
    },

    clearAIConversation() {
        this.ai.messages = [];
        this.ai.references = [];
        this.ai.lastError = '';
        this.renderAIDrawer();
        $('aiAssistantInput').focus();
    },

    /* =============================================== РЕНДЕР: ЦЕНТР УВЕДОМЛЕНИЙ */

    internalNotificationParams(target) {
        const state = this.internalNotifications;
        const params = new URLSearchParams();
        const tab = target === 'drawer' ? state.drawerFilter : state.fullTab;
        const filters = state.filters;
        const type = target === 'drawer' ? '' : filters.type;
        const unread = target === 'drawer' ? '' : filters.unread;
        const query = target === 'drawer' ? '' : filters.query;

        if (tab === 'unread' || unread === 'unread') params.set('unread_only', 'true');
        if (tab === 'today' || tab === 'overdue') params.set('drawer_filter', tab);
        if (this.INTERNAL_NOTIFICATION_TYPE_LABELS[tab] && tab !== 'today' && tab !== 'overdue') {
            params.set('type', tab);
        }
        if (type) params.set('type', type);
        if (query) params.set('search', query);
        params.set('limit', String(target === 'drawer' ? 5 : filters.limit));
        params.set('offset', String(target === 'drawer' ? 0 : filters.offset));
        return params.toString();
    },

    async refreshInternalNotificationSummary() {
        try {
            this.internalNotifications.summary = await apiGetJson('/api/internal-notifications/summary');
            this.updateInternalNotificationsBadge();
        } catch (e) {
            this.internalNotifications.summary = null;
            this.updateInternalNotificationsBadge();
        }
    },

    updateInternalNotificationsBadge() {
        const badge = $('internalNotificationsBadge');
        const bell = $('internalNotificationsBell');
        if (!badge || !bell) return;
        const unread = Number((this.internalNotifications.summary || {}).unread_count || 0);
        badge.classList.toggle('is-hidden', unread <= 0);
        badge.textContent = unread > 99 ? '99+' : String(unread);
        bell.setAttribute('aria-label', unread
            ? `Открыть уведомления, новых: ${unread}`
            : 'Открыть уведомления');
    },

    async loadInternalNotifications(target) {
        const data = await apiGetJson(`/api/internal-notifications?${this.internalNotificationParams(target)}`);
        if (target === 'drawer') this.internalNotifications.drawerItems = data.items || [];
        else {
            this.internalNotifications.fullItems = data.items || [];
            this.internalNotifications.total = data.total || 0;
        }
        this.internalNotifications.summary = data.summary || this.internalNotifications.summary;
        this.updateInternalNotificationsBadge();
        return data;
    },

    internalNotificationTone(type) {
        if (type === 'overdue') return 'danger';
        if (type === 'today' || type === 'data_quality') return 'warning';
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
        return el('article', { class: `internal-notification${unread ? ' internal-notification--unread' : ''}` }, [
            el('div', { class: 'internal-notification__main' }, [
                el('div', { class: 'internal-notification__head' }, [
                    el('span', {
                        class: `chip chip--${this.internalNotificationTone(item.type)}`,
                        text: this.INTERNAL_NOTIFICATION_TYPE_LABELS[item.type] || item.type,
                    }),
                    unread ? el('span', { class: 'internal-notification__unread', text: 'Новое' }) : null,
                ]),
                el('h3', { class: 'internal-notification__title', text: item.title || 'Уведомление' }),
                compact ? null : el('p', { class: 'internal-notification__text', text: item.description || '' }),
                el('div', { class: 'internal-notification__meta', text: [
                    item.patient_name || 'Пациент',
                    item.event_at ? this.formatDateTime(item.event_at) : 'Дата не указана',
                ].join(' · ') }),
            ]),
            el('div', { class: 'internal-notification__actions' }, [
                item.patient_id ? el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: 'Открыть',
                    on: { click: () => this.openInternalNotificationPatient(item) },
                }) : null,
                unread ? el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: 'Прочитано',
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

    closeInternalNotificationsDrawer() {
        $('internalNotificationsScrim').classList.add('is-hidden');
        $('internalNotificationsDrawer').classList.add('is-hidden');
        $('internalNotificationsDrawer').setAttribute('aria-hidden', 'true');
        $('internalNotificationsBell').setAttribute('aria-expanded', 'false');
        const focusId = this.internalNotifications.lastFocusId || 'internalNotificationsBell';
        if ($(focusId)) $(focusId).focus();
    },

    async renderInternalNotificationsDrawer() {
        const list = $('internalNotificationsDrawerList');
        const summary = this.internalNotifications.summary || {};
        $('internalNotificationsSubtitle').textContent = summary.unread_count
            ? `${summary.unread_count} ${this.pluralize(summary.unread_count, 'новое', 'новых', 'новых')}`
            : 'Новых уведомлений нет';
        this.renderInternalNotificationTabs('internalNotificationsDrawerTabs', this.internalNotifications.drawerFilter, (value) => {
            this.internalNotifications.drawerFilter = value;
            this.renderInternalNotificationsDrawer();
        }, false);
        list.replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
        try {
            await this.loadInternalNotifications('drawer');
            const rows = this.internalNotifications.drawerItems || [];
            $('internalNotificationsReadAllBtn').disabled = !((this.internalNotifications.summary || {}).unread_count);
            if (!rows.length) {
                list.replaceChildren(el('div', { class: 'empty', text: 'По выбранному фильтру уведомлений нет.' }));
                return;
            }
            list.replaceChildren(frag(rows.map(item => this.renderInternalNotificationCard(item, true))));
        } catch (e) {
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
        this.renderInternalNotificationFiltersOptions();
        this.renderInternalNotificationTabs('internalNotificationsFullTabs', this.internalNotifications.fullTab, (value) => {
            this.internalNotifications.fullTab = value;
            this.internalNotifications.filters.offset = 0;
            this.renderInternalNotificationCenter();
        }, true);
        const list = $('internalNotificationsFullList');
        list.replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
        try {
            await this.loadInternalNotifications('full');
            const rows = this.internalNotifications.fullItems || [];
            if (!rows.length) {
                list.replaceChildren(el('div', { class: 'empty', text: 'По выбранным условиям уведомлений нет.' }));
            } else {
                list.replaceChildren(frag(rows.map(item => this.renderInternalNotificationCard(item, false))));
            }
            const { offset, limit } = this.internalNotifications.filters;
            const total = this.internalNotifications.total || 0;
            $('internalNotificationsPageInfo').textContent = total
                ? `${offset + 1}-${Math.min(offset + limit, total)} из ${total}`
                : '0 из 0';
            $('internalNotificationsPrevBtn').disabled = offset <= 0;
            $('internalNotificationsNextBtn').disabled = offset + limit >= total;
        } catch (e) {
            list.replaceChildren(el('div', { class: 'empty', text: `Не удалось загрузить уведомления: ${e.message}` }));
            $('internalNotificationsPageInfo').textContent = '';
            $('internalNotificationsPrevBtn').disabled = true;
            $('internalNotificationsNextBtn').disabled = true;
        }
    },

    async markInternalNotificationRead(id) {
        await apiPost(`/api/internal-notifications/${encodeURIComponent(id)}/read`, {});
        await this.refreshInternalNotificationSummary();
        if (!$('internalNotificationsDrawer').classList.contains('is-hidden')) await this.renderInternalNotificationsDrawer();
        if (this.currentView === 'notifications') await this.renderInternalNotificationCenter();
    },

    async markAllInternalNotificationsRead() {
        await apiPost('/api/internal-notifications/read-all', {});
        await this.refreshInternalNotificationSummary();
        if (!$('internalNotificationsDrawer').classList.contains('is-hidden')) await this.renderInternalNotificationsDrawer();
        if (this.currentView === 'notifications') await this.renderInternalNotificationCenter();
    },

    openInternalNotificationPatient(item) {
        this.closeInternalNotificationsDrawer();
        const tab = item.source_type === 'checklist' ? 'checklist'
            : item.source_type === 'data_quality' ? 'data'
            : 'events';
        this.openPatientTab(item.patient_id, tab);
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
        if (f.query) params.set('search', f.query);
        if (f.status) params.set('status', f.status);
        if (f.template) params.set('template_code', f.template);
        if (f.dateFrom) params.set('date_from', f.dateFrom);
        if (f.dateTo) params.set('date_to', f.dateTo);
        if (f.doctor) params.set('treating_doctor', f.doctor);
        if (f.department) params.set('department', f.department);
        params.set('sort', f.sort || 'scheduled_asc');
        params.set('limit', '100');
        params.set('offset', '0');
        return params.toString();
    },

    async loadNotifications() {
        const summary = await apiGetJson('/api/notifications/summary');
        const templates = await apiGetJson('/api/notifications/templates');
        const list = await apiGetJson(`/api/notifications?${this.notificationParams()}`);
        this.notifications.summary = summary;
        this.notifications.templates = templates.templates || [];
        this.notifications.placeholders = templates.placeholders || [];
        this.notifications.items = list.notifications || [];
        this.notifications.total = list.total || 0;
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
        this.updateNotificationsFiltersButton();
        const body = $('notificationsBody');
        const empty = $('notificationsEmpty');
        body.replaceChildren();
        empty.classList.remove('is-hidden');
        empty.textContent = 'Загрузка…';
        $('notificationsGenerateBtn').classList.toggle('is-hidden', !this.can('runNotificationWorker'));
        $('notificationsProcessBtn').classList.toggle('is-hidden', !this.can('runNotificationWorker'));
        try {
            await this.loadNotifications();
            $('notificationsMockBanner').classList.toggle('is-hidden', this.notifications.summary.provider !== 'mock');
            this.renderNotificationsFiltersOptions();
            this.renderNotificationsStats();
            this.renderNotificationsRows();
            this.renderNotificationTemplatesPanel();
        } catch (e) {
            $('notificationsStatsRow').replaceChildren();
            $('notificationTemplatesPanel').classList.add('is-hidden');
            empty.classList.remove('is-hidden');
            empty.textContent = `Не удалось загрузить уведомления: ${e.message}`;
        }
    },

    renderNotificationsFiltersOptions() {
        const selectedTemplate = this.notifications.filters.template;
        const selectedDoctor = this.notifications.filters.doctor;
        const selectedDept = this.notifications.filters.department;
        const doctors = [...new Set(this.notifications.items.map(n => n.treating_doctor_name).filter(Boolean))].sort();
        const departments = [...new Set(this.notifications.items.flatMap(n => n.department_names || []))].sort();
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
            el('td', { class: 'cell-notification-scheduled', text: this.formatDateTime(item.scheduled_at) }),
            el('td', { class: 'cell-notification-status' }, this.notificationStatusChip(item.status)),
            el('td', { class: 'cell-notification-attempts', text: `${item.attempt_count || 0}/${item.max_attempts || 0}` }),
            el('td', { class: 'cell-notification-reason', text: this.notificationReasonText(item) }),
            el('td', { class: 'cell-actions' }, [
                el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Открыть пациента',
                    on: { click: () => this.openPatientTab(item.patient_id, 'notifications') },
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
        params.set('limit', '50');
        params.set('offset', '0');
        return params.toString();
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

    async loadAnalytics() {
        const params = this.analyticsParams();
        const dashboard = await apiGetJson(`/api/analytics/dashboard?${params}`);
        Object.assign(this.analytics, {
            dashboard,
            summary: dashboard.summary,
            stages: dashboard.stages,
            workload: dashboard.workload,
            dataQuality: dashboard.data_quality,
        });
    },

    async renderAnalytics() {
        $('analyticsStatsRow').replaceChildren();
        $('analyticsStageChart').replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
        $('analyticsQualityList').replaceChildren();
        $('analyticsWorkloadList').replaceChildren();
        $('analyticsProfileChart').replaceChildren();
        $('analyticsRouteStateChart').replaceChildren();
        $('analyticsTrendChart').replaceChildren();
        $('analyticsAttentionList').replaceChildren();
        $('analyticsOperationsList').replaceChildren();
        $('analyticsDetailsPanel').replaceChildren();
        try {
            await this.loadAnalytics();
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
        } catch (e) {
            console.error('analytics render failed', e);
            $('analyticsStageChart').replaceChildren(el('div', { class: 'empty', text: 'Не удалось загрузить аналитику. Попробуйте обновить данные.' }));
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
            on: { click: () => card.detail_type ? this.renderAnalyticsDetails(card.detail_type, card.label) : null },
        }, [
            el('div', { class: 'stat__label', text: card.label }),
            el('div', { class: 'stat__value', text: String(card.value ?? 0) }),
            el('div', { class: 'stat__meta', text: card.kind === 'period' ? 'за период' : 'текущее состояние' }),
        ]));
        const qualitySummary = this.analytics.dataQuality && this.analytics.dataQuality.summary;
        if (qualitySummary) {
            nodes.push(el('button', {
                type: 'button',
                class: `stat stat--button stat--quality ${qualitySummary.total_issues ? 'stat--danger' : 'stat--good'}`,
                on: { click: () => this.renderAnalyticsDetails('quality_warning', 'Проблемы качества данных') },
            }, [
                el('div', { class: 'stat__label', text: 'Заполненность обязательных полей' }),
                el('div', { class: 'stat__value', text: `${qualitySummary.average_completeness ?? 100}%` }),
                el('div', { class: 'stat__meta', text: `${qualitySummary.total_issues || 0} проблем отдельно` }),
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
        const score = Number(summary.average_completeness ?? 100);
        const safeScore = Math.max(0, Math.min(100, score));
        const qualityRing = document.createElementNS(SVG_NS, 'svg');
        qualityRing.setAttribute('class', 'analytics-quality-ring');
        qualityRing.setAttribute('viewBox', '0 0 96 96');
        qualityRing.setAttribute('role', 'img');
        qualityRing.setAttribute('aria-label', `Заполненность обязательных полей ${safeScore}%`);
        const qualityCircle = document.createElementNS(SVG_NS, 'circle');
        qualityCircle.setAttribute('class', 'analytics-quality-ring__seg');
        qualityCircle.setAttribute('cx', '48');
        qualityCircle.setAttribute('cy', '48');
        qualityCircle.setAttribute('r', '39');
        qualityCircle.setAttribute('fill', 'none');
        qualityCircle.setAttribute('stroke-width', '10');
        qualityRing.append(qualityCircle);
        const panel = el('div', { class: 'analytics-quality-card' }, [
            el('div', { class: 'analytics-quality-card__score' }, [
                el('div', { class: 'analytics-ring analytics-ring--quality' }, [
                    qualityRing,
                    el('div', { class: 'analytics-ring-center', 'aria-hidden': 'true' }, [
                        el('div', { class: 'analytics-ring-value analytics-ring-value--quality', text: `${safeScore}%` }),
                        el('div', { class: 'analytics-ring-label analytics-ring-label--quality', text: 'заполнено' }),
                    ]),
                ]),
            ]),
            el('div', { class: 'analytics-quality-card__text' }, [
                el('strong', { text: `${summary.total_issues || 0} проблем качества данных` }),
                el('span', { text: `${summary.patients_with_issues || 0} пациентов требуют проверки данных` }),
            ]),
        ]);
        const list = rows.length
            ? el('div', { class: 'analytics-bars analytics-bars--compact' }, rows.slice(0, 5).map(row => el('button', {
                type: 'button',
                class: 'analytics-row analytics-row--button analytics-row--danger',
                on: { click: () => row.detail_type ? this.renderAnalyticsDetails(row.detail_type, row.label) : null },
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

    async renderAnalyticsDetails(type, title, extra = {}) {
        const params = this.analyticsParams(extra);
        const data = await apiGetJson(`/api/analytics/details?type=${encodeURIComponent(type)}&${params}`);
        const panel = $('analyticsDetailsPanel');
        const rows = data.items || [];
        panel.replaceChildren(frag([
            el('h2', { class: 'panel__title', text: title || 'Детальный список' }),
            el('p', { class: 'panel__text', text: `Показано ${rows.length} из ${data.total || 0}. Данные ограничены текущей областью доступа.` }),
            rows.length ? el('div', { class: 'analytics-list' }, rows.map(item => el('div', { class: 'analytics-detail' }, [
                el('div', { class: 'person__name', text: item.patient_name || item.doctor_name || item.title || 'Запись' }),
                item.stage_label ? el('div', { class: 'person__meta', text: item.stage_label }) : null,
                item.treating_doctor_name ? el('div', { class: 'person__meta', text: item.treating_doctor_name }) : null,
                item.days_overdue ? el('div', { class: 'person__meta', text: `Просрочено: ${item.days_overdue} дн.` }) : null,
                item.error_code ? el('div', { class: 'person__meta', text: this.NOTIFICATION_REASON_LABELS[item.error_code] || item.error_code }) : null,
                item.patient_id ? el('button', {
                    type: 'button',
                    class: 'btn btn--ghost btn--sm',
                    text: 'Открыть пациента',
                    on: { click: () => this.openPatient(item.patient_id) },
                }) : null,
            ]))) : el('div', { class: 'empty', text: 'По выбранным условиям записей нет.' }),
        ]));
    },

    async exportAnalyticsCsv() {
        try {
            const params = this.analyticsParams();
            const response = await apiFetch(`/api/analytics/export?${params}`, {
                method: 'POST',
                body: JSON.stringify({ reportType: 'summary', detailLevel: 'aggregate' }),
            });
            const blob = await response.blob();
            const disposition = response.headers.get('content-disposition') || '';
            const match = disposition.match(/filename=\"([^\"]+)\"/);
            const filename = match ? match[1] : 'analytics_summary.csv';
            const link = el('a', { href: URL.createObjectURL(blob), download: filename });
            document.body.append(link);
            link.click();
            URL.revokeObjectURL(link.href);
            link.remove();
            ui.toast('CSV отчёт сформирован.', 'good');
        } catch (e) {
            ui.toast(`Не удалось сформировать CSV: ${e.message}`, 'warning');
        }
    },

    tabNotifications() {
        return el('div', { class: 'panel panel--pad', id: 'patientNotificationsBlock' }, [
            el('h2', { class: 'section-title', text: 'Уведомления' }),
            el('div', { class: 'empty', text: 'Загрузка…' }),
        ]);
    },

    async renderPatientNotificationsBlock(patientId) {
        const box = $('patientNotificationsBlock');
        if (!box) return;
        box.replaceChildren(frag([
            el('h2', { class: 'section-title', text: 'Уведомления' }),
            el('div', { class: 'empty', text: 'Загрузка…' }),
        ]));
        try {
            const [data, templatesData] = await Promise.all([
                apiGetJson(`/api/notifications/patients/${patientId}`),
                apiGetJson('/api/notifications/templates'),
            ]);
            const pref = data.preference || {};
            this.notifications.templates = templatesData.templates || [];
            this.notifications.placeholders = templatesData.placeholders || [];
            const templates = (templatesData.templates || []).filter(t => t.enabled);
            const canWrite = !!data.can_write && !this.isReadOnly();
            const consentLabel = {
                not_recorded: 'Согласие не зафиксировано',
                granted: 'Согласие получено',
                revoked: 'Согласие отозвано',
            }[pref.consent_status] || 'Согласие не зафиксировано';
            box.replaceChildren(frag([
                el('h2', { class: 'section-title', text: 'Уведомления' }),
                el('p', { class: 'alert alert--info', text: 'Тестовый режим: реальные SMS не отправляются' }),
                el('div', { class: 'summary' }, [
                    el('div', { text: pref.sms_enabled ? 'SMS включены' : 'SMS выключены' }),
                    el('div', { text: consentLabel }),
                    pref.consent_recorded_at ? el('div', { text: `Дата фиксации: ${this.formatDateTime(pref.consent_recorded_at)}` }) : null,
                    pref.consent_recorded_by_name ? el('div', { text: `Зафиксировал: ${pref.consent_recorded_by_name}` }) : null,
                    data.upcoming ? el('div', { text: `Ближайшее уведомление: ${this.formatDateTime(data.upcoming.scheduled_at)}` }) : null,
                ]),
                canWrite ? this.patientNotificationActions(patientId, pref, templates) : el('p', {
                    class: 'muted',
                    text: 'Режим просмотра — изменение данных недоступно',
                }),
                el('h3', { class: 'section-title', text: 'История уведомлений' }),
                data.notifications && data.notifications.length
                    ? el('div', { class: 'notification-list' }, data.notifications.map(item => el('div', { class: 'notification-row' }, [
                        el('div', {}, [
                            el('div', { class: 'person__name', text: item.template_name || item.template_code }),
                            el('div', { class: 'person__meta', text: `${this.formatDateTime(item.scheduled_at)} · ${this.NOTIFICATION_SOURCE_LABELS[item.source_type] || item.source_type}` }),
                            el('div', { class: 'muted', text: this.notificationReasonText(item) }),
                        ]),
                        this.notificationStatusChip(item.status),
                    ])))
                    : el('div', { class: 'empty', text: 'Уведомления ещё не создавались.' }),
            ]));
            this.updatePatientNotificationPreview();
        } catch (e) {
            box.replaceChildren(frag([
                el('h2', { class: 'section-title', text: 'Уведомления' }),
                el('div', { class: 'empty', text: 'Не удалось загрузить уведомления.' }),
            ]));
        }
    },

    patientNotificationActions(patientId, pref, templates) {
        const now = new Date(Date.now() + 60 * 60 * 1000);
        const defaultDateTime = now.toISOString().slice(0, 16);
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
                    el('label', { class: 'field__label', for: 'patientNotificationSchedule', text: 'Дата и время отправки' }),
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
                    disabled: !templates.length,
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
        const date = scheduleInput.value ? new Date(scheduleInput.value) : null;
        const dateText = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('ru-RU') : 'дата';
        const timeText = date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'время';
        preview.value = template.body.replaceAll('{date}', dateText).replaceAll('{time}', timeText);
    },

    async savePatientNotificationPreference(patientId, smsEnabled, consentStatus) {
        try {
            await apiPut(`/api/notifications/patients/${patientId}/preferences`, {
                smsEnabled,
                consentStatus,
            });
            ui.toast(consentStatus === 'granted' ? 'Согласие зафиксировано.' : 'Согласие отозвано.', 'success');
            this.renderPatientNotificationsBlock(patientId);
        } catch (e) {
            ui.toast(`Не удалось изменить согласие: ${e.message}`, 'danger');
        }
    },

    async createPatientNotification(patientId) {
        const templateCode = $('patientNotificationTemplate').value;
        const scheduledValue = $('patientNotificationSchedule').value;
        const scheduled = scheduledValue ? new Date(scheduledValue) : null;
        if (!templateCode || !scheduled || Number.isNaN(scheduled.getTime())) {
            ui.toast('Укажите шаблон, дату и время отправки.', 'warning');
            return;
        }
        try {
            const result = await apiPost('/api/notifications', {
                patientId,
                templateCode,
                scheduledAt: scheduled.toISOString(),
            });
            ui.toast(result.duplicate ? 'Такое напоминание уже ожидает отправки.' : 'Напоминание создано.', 'success');
            await this.renderPatientNotificationsBlock(patientId);
            if (this.currentView === 'notifications') this.renderNotifications();
        } catch (e) {
            ui.toast(`Не удалось создать напоминание: ${e.message}`, 'danger');
        }
    },

    async cancelNotification(notificationId) {
        try {
            await apiPost(`/api/notifications/${notificationId}/cancel`);
            ui.toast('Уведомление отменено.', 'success');
            if (this.currentView === 'notifications') this.renderNotifications();
            if (this.currentView === 'patient' && this.currentTab === 'notifications') this.renderPatientNotificationsBlock(this.currentPatientId);
        } catch (e) {
            ui.toast(`Не удалось отменить уведомление: ${e.message}`, 'danger');
        }
    },

    async retryNotification(notificationId) {
        try {
            await apiPost(`/api/notifications/${notificationId}/retry`);
            ui.toast('Повтор запланирован.', 'success');
            this.renderNotifications();
        } catch (e) {
            ui.toast(`Не удалось запланировать повтор: ${e.message}`, 'danger');
        }
    },

    async generateNotificationsDue() {
        try {
            const result = await apiPost('/api/notifications/generate-due');
            ui.toast(`Сформировано: ${result.created || 0}, пропущено: ${result.skipped || 0}.`, 'success');
            this.renderNotifications();
        } catch (e) {
            ui.toast(`Не удалось сформировать уведомления: ${e.message}`, 'danger');
        }
    },

    async processNotificationsDue() {
        try {
            const result = await apiPost('/api/notifications/process-due?limit=100');
            ui.toast(`Отправлено в тестовом режиме: ${result.processed || 0}.`, 'success');
            this.renderNotifications();
        } catch (e) {
            ui.toast(`Не удалось отправить ожидающие сообщения: ${e.message}`, 'danger');
        }
    },

    async saveNotificationTemplate(code) {
        try {
            const body = $(`template-body-${code}`).value;
            const enabled = $(`template-enabled-${code}`).checked;
            await apiPut(`/api/notifications/templates/${encodeURIComponent(code)}`, { body, enabled });
            ui.toast('Шаблон сохранён.', 'success');
            this.renderNotifications();
        } catch (e) {
            ui.toast(`Не удалось сохранить шаблон: ${e.message}`, 'danger');
        }
    },

    /* ==================================================== РЕНДЕР: ПРОЧИЕ РАЗДЕЛЫ */

    renderCalendar() {
        const rows = [];
        this.patients.forEach(p => {
            (p.history || []).forEach((occ, occIndex) => {
                (occ.events || []).forEach(ev => {
                    if (!ev.date || ev.actualDate) return;
                    rows.push({ patient: p, occIndex, stage: occ.stage, date: ev.date, time: ev.time });
                });
            });
        });
        rows.sort((a, b) => a.date.localeCompare(b.date));

        const panel = $('calendarPanel');
        if (!rows.length) {
            panel.replaceChildren(el('div', { class: 'empty', text: 'Плановых событий нет.' }));
            return;
        }
        panel.replaceChildren(frag(rows.map(row => {
            const days = this.getDaysUntil(row.date);
            return el('div', { class: 'list-row' }, [
                el('div', { class: 'list-row__main' }, [
                    el('div', { class: 'list-row__title', text: row.patient.name }),
                    el('div', { class: 'list-row__sub', text: `${this.stageNames[row.stage]} · ${row.patient.head || 'заведующий не указан'}` }),
                ]),
                this.dateChip(days, row.time),
                el('span', { class: 'list-row__side', text: row.date }),
                el('button', {
                    type: 'button', class: 'btn btn--ghost btn--sm', text: 'Открыть',
                    'aria-label': `Открыть карточку: ${row.patient.name}`,
                    on: { click: () => this.openPatient(row.patient.id) },
                }),
            ]);
        })));
    },

    renderChecklistsView() {
        const rows = this.patients
            .map(p => {
                const occ = this.getCurrentOccurrence(p);
                const nosology = this.nosologyData[p.nosology];
                if (!occ || !nosology) return null;
                const isExam = occ.stage === 'exam';
                const required = (isExam ? nosology.checklistRequired : nosology.checklistRequiredStage2) || [];
                if (!required.length) return null;
                const checklist = occ.checklist || {};
                return { p, done: required.filter(i => checklist[i]).length, total: required.length, stage: occ.stage };
            })
            .filter(Boolean)
            .sort((a, b) => (a.done / a.total) - (b.done / b.total));

        const panel = $('checklistsPanel');
        if (!rows.length) {
            panel.replaceChildren(el('div', { class: 'empty', text: 'Нет пациентов с активным чек-листом.' }));
            return;
        }
        panel.replaceChildren(frag(rows.map(row => el('div', { class: 'list-row' }, [
            el('div', { class: 'list-row__main' }, [
                el('div', { class: 'list-row__title', text: row.p.name }),
                el('div', { class: 'list-row__sub', text: `${this.stageNames[row.stage]} · ${this.nosologyData[row.p.nosology].label}` }),
            ]),
            el('span', { class: `chip chip--${row.done === row.total ? 'good' : 'warning'}`, text: `${row.done} из ${row.total}` }),
            el('button', {
                type: 'button', class: 'btn btn--ghost btn--sm', text: 'Открыть',
                'aria-label': `Открыть чек-лист: ${row.p.name}`,
                on: {
                    click: () => {
                        this.openPatient(row.p.id);
                        this.currentTab = 'checklist';
                        this.renderTabs();
                        this.renderTabPanel(this.getPatient(row.p.id));
                    },
                },
            }),
        ]))));
    },

    async renderAudit() {
        const panel = $('auditPanel');
        panel.replaceChildren(el('div', { class: 'empty', text: 'Загрузка…' }));
        try {
            const data = await apiGetJson('/api/audit?limit=100');
            if (!data.events.length) {
                panel.replaceChildren(el('div', { class: 'empty', text: 'Журнал пуст.' }));
                return;
            }
            const labels = {
                login_success: 'Успешный вход', login_failure: 'Неудачный вход',
                login_rate_limited: 'Вход заблокирован (частые попытки)', logout: 'Выход',
                password_changed: 'Смена пароля', patient_created: 'Создан пациент',
                patient_updated: 'Изменён пациент', patient_deleted: 'Удалён пациент',
                import_preview: 'Проверка импорта', import_committed: 'Импорт выполнен',
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
            panel.replaceChildren(frag(data.events.map(event => el('div', { class: 'list-row' }, [
                el('div', { class: 'list-row__main' }, [
                    el('div', { class: 'list-row__title', text: labels[event.event_type] || event.event_type }),
                    el('div', { class: 'list-row__sub', text: event.detail ? `${event.detail}` : (event.patient_id ? `запись ${event.patient_id.slice(0, 8)}…` : '—') }),
                ]),
                el('span', { class: `chip chip--${event.result === 'ok' ? 'good' : event.result === 'denied' ? 'danger' : 'warning'}`, text: event.result }),
                el('span', { class: 'list-row__side', text: this.formatDateTime(event.created_at) }),
            ]))));
        } catch (e) {
            panel.replaceChildren(el('div', { class: 'empty', text: 'Не удалось загрузить журнал: ' + e.message }));
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

    async updatePatientField(patientId, fieldName, value) {
        try {
            const updated = await apiPatch(`/api/patients/${patientId}`, { field: fieldName, value });
            this.replacePatientInCache(updated);
            this.refreshCurrent();
        } catch (e) {
            ui.toast('Не удалось сохранить: ' + e.message, 'danger');
            this.refreshCurrent();
        }
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
            this.patients = this.patients.filter(x => x.id !== patientId);
            ui.toast('Пациент удалён.', 'good');
            this.showView('patients');
        } catch (e) {
            ui.toast('Не удалось удалить: ' + e.message, 'danger');
        }
    },

    async addEvent(patientId, occIndex) {
        try {
            const updated = await apiPost(`/api/patients/${patientId}/history/${occIndex}/events`);
            this.replacePatientInCache(updated);
            this.refreshCurrent();
        } catch (e) {
            ui.toast('Не удалось добавить событие: ' + e.message, 'danger');
        }
    },

    async removeEvent(patientId, occIndex, eventIndex) {
        try {
            const updated = await apiDelete(`/api/patients/${patientId}/history/${occIndex}/events/${eventIndex}`);
            this.replacePatientInCache(updated);
            this.refreshCurrent();
        } catch (e) {
            ui.toast('Не удалось удалить событие: ' + e.message, 'danger');
        }
    },

    async updateEvent(patientId, occIndex, eventIndex, fieldName, value) {
        try {
            const updated = await apiPatch(`/api/patients/${patientId}/history/${occIndex}/events/${eventIndex}`, { field: fieldName, value });
            this.replacePatientInCache(updated);
            this.refreshCurrent();
        } catch (e) {
            ui.toast('Не удалось сохранить: ' + e.message, 'danger');
        }
    },

    async updateOccurrenceNote(patientId, occIndex, value) {
        try {
            const updated = await apiPatch(`/api/patients/${patientId}/history/${occIndex}/note`, { note: value });
            this.replacePatientInCache(updated);
        } catch (e) {
            ui.toast('Не удалось сохранить заметку: ' + e.message, 'danger');
        }
    },

    async updateChecklistItem(patientId, occIndex, itemName, checked) {
        try {
            const updated = await apiPatch(`/api/patients/${patientId}/history/${occIndex}/checklist`, { item: itemName, checked });
            this.replacePatientInCache(updated);
        } catch (e) {
            ui.toast('Не удалось сохранить чек-лист: ' + e.message, 'danger');
        }
    },

    selectTimelineNode(patientId, nodeKey) {
        if (this.selectedTimelineNodes[patientId] === nodeKey) delete this.selectedTimelineNodes[patientId];
        else this.selectedTimelineNodes[patientId] = nodeKey;
        this.currentTab = 'events';
        this.renderTabs();
        this.renderTabPanel(this.getPatient(patientId));
    },

    async advanceToStage(patientId, stage, stageLabel, options = {}) {
        const confirmed = await ui.confirm({
            title: 'Перевести на следующий этап?',
            text: options.consiliumDecision
                ? `Пациент будет переведён на этап «${stageLabel}». Решение ОК: ${this.CONSILIUM_DECISION_LABELS[options.consiliumDecision]}.`
                : `Пациент будет переведён на этап «${stageLabel}».`,
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

        if (occ) {
            const events = occ.events || [];
            const lastEvent = events.length ? events[events.length - 1] : { date: null, time: null };
            if (!lastEvent.actualDate) {
                const stageLabel = this.stageNames[occ.stage] || occ.stage;
                const today = new Date();
                const todayValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                if (!lastEvent.date) {
                    lastEventUpdate = { actualDate: todayValue, actualTime: '', matchedPlan: null };
                } else if (lastEvent.date === todayValue) {
                    lastEventUpdate = { actualDate: todayValue, actualTime: lastEvent.time || '', matchedPlan: true };
                } else {
                    const answer = await ui.promptDateTime({
                        title: 'Фактическая дата события',
                        text: `Плановая дата этапа «${stageLabel}»: ${lastEvent.date}${lastEvent.time ? ' ' + lastEvent.time : ''}. Укажите фактическую дату события.`,
                        date: todayValue,
                        time: lastEvent.time || '',
                    });
                    if (!answer) return false;
                    const matchedPlan = answer.date === lastEvent.date && (answer.time || '') === (lastEvent.time || '');
                    lastEventUpdate = { actualDate: answer.date, actualTime: answer.time || '', matchedPlan };
                }
            }
            if (options.consiliumDecision) {
                lastEventUpdate = lastEventUpdate || {
                    actualDate: lastEvent.actualDate || null,
                    actualTime: lastEvent.actualTime || '',
                    matchedPlan: lastEvent.matchedPlan === undefined ? null : lastEvent.matchedPlan,
                };
                lastEventUpdate.consiliumDecision = options.consiliumDecision;
            }
        }

        try {
            const updated = await apiPost(`/api/patients/${id}/stage`, { newStage, lastEventUpdate });
            this.replacePatientInCache(updated);
            this.selectedTimelineNodes[id] = `occ:${updated.history.length - 1}`;
            await this.loadActivity();
            this.refreshCurrent();
            ui.toast(`Пациент переведён: ${this.stageNames[newStage]}.`, 'good');
            return true;
        } catch (e) {
            ui.toast('Не удалось изменить этап: ' + e.message, 'danger');
            return false;
        }
    },

    refreshCurrent() {
        if (this.currentView === 'patient') this.renderPatientView();
        else if (this.currentView === 'patients') this.renderPatients();
    },

    /* ================================================== НОВЫЙ ПАЦИЕНТ (МОДАЛКА) */

    openAddModal() {
        $('addForm').reset();
        $('addFormError').classList.add('is-hidden');
        this.clearPgiResultDateError();
        this.resetDiagnosisSelect();
        this.updateClientPathStatus();
        this.updateStageFields();
        ui.openModal('addModal');
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
            event.preventDefault();
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

    async addPatient(event) {
        event.preventDefault();
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
        const payload = {
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

        try {
            const created = await apiPost('/api/patients', payload);
            this.replacePatientInCache(created);
            await this.loadActivity();
            this.fillStaticSelects();
            ui.closeModal('addModal');
            ui.toast('Пациент добавлен.', 'good');
            this.openPatient(created.id);
        } catch (e) {
            this.showFormError('Не удалось создать пациента: ' + e.message);
        }
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
        try {
            const updated = await apiPut(`/api/patients/${patientId}/treating-doctor`, { userId });
            this.replacePatientInCache(updated);
            ui.closeModal('doctorModal');
            ui.toast('Лечащий врач изменён. Область доступа обновлена.', 'good');
            this.refreshCurrent();
        } catch (e) {
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
    },
    STATUS_LABELS: { active: 'Активен', blocked: 'Заблокирован', deactivated: 'Деактивирован' },

    staffFilters: { query: '', role: '', department: '', status: '' },

    async loadStructureData() {
        const data = await apiGetJson('/api/departments');
        this.departments = data.departments || [];
        this.doctorsWithoutDepartment = data.doctorsWithoutDepartment || [];
    },

    async renderStaff() {
        if (!this.can('manageUsers')) return;
        try {
            await this.loadStructureData();
            const params = new URLSearchParams();
            if (this.staffFilters.query) params.set('query', this.staffFilters.query);
            if (this.staffFilters.role) params.set('role', this.staffFilters.role);
            if (this.staffFilters.department) params.set('department', this.staffFilters.department);
            if (this.staffFilters.status) params.set('status', this.staffFilters.status);
            const qs = params.toString();
            this.staffUsers = (await apiGetJson('/api/users' + (qs ? `?${qs}` : ''))).users;
        } catch (e) {
            $('staffEmpty').classList.remove('is-hidden');
            $('staffEmpty').textContent = 'Не удалось загрузить сотрудников: ' + e.message;
            return;
        }
        this.fillStaffFilterSelects();
        const body = $('staffBody');
        const empty = $('staffEmpty');
        if (!this.staffUsers.length) {
            body.replaceChildren();
            empty.classList.remove('is-hidden');
            empty.textContent = 'Сотрудники не найдены. Измените фильтры или создайте учётную запись.';
            return;
        }
        empty.classList.add('is-hidden');
        body.replaceChildren(frag(this.staffUsers.map(u => this.staffRow(u))));
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
        const actionBtn = (label, handler) => el('button', {
            type: 'button', class: 'btn btn--ghost btn--sm', text: label, on: { click: handler },
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
                    errorBox.textContent = 'Задайте временный пароль (не короче 8 символов).';
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
        if (!confirmed) return;
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
        // Временный пароль показывается ровно один раз — в этом подтверждении.
        const tempPassword = this.generateTempPassword();
        const confirmed = await ui.confirm({
            title: 'Сбросить пароль?',
            text: `Новый временный пароль для «${u.fullName}»: ${tempPassword}\n`
                + 'Запишите его сейчас — он показывается только один раз. '
                + 'Все сессии сотрудника будут завершены, при входе потребуется смена пароля.',
            okLabel: 'Сбросить',
        });
        if (!confirmed) return;
        try {
            await apiPost(`/api/users/${u.id}/reset-password`,
                { newPassword: tempPassword, mustChangePassword: true });
            ui.toast('Пароль сброшен. Сессии сотрудника завершены.', 'good');
        } catch (e) {
            ui.toast('Не удалось сбросить пароль: ' + e.message, 'danger');
        }
    },

    async terminateStaffSessions(u) {
        const confirmed = await ui.confirm({
            title: 'Завершить сессии?',
            text: `Все активные сессии «${u.fullName}» будут завершены немедленно.`,
            okLabel: 'Завершить',
        });
        if (!confirmed) return;
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
            await apiPut(`/api/patients/${p.id}/treating-doctor`, { userId });
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
        this.exportHeadFilter = null;
        $('exportSearchInput').value = '';
        this.renderExportHeadsFilter();
        this.renderExportPatientList('');
        ui.openModal('exportModal');
    },

    renderExportHeadsFilter() {
        const heads = [...new Set(this.patients.map(p => p.head).filter(Boolean))].sort();
        $('exportHeadsFilter').replaceChildren(frag([
            el('button', {
                type: 'button', class: `chip-btn ${!this.exportHeadFilter ? 'is-active' : ''}`, text: 'Все',
                on: { click: () => this.filterExportByHead(null) },
            }),
            ...heads.map(h => el('button', {
                type: 'button',
                class: `chip-btn ${this.exportHeadFilter === h ? 'is-active' : ''}`,
                title: h,
                text: `${h.split(' ')[0]} (${this.patients.filter(p => p.head === h).length})`,
                on: { click: () => this.filterExportByHead(h) },
            })),
        ]));
    },

    filterExportByHead(head) {
        this.exportHeadFilter = head;
        this.renderExportHeadsFilter();
        this.renderExportPatientList($('exportSearchInput').value);
    },

    renderExportPatientList(query) {
        if (!this.exportSelectedIds) this.exportSelectedIds = new Set();
        const q = (query || '').toLowerCase();
        const filtered = this.patients.filter(p =>
            ((p.name || '').toLowerCase().includes(q) || (p.head || '').toLowerCase().includes(q)) &&
            (!this.exportHeadFilter || p.head === this.exportHeadFilter)
        );

        const rows = filtered.map(p => el('label', { class: 'pick' }, [
            el('input', {
                type: 'checkbox', checked: this.exportSelectedIds.has(p.id),
                'aria-label': `Выбрать: ${p.name}`,
                on: { change: (event) => this.toggleExportSelection(p.id, event.target.checked) },
            }),
            el('div', {}, [
                el('div', { class: 'pick__name', text: p.name }),
                el('div', { class: 'pick__meta', text: `${this.getCurrentStageLabel(p)}${p.head ? ' · ' + p.head : ''}` }),
            ]),
        ]));

        $('exportPatientList').replaceChildren(rows.length
            ? frag(rows)
            : el('div', { class: 'empty', text: 'Никого не найдено.' }));
        this.exportFilteredIds = filtered.map(p => p.id);
        this.updateExportCount();
    },

    toggleExportSelection(id, checked) {
        if (!this.exportSelectedIds) this.exportSelectedIds = new Set();
        if (checked) this.exportSelectedIds.add(id);
        else this.exportSelectedIds.delete(id);
        this.updateExportCount();
    },

    exportSelectAll() {
        (this.exportFilteredIds || []).forEach(id => this.exportSelectedIds.add(id));
        this.renderExportPatientList($('exportSearchInput').value);
    },

    exportSelectNone() {
        (this.exportFilteredIds || []).forEach(id => this.exportSelectedIds.delete(id));
        this.renderExportPatientList($('exportSearchInput').value);
    },

    updateExportCount() {
        $('exportSelectedCount').textContent = this.exportSelectedIds ? this.exportSelectedIds.size : 0;
        $('exportTotalCount').textContent = this.patients.length;
    },

    async confirmExport() {
        if (!this.exportSelectedIds || this.exportSelectedIds.size === 0) {
            ui.toast('Выберите хотя бы одного пациента.', 'warning');
            return;
        }
        const confirmed = await ui.confirm({
            title: 'Скачать файл с медицинскими данными?',
            text: `В файл попадут данные ${this.exportSelectedIds.size} пациент(ов): ФИО, диагнозы, контакты. Храните его так же осторожно, как медицинскую карту.`,
            okLabel: 'Скачать',
            danger: false,
        });
        if (!confirmed) return;

        try {
            const ids = Array.from(this.exportSelectedIds);
            const response = await fetch('/api/export?ids=' + encodeURIComponent(ids.join(',')), {
                credentials: 'include',
                headers: { 'X-CSRF-Token': getCookie('clinic_csrf') || '' },
            });
            if (!response.ok) throw new Error(`сервер ответил ${response.status}`);
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
                this.showImportErrors(report.errors);
                return;
            }
            this.showImportReviewModal(report);
        } catch (e) {
            ui.toast('Файл не прошёл проверку: ' + e.message, 'danger');
            this.pendingImportRaw = null;
        }
    },

    showImportErrors(errors) {
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
            add: 'Все записи из файла будут добавлены как новые. Существующие данные не изменятся.',
            update: 'Обновятся только записи, совпадающие по идентификатору. Остальные из файла будут пропущены.',
            replace: 'Все текущие данные на сервере будут удалены и заменены содержимым файла. Действие необратимо.',
        };
        $('importModeHint').textContent = hints[mode] || '';
    },

    closeImportReviewModal() {
        ui.closeModal('importReviewModal');
        this.pendingImportRaw = null;
    },

    async confirmImportCommit() {
        if (!this.pendingImportRaw) return;
        const mode = $('importModeSelect').value;
        if (mode === 'replace') {
            const sure = await ui.confirm({
                title: 'Заменить все данные?',
                text: 'Режим «полная замена» удалит все текущие записи на сервере и запишет вместо них содержимое файла. Это необратимо.',
                okLabel: 'Заменить всё',
            });
            if (!sure) return;
        }
        try {
            const result = await apiPost('/api/import/commit', { raw: this.pendingImportRaw, mode });
            this.closeImportReviewModal();
            await this.loadPatients();
            await this.loadActivity();
            this.fillStaticSelects();
            this.showView('patients');
            ui.toast(`Импорт завершён: добавлено ${result.added}, обновлено ${result.updated}, пропущено ${result.skipped}.`, 'good');
        } catch (e) {
            ui.toast('Импорт не выполнен: ' + e.message, 'danger');
        }
    },
    /* =============================================================== ПРИВЯЗКА */

    bindStaticControls() {
        const on = (id, event, handler) => {
            const node = $(id);
            if (node) node.addEventListener(event, handler);
        };

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
                errorBox.textContent = err.status === 429
                    ? 'Слишком много попыток входа. Подождите немного и попробуйте снова.'
                    : 'Неверный логин или пароль.';
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
        on('unresolvedBannerBtn', 'click', () => this.showView('structure'));

        // Смена лечащего врача
        $('doctorForm').addEventListener('submit', (event) => this.submitDoctorChange(event));
        on('doctorCancelBtn', 'click', () => ui.closeModal('doctorModal'));
        on('doctorModalSelect', 'change', () => this.updateDoctorModalDept());

        // Навигация
        for (const item of document.querySelectorAll('.nav__item')) {
            item.addEventListener('click', () => this.showView(item.dataset.view));
        }
        on('backToList', 'click', () => this.showView('patients'));
        on('sidebarToggle', 'click', () => {
            const shell = $('appScreen');
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
        on('aiAssistantScrim', 'click', () => this.closeAIDrawer());
        on('aiAssistantClearBtn', 'click', () => this.clearAIConversation());
        $('aiAssistantForm').addEventListener('submit', (event) => this.sendAIMessage(event));
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
        on('internalNotificationsScrim', 'click', () => this.closeInternalNotificationsDrawer());
        on('internalNotificationsReadAllBtn', 'click', () => this.markAllInternalNotificationsRead());
        on('internalNotificationsFullBtn', 'click', () => {
            this.closeInternalNotificationsDrawer();
            this.showView('notifications');
        });
        on('internalNotificationsRefreshBtn', 'click', () => this.renderInternalNotificationCenter());
        on('internalNotificationsSearchInput', 'input', (event) => {
            this.internalNotifications.filters.query = event.target.value;
            this.internalNotifications.filters.offset = 0;
            this.renderInternalNotificationCenter();
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

        // Фильтры списка
        on('searchInput', 'input', (event) => {
            this.searchQuery = event.target.value;
            this.renderPatients();
        });
        on('filterStage', 'change', (event) => {
            this.stageFilter = event.target.value || null;
            this.renderPatients();
        });
        on('filterHead', 'change', (event) => {
            this.headFilter = event.target.value || null;
            this.renderPatients();
        });
        on('filterDeadline', 'change', (event) => {
            this.deadlineFilter = event.target.value || null;
            this.renderPatients();
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
        on('sortOrderSelect', 'change', (event) => {
            this.sortOrder = event.target.value;
            this.renderPatients();
        });

        // Новый пациент
        on('openAddBtn', 'click', () => this.openAddModal());
        on('closeAddBtn', 'click', () => ui.closeModal('addModal'));
        on('closeAddIconBtn', 'click', () => ui.closeModal('addModal'));
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
            this.renderDataQuality();
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
            this.notifications.filters.query = event.target.value;
            this.renderNotifications();
        });
        on('notificationsStatusFilter', 'change', (event) => {
            this.notifications.filters.status = event.target.value;
            this.renderNotifications();
        });
        on('notificationsTemplateFilter', 'change', (event) => {
            this.notifications.filters.template = event.target.value;
            this.renderNotifications();
        });
        on('notificationsDateFromFilter', 'change', (event) => {
            this.notifications.filters.dateFrom = event.target.value;
            this.renderNotifications();
        });
        on('notificationsDateToFilter', 'change', (event) => {
            this.notifications.filters.dateTo = event.target.value;
            this.renderNotifications();
        });
        on('notificationsDoctorFilter', 'change', (event) => {
            this.notifications.filters.doctor = event.target.value;
            this.renderNotifications();
        });
        on('notificationsDepartmentFilter', 'change', (event) => {
            this.notifications.filters.department = event.target.value;
            this.renderNotifications();
        });
        on('notificationsSortSelect', 'change', (event) => {
            this.notifications.filters.sort = event.target.value;
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
        on('exportSearchInput', 'input', (event) => this.renderExportPatientList(event.target.value));
        on('exportSelectAllBtn', 'click', () => this.exportSelectAll());
        on('exportSelectNoneBtn', 'click', () => this.exportSelectNone());

        // Импорт
        on('triggerImportBtn', 'click', () => this.triggerImport());
        on('dataImportBtn', 'click', () => this.triggerImport());
        on('importFileInput', 'change', (event) => this.handleImportFile(event.target));
        on('closeImportReviewBtn', 'click', () => this.closeImportReviewModal());
        on('closeImportIconBtn', 'click', () => this.closeImportReviewModal());
        on('confirmImportCommitBtn', 'click', () => this.confirmImportCommit());
        on('importModeSelect', 'change', () => this.updateImportModeHint());

        // Журнал аудита
        on('auditRefreshBtn', 'click', () => this.renderAudit());

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

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                const top = ui.topModal();
                if (top) {
                    this.dismissModal(top);
                    return;
                }
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
        if (id === 'confirmModal' && ui.pendingConfirmCancel) {
            ui.pendingConfirmCancel();
            return;
        }
        if (id === 'promptModal' && ui.pendingPromptCancel) {
            ui.pendingPromptCancel();
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

app.init();
