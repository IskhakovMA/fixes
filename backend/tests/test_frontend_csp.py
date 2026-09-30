"""Статические гарантии фронтенда, на которые опирается CSP.

Проверяются сами файлы, а не браузер: регрессия, которая вернёт inline-обработчик,
inline-стиль или innerHTML, падает здесь, а не «когда-нибудь потом» при ослаблении
политики.
"""
import re
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
HTML = PROJECT_ROOT / "index.html"
JS = PROJECT_ROOT / "static" / "app.js"
CSS = PROJECT_ROOT / "static" / "styles.css"

FRONTEND_SOURCES = (HTML, JS, CSS)

# on<name>= как *атрибут*: перед ним пробел, после — кавычка.
INLINE_HANDLER_RE = re.compile(r"""\son[a-z]+\s*=\s*["']""")
# style="..." как атрибут разметки.
INLINE_STYLE_RE = re.compile(r"""\sstyle\s*=\s*["']""")
NON_HANDLER_ATTRS = {"once"}


def _matches(regex, text):
    hits = []
    for match in regex.finditer(text):
        attr = match.group(0).strip().split("=")[0]
        if attr.lower() in NON_HANDLER_ATTRS:
            continue
        hits.append(text[max(0, match.start() - 60):match.end() + 20])
    return hits


def test_no_inline_event_handlers():
    for path in (HTML, JS):
        hits = _matches(INLINE_HANDLER_RE, path.read_text(encoding="utf-8"))
        assert hits == [], f"inline-обработчики в {path.name}: {hits[:3]}"


def test_no_inline_styles():
    """Ни в разметке, ни в шаблонах JS не должно быть style=."""
    for path in (HTML, JS):
        hits = _matches(INLINE_STYLE_RE, path.read_text(encoding="utf-8"))
        assert hits == [], f"inline-стили в {path.name}: {hits[:3]}"


def test_js_helper_cannot_set_inline_styles():
    """У el() нет ветки для style — свойство просто некуда передать."""
    js = JS.read_text(encoding="utf-8")
    assert "key === 'style'" not in js
    assert not re.search(r"\bstyle:\s*['\"`]", js), "объект со style: передаётся в el()"
    assert ".style.cssText" not in js
    assert not re.search(r"setAttribute\(\s*['\"]style['\"]", js)


def test_no_innerhtml_sinks():
    """Опасных приёмников нет нигде — даже в комментариях, чтобы проверка
    оставалась простой и не имела исключений."""
    for path in FRONTEND_SOURCES:
        text = path.read_text(encoding="utf-8")
        for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"):
            assert sink not in text, f"{sink} встречается в {path.name}"


def test_no_dynamic_code_evaluation():
    js = JS.read_text(encoding="utf-8")
    assert not re.search(r"\beval\s*\(", js)
    assert "new Function" not in js
    assert not re.search(r"set(Timeout|Interval)\s*\(\s*['\"]", js)


def test_escape_helpers_are_gone():
    """Экранирование не нужно там, где значение не интерпретируется как HTML."""
    for path in (HTML, JS):
        text = path.read_text(encoding="utf-8")
        assert "escapeJsAttr" not in text
        assert "escapeHtml" not in text


def test_medical_data_not_placed_in_data_attributes():
    js = JS.read_text(encoding="utf-8")
    for field in ("p.name", "p.diagnosis", "p.complaint", "p.doctor", "p.head", "p.phone"):
        assert f"dataset: {{ {field}" not in js


def test_localstorage_limited_to_theme_and_migration():
    """Медицинские данные в браузер не пишутся: только тема и разовая миграция."""
    js = JS.read_text(encoding="utf-8")
    calls = re.findall(r"localStorage\.(getItem|setItem|removeItem)\(\s*'([^']+)'", js)
    keys = {key for _op, key in calls}
    assert keys <= {"theme", "patients", "user"}, keys
    for op, key in calls:
        if key in ("patients", "user"):
            assert op in ("getItem", "removeItem"), f"{op} по ключу '{key}' запрещён"


