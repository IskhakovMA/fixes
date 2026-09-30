# Clinic Tracker — план развития Executive Demo v1.0

**Исходная версия:** `v0.9.0-stable`  
**Baseline commit:** `20a7505d8ba0302f298f3d6998bb0fa20d0278e9`  
**Назначение документа:** планирование; код, схема БД и конфигурация в рамках подготовки документа не изменялись  
**Целевая версия:** Executive Demo v1.0  
**Основной вопрос:** как за 5 минут показать руководителю клиники, что Clinic Tracker помогает видеть отклонения маршрутов, находить причины и контролировать действие ответственного?

## Принципы версии

1. Не превращать Executive Demo в новую МИС.
2. Не переписывать FastAPI/SQLite/vanilla JS архитектуру.
3. Использовать существующие данные, RBAC scope, Data Quality, Analytics и Attention Workflow.
4. Добавлять только те данные, без которых нельзя назначить владельца, срок и зафиксировать решение.
5. Не выдавать вычисляемые операционные показатели за клинический исход или нормативный SLA.
6. Любая агрегированная цифра должна иметь объяснение и безопасный drill-down.
7. Руководительские роли остаются read-only; появление нового интерфейса не расширяет права.
8. Executive Demo работает на синтетических данных и не меняет текущий `NO-GO` для промышленной работы с реальными медицинскими данными.

---

# 1. Executive Summary

## Целевой результат

Executive Demo v1.0 должен изменить восприятие Clinic Tracker:

> Было: система хранит пациентов, этапы, события, чек-листы, просрочки и отчёты.  
> Станет: система за несколько секунд показывает, где маршрут пациента вышел из-под контроля, почему это произошло, кто отвечает и какое действие требуется.

Для этого не требуется заменять существующее ядро. В репозитории уже есть большая часть фактической базы:

- текущий этап и история маршрута;
- плановые и фактические даты событий;
- просрочки и их возраст;
- лечащий врач и принадлежность к отделениям;
- ручные причины внимания;
- проблемы качества данных;
- состояние чек-листов;
- очередь внутренних и пациентских уведомлений;
- длительность завершённых этапов;
- server-side analytics и безопасный detail drill-down.

Основная работа Executive Demo — собрать эти сигналы в роль-ориентированные рабочие пространства и добавить минимальный accountable workflow для проблем.

## Продуктовое обещание версии

**«Clinic Tracker помогает руководителю держать пациентские маршруты под контролем: видеть отклонения, проваливаться до конкретных пациентов и контролировать ответственность за решение».**

## Что руководитель должен понять за пять минут

1. Сколько пациентов находится в активном маршруте.
2. Какая доля маршрутов находится под контролем по согласованной операционной методике.
3. Сколько пациентов требуют вмешательства сегодня.
4. Где сосредоточены критические и длительные отклонения.
5. Какое отделение является bottleneck.
6. Почему возникло отклонение.
7. Кто отвечает за устранение и к какому сроку.
8. Можно ли перейти от агрегата к карточке пациента без ручного поиска.

## Что не входит в Executive Demo v1.0

- enterprise-интеграции с МИС/ЛИС/RIS/PACS;
- переход с SQLite на PostgreSQL;
- SSO/MFA;
- конструктор клинических маршрутов;
- прогнозирование клинических исходов;
- рейтинг врачей;
- AI-рекомендации руководству;
- пациентский портал;
- полноценный BPM/task-management engine;
- промышленная отправка SMS;
- multi-clinic tenancy;
- большой frontend rewrite или переход на framework.

Эти ограничения должны быть явно названы, чтобы demo не формировало ложных ожиданий.

## Рекомендуемый объём версии

Executive Demo v1.0 состоит из пяти связанных изменений:

1. новый role-based home;
2. «Пульс клиники» для глобальных руководящих ролей;
3. «Контур отделения» для заведующего и «Мой день» для врача;
4. единый «Центр внимания» с владельцем, сроком и историей;
5. усиленный верх карточки пациента и управленческий drill-down.

---

# 2. Что оставить без изменений

## 2.1. Архитектурный baseline

Сохранить:

- FastAPI monolith;
- SQLite schema и существующий миграционный механизм;
- same-origin раздачу frontend и API;
- текущую модель server-side сессий;
- статический HTML/CSS/vanilla JavaScript без сборщика;
- существующие service/repository границы backend;
- текущие import/export и backup/restore механизмы.

Executive Demo не является основанием для смены технологического стека. Архитектурные ограничения SQLite остаются задокументированными, но не мешают синтетическому single-instance demo.

## 2.2. RBAC и области видимости

Сохранить неизменными пять текущих ролей и scope strategies:

| Роль | Scope | Workspace v1.0 |
|---|---|---|
| `deputy_chief_oncology` | `global_readonly` | «Пульс клиники» |
| `caop_head` | `global_readonly` | «Пульс клиники» |
| `department_head` | `by_department` | «Контур отделения» |
| `doctor` | `by_treating_doctor` | «Мой день» |
| `developer` | `global` | рабочее пространство администратора + возможность просмотра demo-контуров |

Ключевое правило: workspace выбирается по роли, но данные всегда ограничиваются существующим `policy.patient_scope_filter(user)`. Frontend не рассчитывает scope и не получает скрытые строки для локальной фильтрации.

Для Executive Demo не нужно добавлять новую роль «руководитель»: две глобальные read-only роли уже подходят. Можно изменить пользовательское название workspace, не меняя backend role ID.

## 2.3. Security-контур

Не ослаблять:

