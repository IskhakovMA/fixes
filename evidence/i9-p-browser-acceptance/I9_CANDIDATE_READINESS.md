# I-9. Кандидат и три уровня допуска

Исходная интеграция `f849b2909c2d23923e0ce996f0aca4b670ca9c18` входит в ancestry B1 `3a0cb5db434032b3f7b6370c305c558a4b5d331c`. Точное дерево B1 — `595b8c35330883c2bd8056c12494bfad1b05111f`. Относительно интеграции меняются три файла: `backend/app/db.py`, `backend/app/read_access.py` и `backend/tests/test_wp_i_i9_runtime_admission.py` (648 добавлений, 24 удаления). Продуктовый diff ограничен приемом и выпуском защищенного чтения: same-connection data_version, admission и identity, повторная проверка контекста и атомарная запись аудита/manifest сохраняются. Схема v33, остальной backend и исходники UI побайтово совпадают относительно этой базы. E1/E2 в diff отсутствуют.

History `b4b1661ec6359800bfd700405b73b03f6c46b30d` имеет родителя B1 и меняет один `tools/tests/wp_i_card/history.cjs` (+21/−12). Backend B1 и H прошел по 15/15 jobs и 2842 exact-once. Accepted hosted B1 — 18/18 jobs и 49/49 команд, workflow `1cf6e74ad4fd5bfcdb93b21385a0bd3a9a4c08fc`. Вердикты относятся к соответствующим SHA и исходным процедурам проверки. [Backend B1](https://github.com/IskhakovMA/fixes/actions/runs/45603722694) · [Hosted B1](https://github.com/IskhakovMA/fixes/actions/runs/45663612243) · [History CI](https://github.com/IskhakovMA/fixes/actions/runs/45671923635)

| Уровень | Текущее решение | Доказательства и условие пересмотра |
|---|---|---|
| Review-only Draft | **NO-GO до отдельного разрешения** | Diff, ancestry, exact CI и Chromium позволяют обсуждать изменения на точном SHA. Незавершенные performance и D8 можно вынести в явно открытые условия запрета продвижения. Это допустимый формат технического ревью при выборе владельцем области и варианта B по 503. При выборе A Draft остается заблокированным. |
| Ограниченный синтетический P | **NO-GO** | Требуются разрешение владельца на подтверждающую серию, пригодный генератор, подтвержденные пороги, D8 по обязательным платформам, оператор, остановка и rollback. Короткий shakedown дает только технические наблюдения. |
| Production | **NO-GO** | Нужны Real-Data Gate, защищенная инфраструктура и HTTPS, права на реальные данные, восстановление и RPO/RTO, retention, наблюдаемость, эксплуатационная ответственность и отдельное решение о rollout. |

[Выбор по 503](I9_503_OWNER_SIGNOFF.md) · [Исходный протокол P и учебный стенд](https://github.com/IskhakovMA/fixes/tree/194098345585e0e6c964661832e60b89eb1a91c0/evidence/i9-pilot-readiness)