@pytest.mark.parametrize("forbidden", [
    "unsafe-eval",
    "script-src 'unsafe-inline'",
    "script-src-attr 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "style-src 'unsafe-inline'",
])
def test_csp_forbids_all_inline(client, forbidden):
    csp = client.get("/").headers["content-security-policy"]
    assert forbidden not in csp


def test_csp_has_no_unsafe_inline_at_all(client):
    """После выноса стилей в файл послаблений в политике не остаётся вовсе."""
    csp = client.get("/").headers["content-security-policy"]
    assert "unsafe-inline" not in csp
    assert "unsafe-eval" not in csp


def test_csp_shape():
    from backend.app.main import CSP
    for directive in (
        "default-src 'self'",
        "script-src 'self'",
        "script-src-attr 'none'",
        "style-src 'self'",
        "style-src-attr 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
    ):
        assert directive in CSP, directive


def test_canonical_page_is_served(client):
    response = client.get("/")
    assert response.status_code == 200
    body = response.text
    assert '<link rel="stylesheet" href="/static/styles.css">' in body
    assert '<script src="/static/app.js?v=executive-demo-v1-foundation"></script>' in body
    # ни одного <style> и ни одного inline-скрипта в документе
    assert "<style" not in body
    assert not re.search(r"<script(?![^>]*\ssrc=)", body)


def test_static_assets_are_served(client):
    for path, marker in (
        ("/static/app.js", "const app = {"),
        ("/static/styles.css", "--accent"),
        ("/static/fonts.css", "@font-face"),
    ):
        response = client.get(path)
        assert response.status_code == 200, path
        assert marker in response.text, path
    assert client.get("/static/logo.png").status_code == 200


def test_legacy_entrypoints_are_gone(client):
    """Старые небезопасные страницы не раздаются и удалены из проекта."""
    for path in ("/clinic.html", "/clinic-v2.html", "/clinic-v2.js", "/static/clinic.html"):
        assert client.get(path).status_code == 404, path
    for name in ("clinic.html", "clinic-v2.html", "clinic-v2.js"):
        assert not (PROJECT_ROOT / name).exists(), f"{name} всё ещё в проекте"


def test_data_quality_frontend_entrypoint_and_api_contract_are_present():
    html = HTML.read_text(encoding="utf-8")
    js = JS.read_text(encoding="utf-8")
    assert 'data-view="quality"' in html
    assert 'id="view-quality"' in html
    assert "Качество данных" in html
    assert "/api/data-quality/summary" in js
    assert "/api/data-quality/issues" in js
    assert "/api/data-quality/patients/" in js
    assert "Заполненность обязательных полей" in js
    assert "possible_duplicate" in js
    assert "Локализация/клиентский путь" in js
    assert "'nosology'" in js
    assert "Режим просмотра — изменение данных недоступно" in js
    assert "action.can_write !== false" in js


def test_ux_audit_cleanup_frontend_copy_is_user_friendly():
    html = HTML.read_text(encoding="utf-8")
    js = JS.read_text(encoding="utf-8")
    visible_frontend = "\n".join((html, js))

    for old_text in (
        "Обработать очередь",
        "Очередь уведомлений пуста",
        "состояние очереди",
        "Персональная очередь",
        "уведомления failed",
        "текущем scope",
        "пациенты в scope",
        "Средняя полнота данных",
        "Полнота регистрационной карточки",
        "Все поля формулы заполнены",
    ):
        assert old_text not in visible_frontend

    for new_text in (
        "Отправить ожидающие сообщения",
        "Ожидающих сообщений нет",
        "статусы отправки",
        "ошибки отправки",
        "текущей области доступа",
        "Заполненность обязательных полей",
        "Проблемы, которые требуют проверки или уточнения",
        "Сформировать напоминания",
    ):
        assert new_text in visible_frontend

    assert "analyticsLocalizationOptions" in js