- Argon2id и персональные учётные записи;
- opaque sessions и server-side revocation;
- CSRF, Origin/Referer checks;
- HttpOnly/SameSite cookies и production HTTPS settings;
- CSP и запрет inline script/style/handlers;
- запрет `innerHTML` и unsafe DOM rendering;
- safe 404 для данных вне scope;
- strict Pydantic request models;
- rate limits;
- PHI-minimised audit;
- no-store для API;
- CSV formula-injection protection;
- ограничения AI-помощника.

Новые endpoints обязаны наследовать те же зависимости authentication, CSRF для write-операций, abuse rate limit и аудит. Нельзя строить executive dashboard загрузкой всей базы во frontend.

## 2.4. Сильные продуктовые элементы

Оставить и переиспользовать:

- текущий patient list как самостоятельный реестр;
- существующую карточку пациента и timeline;
- маршруты и stage transitions;
- календарь событий;
- обязательные чек-листы;
- Data Quality service;
- Internal Notification Center;
- Patient Attention Workflow;
- analytics filters и `GET /api/analytics/details`;
- light/dark темы и текущие accessibility-паттерны;
- mock-режим пациентских уведомлений с явным предупреждением.

## 2.5. Терминологические ограничения

Сохранить честные границы:

- аналитика — организационная, не клиническая;
- workload — распределение нагрузки, не качество врача;
- Data Quality — контроль регистрационных/операционных данных, не медицинское заключение;
- `sent` mock-провайдера — обработано, а не доставлено пациенту;
- «контрольный срок» в demo — вычисляемое правило продукта, а не норматив, пока он не утверждён клиникой.

---

# 3. Новая продуктовая концепция

## 3.1. От реестра к контуру управления

Новая концепция строится вокруг четырёх последовательных вопросов:

1. **Что происходит?** — KPI и тренд.
2. **Где проблема?** — риск, отделение, этап или тип отклонения.
3. **С кем именно?** — список пациентов в текущем RBAC scope.
4. **Что должно произойти дальше?** — действие, владелец, срок и история.

### Целевая цепочка drill-down

`Пульс клиники → KPI/сигнал → сегмент проблемы → список пациентов → карточка пациента → действие/эскалация`

На каждом уровне должны сохраняться:

- активный фильтр;
- понятное определение показателя;
- timestamp расчёта;
- scope пользователя;
- возможность вернуться на предыдущий уровень без потери контекста.

## 3.2. «Пульс клиники»

### Первый экран за 10 секунд

Первый viewport desktop-экрана должен содержать не больше шести KPI:

1. **Активные пациенты** — размер текущего операционного контура.
2. **Маршруты под контролем, %** — доля активных пациентов, у которых есть допустимое следующее плановое действие и нет критического отклонения.
3. **Требуют вмешательства сегодня** — уникальные пациенты с критическим/высоким сигналом.
4. **Просрочено 8+ дней** — длительный backlog; 15+ выделяется отдельно внутри drill-down.
5. **Без следующего действия** — активный пациент без будущего незавершённого события.
6. **Открытые эскалации** — persisted attention issues, требующие решения.

Под KPI размещаются три управленческих блока:

- **Карта рисков:** отделения × тип риска;
- **Где возникло узкое место:** этапы с наибольшим backlog/возрастом;
- **Что требует решения:** 5 наиболее значимых сигналов с владельцем и сроком.

Ниже первого viewport:

- динамика входа/завершения маршрутов;
- контрольные сроки по отделениям;
- длительность этапов;
- качество данных;
- workload отделений.

### Методика «Маршруты под контролем»

Для Executive Demo нужна прозрачная, не «магическая» формула:

**Деноминатор:** все активные, не terminal пациенты в текущем scope.  
**Пациент под контролем, если одновременно:**

- у текущего этапа есть незавершённое плановое событие в будущем или сегодня;
- нет события с просрочкой 8+ дней;
- нет открытой manual-проблемы типа `critical_overdue`, `emergency_hospitalization` или другой критической эскалации;
- заполнен лечащий врач;
- нет critical Data Quality finding, который делает маршрут недостоверным.

**Важно:** в UI рядом с процентом есть tooltip/«Как считается». Backend возвращает definition и составляющие. До клинического утверждения показатель называется «Маршруты под контролем», а не «SLA соблюдён».

### Что уже есть и что добавить

| Показатель/сигнал | Источник сейчас | Delta для v1.0 |
|---|---|---|
| Активные/завершённые пациенты | Analytics summary | Только новый приоритет отображения |
| Просроченные события и aging | Analytics overdue + Data Quality | Агрегировать 8+ и добавить trend/comparison |
| Пациенты по этапам | Analytics stages | Использовать как drill-down, не главный график |
| Длительность этапов | Stage durations | Добавить P90 и явный bottleneck summary |
| Workload врачей | Analytics workload | Агрегировать на отделение |
| Manual attention | Patient attention + analytics | Добавить owner/due/status/history |
| Critical quality | Data Quality | Включить в risk map |
| Незавершённые чек-листы | Checklist analytics | Использовать как risk subtype |
| Без следующего действия | Частично выводимо из events | Новый backend metric и detail type |
| Маршруты под контролем | Нет | Новый прозрачный composite metric |
| Контрольные сроки по отделениям | Частично есть overdue by department | Новый department summary |
| Open escalations overdue | Нет due/owner | Требует минимальной data delta |

## 3.3. Карта рисков

Не использовать единый непрозрачный «индекс риска». Показывать матрицу с абсолютным количеством и долей пациентов:

| Отделение | Просрочка 8+ | Нет следующего действия | Критичное качество данных | Незавершённый обязательный чек-лист | Открытая эскалация |
|---|---:|---:|---:|---:|---:|

Severity:

