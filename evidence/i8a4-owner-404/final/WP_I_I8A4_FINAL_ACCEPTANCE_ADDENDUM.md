# Clinic Tracker — закрытие приемки I-8A4

24 ноября 2026 г. **I-8A4 закрыт в пределах принятого контракта.** PR №8 интегрирован обычным merge commit в `fix/wp-i-redesign-integration`. Публичный допуск Quality v1 остается закрыт. Следующий этап I-9.

## Ревью и интеграция

- [Ревью №6038743684](https://github.com/IskhakovMA/fixes/pull/8#pullrequestreview-6038743684) принимает точный HEAD к интеграции и фиксирует отсутствие блокирующих замечаний. GitHub зарегистрировал ревью как `COMMENTED`. Незакрытых review threads не было.
- [PR №8](https://github.com/IskhakovMA/fixes/pull/8) переведен из Draft в Ready for Review. Повторное чтение подтвердило ожидаемые base и HEAD перед слиянием с проверкой HEAD.
- [Фактический merge-коммит](https://github.com/IskhakovMA/fixes/commit/a86a9680f88aa89e9d661095a30564f50afe23ba) `a86a9680f88aa89e9d661095a30564f50afe23ba`. Родители по порядку: проверенная база `0a416464b9b5411a89e06935bd2c8ef8e559ff56` и принятый HEAD `a9a23ba1f556f7f4ced4953a2ca8997230811d87`.
- Дерево `d291ea53f51fb53abb1fb691b7e4a0aedb382825` совпадает с деревом принятого кандидата и проверочного merge `1a713347bec27e935543d5dfbf37a8559dfe8083`. От базы изменился один файл `tools/tests/wp_i_quality/browser_faults.cjs`, +40/−11. Сверка проведена по GitHub и восстановленному локально дереву.

## GitHub CI

| Запуск | SHA | Результат |
|---|---|---|
| [Кандидат 45378143859](https://github.com/IskhakovMA/fixes/actions/runs/45378143859) | `a9a23ba1f556f7f4ced4953a2ca8997230811d87` | 15/15, 2821/2821 exact-once |
| [Проверочное слияние 45378309511](https://github.com/IskhakovMA/fixes/actions/runs/45378309511) | `1a713347bec27e935543d5dfbf37a8559dfe8083` | 15/15, 2821/2821 exact-once |
| [Фактическое слияние 45389031189](https://github.com/IskhakovMA/fixes/actions/runs/45389031189) | `a86a9680f88aa89e9d661095a30564f50afe23ba` | **15/15, 2821/2821 exact-once, release-gate success** |

Запуск `45389031189` выполнен по событию `push` в интеграционной ветке и завершился 24 ноября в 15:15:18 МСК. Журналы [backend-tests-verify](https://github.com/IskhakovMA/fixes/actions/runs/45389031189/job/138436811718) и [release-gate](https://github.com/IskhakovMA/fixes/actions/runs/45389031189/job/138436854434) подтверждают результат.

## Принятые доказательства

Два независимых браузерных прогона на синтетических данных подтвердили очистку карточки, кэша, строки и черновика после owner 404 и возврат в реестр в той же сессии. Поздний HTTP 200 не восстановил данные. Сценарий защитной блокировки после параллельного 409 воспроизведен отдельно. [Два браузерных прогона](https://github.com/IskhakovMA/fixes/actions/runs/45378452509) · [Повторный прогон native zoom](https://github.com/IskhakovMA/fixes/actions/runs/45379053632) · [Трасса owner 404 и позднего 200](https://github.com/IskhakovMA/fixes/actions/runs/45379468879)

[Ранее опубликованный отчет](https://github.com/IskhakovMA/fixes/blob/0772d04da898b6699ef26929fb82b5f594a0248b/evidence/i8a4-owner-404/WP_I_I8A4_OWNER_404_ADDENDUM.md) и [архив доказательств](https://github.com/IskhakovMA/fixes/blob/0772d04da898b6699ef26929fb82b5f594a0248b/evidence/i8a4-owner-404/WP_I_I8A4_OWNER_404_EVIDENCE.zip) закреплены за коммитом `0772d04da898b6699ef26929fb82b5f594a0248b`. SHA-256 архива `88df70578211aee1f3766d8e12309354c7d7b8e994f81fff291bc4bed2824c02`. Сверены CRC и 17 записей манифеста. Все 62 защищенных диагностических оригинала сохранены вне рабочего дерева. Проверены CRC, размеры и SHA-256 по внутреннему манифесту.

## Открытое ограничение

**Два исторических HTTP 503 без прикладного кода остаются нерешенными.** Причина не установлена, контрольные повторы их не воспроизвели. Отдельная проверка подтвердила ожидаемый кодированный HTTP 503 для закрытого публичного допуска Quality v1. Приемка подтверждает проверенный контракт на синтетическом стенде.

`main`, production, SQLite v33, рабочая медицинская база и публичная активация Quality v1 вне выполненной интеграции. Этап I-9 не начат.
