# WP‑I / I‑9 — B1 admission, постоянный History и восстановление фокуса после 409

**Режим:** review-only Draft. Открытие требует отдельного разрешения владельца. Merge, deploy, production и пилот с реальными данными исключены из этого ревью.

- Base `fix/wp-i-redesign-integration` · `f849b2909c2d23923e0ce996f0aca4b670ca9c18`
- Head `fix/i9-b1-focus-history-review` · `b5b408fe411f4431042eced96f0801cffb577a83`
- Git tree `cd00d4d55140d377038783234cc204c602741869`

## Что входит

| Файл относительно base | Изменение |
|---|---|
| `backend/app/db.py` | B1 admission для защищенного read release, в том числе проверка допуска и идентичности SQLite до выдачи |
| `backend/app/read_access.py` | B1 использует заново проверенный read-context, RBAC, release admission и атомарную запись audit/manifest |
| `backend/tests/test_wp_i_i9_runtime_admission.py` | B1 регрессии допуска защищенных чтений и отказов |
| `static/app.js` | Фокус при загрузке и терминальном двойном 409 с проверками владельца фокуса, навигации, read version и session epoch |
| `tools/tests/wp_i_card/history.cjs` | Постоянная синхронизация теста `unknownDenial` вокруг целевого scoped чтения с реальным 404 |

Две последние правки побайтово совпадают с принятыми focus и History. Изменения backend, схема, аудит и security gates совпадают с точным B1. История и факт принятого read-audit проверяются отдельными тестами. Восстановление после 409 ограничено одним автоматическим повторным чтением, медицинских записей от него нет.

## Проверки exact-SHA

- **15/15 jobs, 2842/2842 exact-once, 0 failed и 0 skipped.** SHA‑256 списка ID совпал с B1. Release-gate, policy, CSP/XSS, Bandit, Gitleaks и аудит зависимостей прошли. [Полный backend/security CI](https://github.com/IskhakovMA/fixes/actions/runs/45688618663).
- **18/18 jobs, 49/49 команд, History 7/7 и 16/16 групп.** [Полный hosted Chromium](https://github.com/IskhakovMA/fixes/actions/runs/45688807818). Workflow-only commit `f026f1e46b914157a484131cfb24f3d72c10469e` перед запуском переключается на неизменный head. History работает из постоянного файла. У Workspace сохранены только принятые синтетические диагностические помощники, без изменения продуктовых файлов.
- Локальный Chromium на exact head: 14 focus, 6 native zoom в обеих темах 100/200/400%, 7 History / 16 групп, Quality 9 отказных групп и 5 функциональных.

## Открытые условия и область ревью

- Pilot P: 98% первых своевременных HTTP 200 — **PROPOSED**. Прежний shakedown B1 дал 50/60 и 49/60 первых 200, 57/60 и 59/60 готовых UI, 20 естественных 409, 17 восстановлений и 3 терминальных двойных 409. Результаты служат контекстом, отдельная подтверждающая серия не выполнена. Focus влияет на доступность явного восстановления и фокуса.
- D8: 16 Mac NOT TESTED, 16 Windows BLOCKED, 16 physical mobile BLOCKED. Руководство оператора и подслучай двойного 409 сохранены. В квитанции при будущем сеансе необходимо указать точный head этого состава, фактическое ручное исполнение и платформу.
- Исторические 503: **UNKNOWN, объяснено 0/2**. Для неизвестного COMMIT действует контрольное авторизованное чтение, сверка версии и ограниченный replay по договору маршрута. Варианты A/B остаются у владельца.
- Предложение владельцу: отдельно разрешать **техническое код-ревью** при открытом риске 503 и явном запрете продвижения. Это изменение порядка открытия Draft, оно требует отдельного решения владельца. До такого разрешения Draft остается NO-GO.

[Итоговые evidence и контрольные суммы](https://github.com/IskhakovMA/fixes/tree/evidence/i9-combined-candidate-review-2026-11-25/evidence/i9-combined-candidate-review) · [Метрики, D8 и предыдущее независимое ревью](https://github.com/IskhakovMA/fixes/tree/815f0844c743bf34ea1676d0c4611c8a08b2d83b/evidence/i9-p-recovery-focus) · [Форма решения по 503](https://github.com/IskhakovMA/fixes/blob/3bc3d749462a80c21ed8e1e48bfe4f45afa54c28/evidence/i9-p-browser-acceptance/I9_503_OWNER_SIGNOFF.md)