- **Critical:** manual critical/emergency issue; просрочка 15+; просроченная critical escalation.
- **High:** просрочка 8–14; отсутствие следующего действия; critical Data Quality.
- **Medium:** просрочка 1–7; незавершённый обязательный чек-лист; high Data Quality.
- **Info:** некритичная регистрационная неполнота.

Одна строка пациента может иметь несколько сигналов, но KPI «требуют вмешательства» считает уникальных пациентов. UI обязан различать `signals count` и `patients count`.

## 3.4. Role-based рабочие пространства

### Руководитель: «Пульс клиники»

Главные задачи:

- оценить состояние клиники;
- увидеть отклонение от предыдущего периода;
- найти проблемное отделение/этап;
- открыть список пациентов;
- понять владельца и статус решения.

Основные виджеты:

- шесть KPI верхнего уровня;
- risk map;
- bottleneck этапов;
- department comparison;
- decision queue;
- динамика новых/завершённых маршрутов.

Руководитель остаётся read-only. Кнопка действия для него означает «открыть проблему», «перейти к пациенту» или «посмотреть историю», а не менять клинические данные.

### Заведующий: «Контур отделения»

Главные задачи:

- обработать просрочки своего scope;
- увидеть врачей с перегруженным списком;
- перераспределить организационное внимание;
- контролировать отсутствие следующего шага;
- закрывать или эскалировать организационные проблемы.

Первый экран:

- требуют действия сегодня;
- просрочены 8+ дней;
- без следующего события;
- открытые/просроченные задачи;
- workload врачей без оценочного рейтинга;
- список «сначала обработать».

### Врач: «Мой день»

Главные задачи:

- что должно произойти сегодня;
- что уже просрочено;
- у кого отсутствует следующий шаг;
- какие обязательные пункты не завершены;
- какие проблемы назначены врачу.

Очереди:

1. Просрочено.
2. Сегодня.
3. В ближайшие семь дней.
4. Без следующего действия.
5. Требует уточнения данных.

Каждая строка содержит пациента, текущий этап, ожидаемое действие, срок, величину отклонения и one-click переход в релевантный блок карточки.

## 3.5. Управленческая логика вместо графиков ради графиков

Каждый блок должен отвечать хотя бы на один вопрос:

- ухудшается или улучшается ситуация;
- где узкое место;
- насколько проблема велика;
- кто отвечает;
- какие пациенты затронуты;
- какое действие ожидается.

Если визуализация не отвечает ни на один вопрос, она не попадает в первый уровень Executive Demo.

---

# 4. Новые экраны и сценарии

## 4.1. Экран «Пульс клиники»

### Структура

1. **Header:** название, период, scope label, время обновления, кнопка refresh.
2. **KPI strip:** шесть карточек с value, delta, definition и severity.
3. **Decision queue:** пять требующих решения сигналов.
4. **Risk map:** отделения × риски.
5. **Bottleneck:** этапы по backlog и median/P90 age.
6. **Department comparison:** объём, control rate, overdue 8+, no next action.
7. **Trend:** новые и завершённые маршруты.
8. **Data confidence:** критические проблемы качества, чтобы руководитель видел надёжность показателей.

### Drill-down

- click KPI «Просрочено 8+» → risk detail с buckets/отделениями;
- click отделения → scoped patient list;
- click пациента → карточка с highlight проблемного события;
- click attention issue → owner/due/history;
- back → прежний фильтр и scroll position.

### Состояния

- loading skeleton;
- empty «отклонений не найдено»;
- unavailable «часть показателей недоступна» без подмены нулём;
- stale indicator по `computed_at`;
- read-only badge;
- error с безопасным retry.

## 4.2. Экран «Контур отделения»

Содержит:

- сводку отделения;
- очередь проблем по severity/age;
- workload врачей;
- распределение пациентов по этапам;
- ближайшие события;
- причины задержек;
- Data Quality blockers.

Список врачей не сортировать как «лучший/худший». Сортировка — по объёму активного backlog, а подпись подчёркивает, что это операционная нагрузка, не оценка качества помощи.

## 4.3. Экран «Мой день»

Содержит:

- краткую сводку;
- chronological action list;
- фильтры «просрочено / сегодня / 7 дней / без плана»;
- быстрый переход к событию/чек-листу/данным;
- assigned attention issues;
- completed today для ощущения прогресса.

По умолчанию показывать только actionable элементы. Полный реестр пациентов остаётся в отдельном пункте.

## 4.4. «Центр внимания»

### Назначение

Объединить вычисляемые сигналы и persisted manual issues в единую операционную очередь, не смешивая их природу.

Типы источников:

- `overdue_event`;
- `no_next_action`;
- `data_quality`;
- `incomplete_checklist`;
- `manual_attention`;
- `organizational_delay`;
- `escalation`.

### Представление строки

- пациент;
- текущий этап;
- тип и причина;
- severity;
- возраст сигнала;
- владелец;
- срок решения;
- status;
- последнее действие;
- next action.

### Принцип хранения

Вычисляемые сигналы не нужно массово копировать в БД. Они формируются существующими services. Если пользователь назначает владельца, срок или эскалирует сигнал, создаётся/привязывается persisted attention issue.

Это сохраняет текущую архитектуру и избегает синхронизации двух источников истины.

### Жизненный цикл persisted issue

`open → in_progress → resolved`

Допустимые операции:

- назначить владельца;
- установить/изменить срок;
- добавить структурированное действие и комментарий;
- эскалировать;
- закрыть с resolution;
- повторно открыть с причиной.

Для Executive Demo допустим минимальный lifecycle `open/in_progress/resolved`; полноценные SLA pause/cancel/delegate остаются после v1.0.

## 4.5. Верх карточки пациента — «Контроль маршрута»

Существующий timeline не изменяется по смыслу. Над ним появляется компактный control header:

| Поле | Содержание |
|---|---|
| Сейчас | текущий этап и время на нём |
| Далее | ближайшее незавершённое плановое событие |
| Ответственный | лечащий врач; для persisted issue — владелец проблемы |
| Срок | дата/время следующего события или due date проблемы |
| Отклонение | «в срок», «сегодня», «просрочено N дней», «нет следующего действия» |
| Блокирующий фактор | наиболее значимый активный сигнал с указанием источника |
| Требуемое действие | короткий action label и переход в нужный tab/timeline item |

### Правила

- не скрывать остальные сигналы: показывать главный и `+N`;
- не выводить «всё хорошо», если данные недостаточны;
- «следующий этап» не угадывать из линейного списка, если нет запланированного события;
- для read-only роли не показывать write CTA;
- источник каждой формулировки должен быть детерминирован backend.

## 4.6. Экран управленческого drill-down

Единый drawer/page для всех KPI:

- название и определение показателя;
- applied filters;
- total unique patients;
- breakdown by severity/department/stage;
- sortable patient rows;
- pagination;
- export только при существующем permission;
- переход к карточке.

Не создавать отдельный экран для каждого KPI. Использовать параметризованный detail view поверх расширенного `/api/analytics/details`.

## 4.7. Первый вход по ролям

После login:

- `deputy_chief_oncology`, `caop_head` → «Пульс клиники»;
- `department_head` → «Контур отделения»;
- `doctor` → «Мой день»;
- `developer` → «Пульс клиники» в global scope либо последний разрешённый раздел.

Для demo предпочтительно всегда открывать role home, чтобы сценарий был воспроизводим. Persisted last-view можно оставить после v1.0.

## 4.8. Пятиминутный сценарий демонстрации

**0:00–0:30 — проблема.** «Сегодня руководителю нужно собрать информацию из нескольких источников; Clinic Tracker даёт единый контроль маршрута».  
**0:30–1:15 — Пульс клиники.** Показать control rate, 8+ overdue, no next action и risk map.  
**1:15–2:00 — найти узкое место.** Открыть отделение и этап с максимальным отклонением.  
**2:00–3:00 — drill-down до пациента.** Показать конкретную просрочку, владельца, срок и историю.  
**3:00–4:00 — карточка и маршрут.** Показать «Сейчас / Далее / Блокер» и существующий timeline.  
**4:00–4:40 — role workspace.** Переключиться на врача и показать «Мой день».  
**4:40–5:00 — итог.** «Руководитель видит, врач действует, система сохраняет ответственность».

Сценарий использует синтетических пациентов: один нормальный маршрут, один overdue 15+, один без следующего действия, один с закрытой эскалацией.

---

# 5. Изменения frontend

## 5.1. Информационная архитектура

### Основная навигация

**Работа**

- role home: «Пульс клиники» / «Контур отделения» / «Мой день»;
- Пациенты;
- Календарь;
- Центр внимания.

**Аналитика**

- Аналитика;
- Качество данных — видимо руководящим и административным ролям, для врача доступно через relevant actions.

**Коммуникации**

- Уведомления.

**Администрирование** — collapsed group, только по permissions:

- Импорт / Экспорт;
- Сотрудники;
- Структура;
- Журнал аудита;
- Настройки.

### Что объединить или понизить

- «Чек-листы» убрать из top-level для руководителя и врача: checklist issues входят в role home/центр внимания; полный экран можно оставить secondary route.
- Качество данных не должно конкурировать с главным executive flow; на «Пульсе» показывается data confidence и drill-down.
- Входящие системные уведомления и actionable attention должны иметь ясное различие: уведомление сообщает, Центр внимания требует решения.
- Outbound patient notifications остаются вкладкой отдельного коммуникационного раздела.

## 5.2. Новые view-компоненты

Без framework migration добавить:

- `role-home` container;
- KPI card с `value`, `delta`, `severity`, `definition`;
- risk matrix/table;
- decision queue;
- department comparison;
- unified analytics detail drawer;
- patient control header;
- attention issue owner/due/history panel;
- contextual breadcrumbs и preserved filter state.

## 5.3. Стратегия JavaScript

Текущий `static/app.js` уже крупный. Executive Demo не должен приводить к ещё одному большому неструктурированному блоку.

Рекомендуемая минимальная декомпозиция без build system:

- `static/executive-api.js` — запросы и query serialization;
- `static/executive-metrics.js` — presentation mapping без пересчёта серверных KPI;
- `static/executive-views.js` — role homes, pulse, detail drawer;
- `static/attention-center.js` — очередь и persisted issue actions;
- `static/patient-control.js` — header карточки.

Подключение — локальные `defer` scripts либо ES modules после проверки совместимости с текущим bootstrap. Не переносить весь существующий frontend в рамках v1.0.

Правила:

- все KPI приходят рассчитанными backend;
- frontend только форматирует;
- DOM строится safe APIs (`textContent`, `createElement`);
- запрещены inline handlers/styles, `innerHTML`, remote CDN;
- общий API error handler и abort stale requests;
- formatter дат использует timezone из analytics meta;
- keyboard navigation, focus management и reduced motion сохраняются.

## 5.4. CSS и визуальная иерархия

- сохранить текущие tokens и темы;
- добавить executive-specific layout в отдельный stylesheet или чёткий section существующего CSS;
- первый viewport проектировать под 1440×900 и поддержать 1280×720 для переговорной;
- не использовать более трёх уровней severity на одном виджете;
- delta показывать числом и словом, не только стрелкой/цветом;
- risk map должна оставаться таблицей на screen reader и узком экране;
- mobile остаётся поддерживаемым, но основной acceptance Executive Demo — desktop.

## 5.5. Изменения текущей аналитики

### Поднять на первый уровень

