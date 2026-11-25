# Clinic Tracker I‑9 — объединенный B1 для технического ревью

Кандидат `b5b408fe411f4431042eced96f0801cffb577a83`, Git tree `cd00d4d55140d377038783234cc204c602741869`. Интеграционная база `f849b2909c2d23923e0ce996f0aca4b670ca9c18`. От B1 меняются только `static/app.js` и `tools/tests/wp_i_card/history.cjs`. [Кандидат на GitHub](https://github.com/IskhakovMA/fixes/commit/b5b408fe411f4431042eced96f0801cffb577a83) · [Точный полный diff к интеграции](https://github.com/IskhakovMA/fixes/compare/f849b2909c2d23923e0ce996f0aca4b670ca9c18...b5b408fe411f4431042eced96f0801cffb577a83)

| Доказательство | Область |
|---|---|
| [Происхождение](CANDIDATE_PROVENANCE.json), [отличия от интеграции](DIFF_FROM_BASE.tsv), [два файла от B1](FOCUS_HISTORY.diff.patch) | Точный состав и Git-цепочка |
| [Независимая сверка](INDEPENDENT_COMBINED_COMPOSITION.md) | Побайтовое соответствие focus и History, неизменность принятых backend и CI относительно B1 |
| [Полный CI](https://github.com/IskhakovMA/fixes/actions/runs/45688618663) | **15/15 jobs, 2842/2842 exact-once**, 0 failed и 0 skipped. SHA‑256 списка ID совпал с B1. [Машинная квитанция](CI_EXACT_CANDIDATE.json) |
| [Новый hosted Chromium](https://github.com/IskhakovMA/fixes/actions/runs/45688807818) | **18/18 jobs и 49/49 команд**, точное совпадение прежней матрицы, постоянный History. [Машинный пересчет](HOSTED_CHROMIUM_EXACT_CANDIDATE.json). Workflow на отдельной ветке проверяет exact candidate и не входит в продуктовый diff |
| [Локальный Chromium](I9_COMBINED_LOCAL_CHROMIUM.md) · [машинные данные](I9_COMBINED_LOCAL_CHROMIUM.json) | 14 адресных focus, шесть native zoom, семь History и 16 групп, Quality |
| [Итоговое независимое ревью](INDEPENDENT_FINAL_REVIEW.md) | Безопасность, полнота CI и hosted Chromium. |
| [Готовый текст Draft](REVIEW_ONLY_DRAFT.md) | Кандидат для технического ревью. Открытие PR требует отдельного разрешения владельца |
| [Следующий Fast Track backlog](FAST_TRACK_BACKLOG.md) | Только план. WP-J, Demo Priority и новая разработка не начинались |

**Кандидат технически готов к запросу разрешения на review-only Draft. Draft, Pilot P и production — NO-GO до применимых решений владельца.** Ручная D8 и эксплуатационные критерии открыты. Оба исторических 503 UNKNOWN. Пакет содержит агрегаты, хеши и разрешенные источники. Сырые журналы и медицинские данные исключены.