def test_analytics_v3_and_ai_recovery_frontend_contracts_are_present():
    html = HTML.read_text(encoding="utf-8")
    js = JS.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    for marker in (
        "analytics-panel--primary",
        "analytics-stage-visual",
        "analytics-quality-visual",
        "renderAnalyticsStages",
        "renderAnalyticsQualityVisual",
        "analytics-trend__line--new_patients",
        "analytics-trend__line--completed_patients",
    ):
        assert marker in "\n".join((html, js, css))

    assert "ИИ-помощник временно недоступен" in js
    assert "Основная система продолжает работать." in js
    assert "Проверить снова" in js
    assert "/api/ai/status${force ? '?refresh=true' : ''}" in js
    assert "$('aiAssistantForm').classList.toggle('is-hidden', !status.available)" in js
    assert "ai-result-card" in js
    assert "ref.title" in js
    assert "analytics-bar__progress" in css
    assert "analytics-trend__point" in css
    assert "analytics-trend__legend" in css
    assert "position: sticky; top: 0; z-index: 30" in css


def test_route_treatment_and_semantic_color_frontend_contracts_are_present():
    html = HTML.read_text(encoding="utf-8")
    js = JS.read_text(encoding="utf-8")
    css = CSS.read_text(encoding="utf-8")

    assert 'option value="hormone">Гормонотерапия' in html
    assert "hormone: 'Гормонотерапия'" in js
    assert "TREATMENT_OPTIONS: ['', 'surgery', 'radiation', 'chemo', 'hormone']" in js
    assert "$('treatmentType').replaceChildren(frag(this.treatmentTypeOptions()))" in js
    assert "this.treatmentTypeOptions(ev.treatmentType || '')" in js
    assert "Направить на дообследование" in js
    assert "this.advanceToStage(patientId, 'exam', this.stageNames.exam)" in js
    assert "executive-demo-v1-foundation" in html

    for marker in (
        "analyticsCardToneClass",
        "stat--danger",
        "stat--warning",
        "analytics-bar--danger",
        "analytics-row--danger",
        "qualityProblemChip",
        "severity-dot--danger",
        "quality-finding--danger",
        "stroke: var(--good)",
    ):
        assert marker in "\n".join((js, css))

    assert "row.issue_count ? this.qualityProblemChip" in js
    assert "quality-finding quality-finding--danger" in js
    assert "chip--warning patient-attention-badge" in js


def test_analytics_renderer_does_not_assign_to_append_return_value():
    js = JS.read_text(encoding="utf-8")
    assert ".append(document.createElementNS" not in js
    assert "Cannot set properties of undefined" not in js
    assert "Не удалось загрузить аналитику. Попробуйте обновить данные." in js
    assert "Не удалось загрузить аналитику: ${e.message}" not in js


def test_executive_demo_role_landing_uses_safe_existing_frontend_patterns():
    html = HTML.read_text(encoding="utf-8")
    js = JS.read_text(encoding="utf-8")

    assert 'id="view-home"' in html
    assert 'id="homeNavItem"' in html
    assert 'id="executiveStatsRow"' in html
    assert "this.user && this.user.roleId !== 'developer' ? 'home' : 'patients'" in js
    assert "deputy_chief_oncology: 'Пульс клиники'" in js
    assert "department_head: 'Контур отделения'" in js
    assert "doctor: 'Мой день'" in js
    assert "apiGetJson('/api/analytics/pulse')" in js
    assert "this.openPatient(item.patient_id)" in js


def test_policy_number_frontend_contract_is_present():
    html = HTML.read_text(encoding="utf-8")
    js = JS.read_text(encoding="utf-8")
    assert 'id="policyNumber"' in html
    assert "Номер полиса ОМС" in html
    assert "policyNumber: $('policyNumber').value" in js
    assert "(p.policyNumber || '').toLowerCase().includes(q)" in js
    assert "Полис ОМС: ${p.policyNumber || 'Не указан'}" in js
    assert "missing_policy_number" in js