- control rate;
- patients needing action;
- overdue aging;
- no next action;
- department risk;
- bottleneck;
- open/escalated issues.

### Оставить вторым уровнем

- пациенты по этапам;
- локализации;
- workload врачей;
- checklist completion;
- notification queue status;
- полный Data Quality breakdown.

### Убрать с executive first screen

- технические статусы mock notification provider;
- детали очереди отправки;
- общие pie/bar charts без сравнения или action;
- длинный ряд равнозначных KPI cards;
- сортировку врачей, визуально похожую на performance rating.

Эти данные не удаляются из продукта — они меняют уровень навигации.

## 5.6. Demo-specific UX

- visible badge «Демонстрационные данные»;
- подготовленный период «30 дней»;
- reset demo filters;
- стабильные synthetic fixtures;
- запрещено автоматическое обновление, меняющее цифры во время презентации;
- один refresh по кнопке и timestamp;
- fallback screen при недоступности одной секции без падения всего dashboard.

---

# 6. Изменения backend/API

## 6.1. Общий подход

Расширять существующие `backend/app/analytics` и `patient_attention`, а не создавать параллельную платформу отчётности.

Все агрегаты:

- считаются server-side;
- получают `CurrentUser`;
- начинают запрос с `policy.patient_scope_filter`;
- возвращают `AnalyticsMeta` с timezone, computed_at, scope, filters и definitions;
- не включают PHI в audit;
- используют bounded filters/pagination;
- имеют детерминированную сортировку.

## 6.2. Предлагаемые read endpoints

### `GET /api/analytics/pulse`

Назначение: единый payload первого executive screen.

Ответ:

- `meta`;
- `kpis`;
- `decision_queue`;
- `risk_summary`;
- `bottlenecks`;
- `department_summary`;
- `trend`;
- `data_confidence`.

Endpoint должен агрегировать существующие service-функции за ограниченное число SQL-запросов и не вызывать отдельный запрос на каждую карточку.

### `GET /api/analytics/departments`

Поля строки:

- department ID/name;
- active patients;
- control rate;
- overdue 1–7, 8–14, 15+;
- no next action;
- critical quality;
- open/escalated issues;
- median/P90 current stage age.

### `GET /api/analytics/risks`

Возвращает risk matrix и breakdown с `patients_count` и `signals_count` отдельно.

### `GET /api/workspace/today`

Роль-зависимая очередь:

- overdue;
- today;
- next 7 days;
- no next action;
- assigned issues;
- recently completed.

Для заведующего scope даёт отделение, для врача — только собственных пациентов. Глобальные роли могут не использовать endpoint.

### `GET /api/patients/{patient_id}/control-summary`

Возвращает:

- current stage/age;
- next action/event;
- responsible actor;
- due date;
- deviation state;
- primary blocker;
- additional signal count;
- required action/target section.

Недоступный пациент — тот же safe 404.

## 6.3. Расширение detail API

Расширить allowlist `detail_type` существующего `/api/analytics/details`:

- `needs_action`;
- `overdue_8_plus`;
- `overdue_15_plus`;
- `no_next_action`;
- `critical_quality`;
- `open_escalation`;
- `department_risk`;
- `stage_bottleneck`.

Поддержать безопасные фильтры:

- department ID;
- stage;
- severity;
- owner user ID;
- overdue bucket;
- source type;
- status.

Ограничения `limit 1..200`, stable order и scope-before-pagination сохраняются.

## 6.4. Новые вычисляемые метрики

### `no_next_action`

Активный пациент, у которого нет незавершённого события с плановой датой/временем сегодня или в будущем в текущем релевантном history entry.

Граничные случаи:

- terminal stages исключаются;
- cancelled/no-plan событие не считается следующим действием;
- событие без даты не снимает сигнал;
- overdue событие формирует overdue, а не «следующее действие»;
- отсутствие history обрабатывается как data confidence issue и no next action, но причины отображаются отдельно.

### `route_under_control`

Считать строго по определению раздела 3.2. Возвращать numerator, denominator, percent и breakdown exclusions. При нулевом denominator — `null`, не `100%`.

### `needs_action`

Количество уникальных активных пациентов с хотя бы одним Critical/High signal. Возвращать также количество signals, чтобы избежать двойного счёта.

### `department_control`

Те же правила на department scope; не использовать как оценку качества отделения без контекста объёма.

### `bottleneck`

Для v1.0 — не prediction. Это этапы с:

- высоким числом текущих пациентов;
- высокой median/P90 длительностью текущего этапа;
- высокой долей overdue/no-next-action.

Backend возвращает составляющие, UI не рисует единый score без объяснения.

## 6.5. Attention write API

Существующие endpoints сохранить. Добавить узкие операции:

- `PATCH /api/patients/{patient_id}/attention/{issue_id}` — owner, dueAt, status;
- `POST /api/patients/{patient_id}/attention/{issue_id}/actions` — добавить структурированное действие;
- `GET /api/patients/{patient_id}/attention/{issue_id}/history` — история;
- опционально `POST .../reopen` — только если входит в согласованный demo scope.

Каждый write:

- требует CSRF;
- требует writable patient scope;
- проверяет, что owner — активный пользователь, способный видеть пациента;
- не позволяет назначением владельца расширить доступ;
- пишет PHI-minimised audit event;
- валидирует длины и enum allowlists;
- использует одну транзакцию для issue + history.

Глобальные read-only роли получают 403 на write endpoints.

## 6.6. Performance budget

Для synthetic demo dataset:

- `/api/analytics/pulse`: p95 ≤ 800 ms на 5 000 пациентов в reference environment;
- detail first page: p95 ≤ 500 ms;
- workspace today: p95 ≤ 500 ms;
- patient control summary: p95 ≤ 250 ms;
- число SELECT pulse должно быть ограниченным и тестироваться, без N+1;
- response pulse желательно ≤ 250 KB без patient lists;
- detail patients загружаются только после drill-down.

## 6.7. Audit events

Добавить allowlisted события без медицинского текста:

- `attention_issue_assigned`;
- `attention_issue_due_changed`;
- `attention_issue_status_changed`;
- `attention_issue_action_added`;
- `attention_issue_reopened` — если реализовано.

Разрешённые audit details: issue ID, patient ID, actor ID/role, target owner ID, previous/new status, due date. Не писать ФИО, диагноз, свободный комментарий и формулировку проблемы.

Чтение «Пульса» не должно создавать audit row на каждый refresh, если текущая политика не логирует обычное чтение analytics.

---

# 7. Новые сущности данных (если нужны)

## 7.1. Принцип минимального изменения

Большинство новых показателей вычисляется из существующих таблиц. Новая универсальная таблица `tasks` для Executive Demo не нужна: она создаст второй workflow рядом с `patient_attention_issues`.

Нужны только расширение attention issue и журнал его действий.

## 7.2. Расширение `patient_attention_issues`

Предлагаемые nullable/compatible поля:

| Поле | Назначение |
|---|---|
| `owner_user_id` | текущий владелец решения |
| `due_at` | срок решения |
| `status` | `open`, `in_progress`, `resolved`; миграция старого open/closed |
| `severity` | `critical`, `high`, `medium`, `info`; default определяется reason code |
| `source_type` | `manual`, `computed_signal` |
| `source_key` | стабильный allowlisted ключ вычисляемого сигнала |
| `updated_at` | последнее изменение workflow |

Если существующие `closed_at`/`closed_by_user_id` уже используются, сохранить их как совместимые факты resolution и не создавать дублирующую семантику.

### Ограничения

- foreign key owner → users;
- owner может быть null для «не назначено»;
- status enum проверяется приложением и DB constraint, если совместимо с миграционным механизмом;
- due_at хранится в ISO timestamp;
- уникальность активной пары `(patient_id, source_type, source_key)` для computed signal следует вводить только если создание issue из сигнала автоматизировано;
- свободный текст не используется в `source_key`.

## 7.3. Новая таблица `patient_attention_history`

Минимальные поля:

- `id`;
- `issue_id`;
- `patient_id`;
- `action_type`;
- `actor_user_id`;
- `from_status`;
- `to_status`;
- `owner_user_id`;
- `due_at`;
- `comment`;
- `created_at`.

`action_type` allowlist:

- `created`;
- `assigned`;
- `due_changed`;
- `started`;
- `commented`;
- `escalated`;
- `resolved`;
- `reopened`.

Комментарий может содержать чувствительный контекст: он доступен только в patient scope, не попадает в generic logs, analytics aggregates, URLs и audit detail.

## 7.4. Что не хранить в v1.0

- ежедневные snapshots всех KPI;
- копии всех Data Quality findings;
- копии каждого overdue event в attention table;
- универсальные clinical SLA rules;
- department score;
- predicted risk;
- отдельную executive cache table;
- user dashboard preferences.

Delta и тренд для demo можно считать из имеющейся истории пациентов/этапов там, где это корректно. Для метрик текущего состояния, у которых нет истории, показывать «текущее состояние», а не выдуманный trend.

## 7.5. Вопрос SLA

В v1.0 не создавать сложную таблицу SLA rules до клинического согласования. Использовать:

- плановую дату конкретного события как первичный договорённый срок;
- buckets просрочки;
- no-next-action;
- длительность этапа как наблюдаемую метрику.

Если руководство утвердит нормативы по маршрутам, отдельная версия после demo вводит versioned `route_sla_rules` с profile/stage/event/effective dates и исключениями.

---

# 8. План реализации по этапам

## Этап 0. Product definition и фиксация методик

**Цель:** исключить спор о цифрах во время разработки и демонстрации.  
**Оценка:** 3–5 рабочих дней.

Работы:

1. Утвердить шесть KPI первого экрана.
2. Согласовать определения active, under control, needs action, no next action.
3. Зафиксировать severity matrix.
4. Утвердить роль-в-workspace mapping.
5. Согласовать demo script и synthetic personas.
6. Зафиксировать out-of-scope.
7. Подготовить acceptance examples на 10–15 пациентах вручную.

Результат: glossary + KPI contract + clickable low-fidelity wireframe.

## Этап 1. Backend analytics foundation

**Цель:** получить проверяемый server-side «Пульс» без изменения write workflow.  
**Оценка:** 5–8 рабочих дней.

Работы:

1. Реализовать metric helpers `no_next_action`, `route_under_control`, `needs_action`, bottleneck.
2. Добавить pulse/departments/risks endpoints.
3. Расширить analytics details allowlist.
4. Добавить workspace today endpoint.
5. Добавить patient control-summary endpoint.
6. Установить definitions/meta для каждого показателя.
7. Добавить RBAC, performance и edge-case tests.

Gate:

- ручные examples совпадают с API;
- scope matrix пройдена;
- нет N+1;
- существующие 479 test cases остаются зелёными.

## Этап 2. Role homes и drill-down frontend

**Цель:** показать управленческий контур на существующих данных.  
**Оценка:** 7–10 рабочих дней.

Работы:

1. Перестроить navigation grouping.
2. Реализовать role redirect after login.
3. Собрать «Пульс клиники».
4. Собрать «Контур отделения» и «Мой день».
5. Реализовать unified detail drawer/page.
6. Сохранить filters/back navigation.
7. Добавить patient control header read-only.
8. Проверить light/dark, 1440×900, 1280×720 и mobile fallback.