def test_internal_notification_center_frontend_contract_is_present():
    html = HTML.read_text(encoding="utf-8")
    js = JS.read_text(encoding="utf-8")
    assert 'id="internalNotificationsBell"' in html
    assert 'id="internalNotificationsDrawer"' in html
    assert 'id="view-notifications"' in html
    assert 'data-view="notifications"' in html
    assert "Системные уведомления" in html
    assert 'id="notificationsPageTabs"' in html
    assert 'data-notifications-tab="inbox"' in html
    assert 'data-notifications-tab="outbound"' in html
    assert html.count('data-view="notifications"') == 1
    assert "/api/internal-notifications/summary" in js
    assert "/api/internal-notifications/read-all" in js
    assert "/api/internal-notifications/" in js
    assert "renderNotificationsPage" in js
    assert "data.items || []" in js
    assert "internalNotificationsBadge" in js
    assert "Открыть уведомления" in js


def test_ai_assistant_frontend_contract_is_present():
    html = HTML.read_text(encoding="utf-8")
    js = JS.read_text(encoding="utf-8")
    assert 'id="aiAssistantBtn"' in html
    assert 'id="aiAssistantDrawer"' in html
    assert 'id="aiAssistantInput"' in html
    assert 'aria-controls="aiAssistantDrawer"' in html
    assert "ИИ-помощник" in html
    assert "/api/ai/status" in js
    assert "/api/ai/chat" in js
    assert "Спросить помощника" in js
    assert "patientContextId" in js
    assert "История чата хранится только в текущей вкладке" in js
    assert "localStorage.setItem('ai" not in js
    assert "sessionStorage" not in js


def test_data_quality_mvp_does_not_offer_automatic_duplicate_merge():
    """MVP только показывает кандидатов и не добавляет массовое исправление."""
    combined = "\n".join(path.read_text(encoding="utf-8") for path in (HTML, JS))
    forbidden = (
        "Объединить",
        "mergeDuplicate",
        "autoMerge",
        "/api/data-quality/merge",
        "/api/data-quality/delete",
        "/api/data-quality/fix",
    )
    for marker in forbidden:
        assert marker not in combined, marker


def test_static_route_does_not_expose_arbitrary_files(client):
    """Имя файла не подставляется в путь: доступен только белый список."""
    for path in (
        "/static/../backend/app/config.py",
        "/static/..%2Fbackend%2Fapp%2Fconfig.py",
        "/static/clinic.db",
        "/static/.env",
    ):
        assert client.get(path).status_code in (404, 400), path


def test_both_themes_are_defined():
    css = CSS.read_text(encoding="utf-8")
    assert ':root[data-theme="dark"]' in css
    assert ':root[data-theme="light"]' in css
    # Ключевые токены заданы в обеих темах
    dark = css.split(':root[data-theme="light"]')[0]
    light = css.split(':root[data-theme="light"]')[1]
    for token in ("--bg:", "--surface:", "--text:", "--accent:", "--danger:", "--good:", "--warning:"):
        assert token in dark, f"{token} нет в тёмной теме"
        assert token in light, f"{token} нет в светлой теме"


def test_responsive_breakpoints_present():
    css = CSS.read_text(encoding="utf-8")
    assert "@media (prefers-reduced-motion: reduce)" in css
    assert "max-width: 1024px" in css
    assert "max-width: 860px" in css
    assert "max-width: 560px" in css


def test_no_external_resources():
    """Никаких CDN: всё грузится с собственного origin или встроено."""
    for path in FRONTEND_SOURCES:
        text = path.read_text(encoding="utf-8")
        assert "http://" not in text.replace("http://www.w3.org", "")
        assert "https://" not in text.replace("https://www.w3.org", "")