Gate:

- руководитель выполняет drill-down без ручного поиска;
- врач видит actionable queue первым экраном;
- UI не считает KPI самостоятельно;
- keyboard и CSP tests пройдены.

## Этап 3. Accountable Attention Workflow

**Цель:** показать не только обнаружение, но и контроль решения.  
**Оценка:** 6–9 рабочих дней.

Работы:

1. Миграция attention issues.
2. History table.
3. Owner/due/status/actions API.
4. Permission checks назначения владельца.
5. Центр внимания frontend.
6. История решения в карточке пациента.
7. Audit events.
8. Migration, concurrency и rollback tests.

Gate:

- проблема имеет причину, владельца, срок и историю;
- computed finding не дублируется без контроля;
- read-only leadership не получает write-доступ;
- смена owner не расширяет patient scope.

## Этап 4. Demo polish и аналитическая редактура

**Цель:** сделать ценность понятной без комментариев разработчика.  
**Оценка:** 4–6 рабочих дней.

Работы:

1. Финальная визуальная иерархия KPI.
2. Подписи «что это значит» и metric definitions.
3. Удаление/понижение вторичных графиков.
4. Synthetic demo dataset и deterministic seed.
5. Badge демонстрационных данных.
6. Empty/loading/error/stale states.
7. Executive screenshots и актуализация документации.
8. Репетиция пятиминутного сценария.

## Этап 5. Verification и release candidate

**Цель:** выпуск без регрессии v0.9.0-stable.  
**Оценка:** 3–5 рабочих дней.

Проверки:

- весь существующий test suite;
- новые analytics unit/integration tests;
- полная RBAC matrix для каждого нового endpoint/detail type;
- frontend CSP/XSS tests;
- CSRF/write negative tests;
- migration from v0.9.0-stable copy;
- backup/restore новой schema;
- reference performance smoke;
- Chrome desktop demo matrix;
- keyboard-only walkthrough;
- screenshot regression ключевых экранов;
- five-minute usability rehearsal с человеком, не участвовавшим в разработке.

## Рекомендуемая последовательность релизов

- `v1.0.0-alpha.1`: analytics contracts и APIs;
- `v1.0.0-alpha.2`: role homes и patient control header;
- `v1.0.0-beta.1`: attention owner/due/history;
- `v1.0.0-rc.1`: synthetic dataset, polish, full regression;
- `v1.0.0-executive-demo`: зафиксированный демонстрационный релиз.

Ориентировочный общий объём: **28–43 рабочих дня** одной компактной product/engineering команды без enterprise-интеграций и инфраструктурного переезда.

---

# 9. Риски изменений

## 9.1. Неверная управленческая интерпретация KPI

**Риск:** control rate воспринимается как клиническое качество или официальный SLA.  
**Вероятность/влияние:** High/High.  
**Снижение:** определения в API/UI, отказ от термина SLA до утверждения, показывать составляющие и data confidence.

## 9.2. Двойной счёт пациентов

**Риск:** один пациент с несколькими проблемами завышает KPI.  
**Вероятность/влияние:** High/High.  
**Снижение:** отдельно `unique patients` и `signals`; единые backend helpers; fixture tests на пересечение причин.

## 9.3. Расширение доступа через analytics

**Риск:** новый department/risk endpoint раскрывает строки вне scope.  
**Вероятность/влияние:** Medium/Critical.  
**Снижение:** scope-first queries, empty response для недоступных filters, полная RBAC matrix, safe IDs, no client filtering.

## 9.4. Назначение владельца раскрывает пациента

**Риск:** issue назначается сотруднику, который не имеет patient scope.  
**Вероятность/влияние:** Medium/Critical.  
**Снижение:** owner eligibility check; назначение не меняет scope; UI предлагает только eligible users.

## 9.5. Дубли computed signals и manual issues

**Риск:** один overdue отображается как несколько независимых проблем.  
**Вероятность/влияние:** High/Medium.  
**Снижение:** stable source key, объединённое представление, materialize только при назначении/эскалации.

## 9.6. Перегруз первого экрана

**Риск:** «Пульс» превращается в текущую аналитику с новым названием.  
**Вероятность/влияние:** High/High.  
**Снижение:** максимум шесть KPI, три decision blocks, остальное ниже fold/drill-down; usability test «10 секунд».

## 9.7. Рост frontend-монолита

**Риск:** добавление всех функций в `app.js` повышает регрессионность.  
**Вероятность/влияние:** High/Medium.  
**Снижение:** локальная feature-декомпозиция без framework rewrite; shared render/error helpers; node syntax and browser tests.

## 9.8. Производительность aggregate endpoints

**Риск:** pulse повторно запускает тяжёлый Data Quality и множество похожих запросов.  
**Вероятность/влияние:** Medium/High.  
**Снижение:** один shared quality context per request, bulk queries, query-count tests, payload budgets, lazy detail loading.

## 9.9. Неполная история для trend

**Риск:** UI показывает динамику метрики, которая ранее не сохранялась.  
**Вероятность/влияние:** High/High.  
**Снижение:** trend только для исторически выводимых фактов; current-only label для остальных; никаких синтетических прошлых значений.

## 9.10. Миграция attention workflow

**Риск:** существующие open/closed issues некорректно переходят в status model.  
**Вероятность/влияние:** Medium/High.  
**Снижение:** backward-compatible defaults, migration fixtures, restore test, сохранение closed fields.

## 9.11. Demo scope начинает вытеснять pilot readiness

**Риск:** презентационная готовность принимается за production readiness.  
**Вероятность/влияние:** High/Critical.  
**Снижение:** synthetic badge, release naming, явный disclaimer, сохранение Real-Data Gate из product review.

## 9.12. Руководительский экран создаёт ложный рейтинг врачей

**Риск:** нагрузка/просрочки используются как персональная оценка качества.  
**Вероятность/влияние:** Medium/High.  
**Снижение:** отделение-first view, контекст объёма/профиля, подписи «операционная нагрузка», отсутствие performance score.

---

# 10. Критерии готовности Executive Demo v1.0

## 10.1. Продуктовые критерии

- [ ] После входа каждая роль попадает в своё рабочее пространство.
- [ ] Руководитель за 10 секунд может назвать состояние: под контролем / требует внимания и главную проблемную зону.
- [ ] На первом viewport не более шести KPI.
- [ ] У каждого KPI есть определение, timestamp, scope и drill-down.
- [ ] Один пациент не удваивает patient count при нескольких сигналах.
- [ ] Руководитель проходит KPI → отделение/проблема → пациент → карточка максимум за три взаимодействия.
- [ ] «Пульс» показывает data confidence и не подменяет недоступные значения нулём.
- [ ] Врач видит просроченные, сегодняшние и ближайшие действия без перехода в общий реестр.
- [ ] Заведующий видит проблемы и workload только своих отделений.
- [ ] Карточка показывает «Сейчас / Далее / Ответственный / Срок / Блокер / Действие».
- [ ] Timeline и текущие patient workflows сохранены.

## 10.2. Центр внимания

- [ ] Каждая persisted проблема имеет reason, owner или явно «не назначено», due date или явно «срок не задан», status и history.
- [ ] Вычисляемый сигнал не создаёт неограниченные дубли persisted issues.
- [ ] Закрытие требует resolution action.
- [ ] История показывает actor и время, но PHI не попадает в generic audit/logs.
- [ ] Read-only руководитель не может изменить issue.
- [ ] Owner вне patient scope не может быть назначен.

## 10.3. Аналитические критерии

- [ ] `route_under_control` имеет тестируемую формулу и breakdown исключений.
- [ ] `no_next_action` корректно обрабатывает terminal, overdue, cancelled и undated events.
- [ ] Просрочка разделена на 1–7, 8–14 и 15+ либо сохраняет совместимые текущие buckets с явным executive grouping.
- [ ] Department comparison показывает объём и не позиционируется как рейтинг качества.
- [ ] Trend показывается только там, где есть исторические факты.
- [ ] Каждый агрегат совпадает с detail total для одинаковых filters/scope.
- [ ] Все времена используют backend timezone metadata.

## 10.4. Security и RBAC

- [ ] Все новые read endpoints покрыты пятью ролями и out-of-scope cases.
- [ ] Все write endpoints требуют CSRF и writable patient scope.
- [ ] Global read-only роли получают 403 на изменения.
- [ ] Недоступный patient/issue возвращает безопасный 404.
- [ ] Analytics не раскрывает имена/IDs за пределами scope.
- [ ] CSP, no-inline, no-`innerHTML` и no-PHI-localStorage свойства сохранены.
- [ ] Новые audit events не содержат ФИО, диагноза, comments и других PHI.
- [ ] CSV/export permissions не расширены неявно.

## 10.5. Качество и производительность

- [ ] Все тесты baseline проходят без изменения ожиданий безопасности.
- [ ] Добавлены tests для metric formulas, intersections, empty denominator и date boundaries.
- [ ] Добавлены query-count/N+1 tests для pulse.
- [ ] Выполнена миграция копии v0.9.0-stable и обратная проверка данных.
- [ ] Backup/restore работает с новой schema.
- [ ] Pulse p95 соответствует ≤800 ms на reference dataset 5 000 пациентов.
- [ ] Нет console errors и необработанных API failures в demo flow.
- [ ] Chrome desktop 1440×900 и 1280×720 проходят визуальную приёмку.
- [ ] Основной сценарий доступен с клавиатуры.

## 10.6. Демонстрационная готовность

- [ ] Есть deterministic synthetic dataset.
- [ ] На всех demo-экранах явно указано «Демонстрационные данные».
- [ ] Подготовлены четыре истории пациентов: нормальная, overdue 15+, no-next-action, resolved escalation.
- [ ] Пятиминутный сценарий пройден минимум тремя людьми, не участвовавшими в разработке.
- [ ] Не менее двух из трёх после просмотра могут ответить: где проблема, кто отвечает и какое действие требуется.
- [ ] Demo не требует CLI, ручного редактирования БД или перезапуска между сценариями.
- [ ] Документация и screenshots соответствуют release candidate.
- [ ] В презентации явно указано: Executive Demo не является разрешением на реальные медицинские данные.

## 10.7. Definition of Done версии

Executive Demo v1.0 готова, если одновременно выполняются четыре условия:

1. **Ценность видна:** руководитель понимает состояние и главное отклонение без экскурсии по меню.
2. **Данные доказуемы:** любой KPI раскрывается до конкретных пациентов и имеет определение.
3. **Ответственность видна:** у управляемой проблемы есть владелец, срок, статус и история.
4. **Baseline не ухудшен:** RBAC, security, тесты, timeline и существующие рабочие сценарии сохранены.

---

# Итоговая рекомендация

Executive Demo v1.0 следует строить не как «новую аналитику», а как **управленческий слой над уже существующим операционным ядром**.

Самая короткая формула версии:

> **Пульс → риск → пациент → ответственное действие.**

Если этот путь работает за три клика, цифры объяснимы, а роль врача получает собственный «Мой день», Clinic Tracker перестаёт выглядеть реестром с набором функций. Он начинает восприниматься как платформа, которая помогает клинике не терять пациента между этапами и делает отклонения управляемыми.

Именно это должно стать главным впечатлением руководителя через пять минут демонстрации.
