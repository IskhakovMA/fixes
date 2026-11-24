# Clinic Tracker — приёмка интеграции Back/Forward, PR №10

24 ноября 2026 г. **Back/Forward закрыт после интеграционного CI. I-9 остаётся открытым.**

## Ревью и интеграция

[Ревью 6044510986](https://github.com/IskhakovMA/fixes/pull/10#pullrequestreview-6044510986) зафиксировало техническое принятие 9/10 без блокеров на точном HEAD. GitHub сохранил статус COMMENTED. Других отзывов, inline-комментариев и неразрешённых обсуждений при сверке не было. После Ready for Review повторно сверены HEAD, base и комментарии. Обычный merge выполнен в `fix/wp-i-redesign-integration` с проверкой принятого HEAD.

| Проверка Git | SHA |
| --- | --- |
| [Merge commit](https://github.com/IskhakovMA/fixes/commit/62be6549de80716ad0880faa2c7fc8b1d2582ce5) | `62be6549de80716ad0880faa2c7fc8b1d2582ce5` |
| Первый родитель, интеграционная база | `20aa7ae3431a29ae08016cbc660400fb700b935a` |
| Второй родитель, принятый HEAD PR | `29cd16d1d37f008467e449aa573df78f7b7a7970` |
| Дерево обоих проверенных состояний | `8327425e6f0505cb0371ff6cb4a7a52371cc804b` |

Git и GitHub подтвердили одинаковое дерево и ровно 12 согласованных путей относительно базы. Изменения охватывают ADR, `static/app.js` и десять браузерных тестовых файлов. Сверки по Git, CI, безопасности и браузерным доказательствам выполнены независимо.

## Доказательства

- [Chromium/FastAPI 45449179360](https://github.com/IskhakovMA/fixes/actions/runs/45449179360) на принятом HEAD — **18/18 PASS**. Проверены семь сценариев Back/Forward, фактический bfcache, оба решения по черновику, очистка при 404, смена эпохи и поздний 200, восстановление фокуса и Quality native zoom. Браузерные доказательства относятся к принятому HEAD с идентичным интеграционным деревом. [Матрица](https://github.com/IskhakovMA/fixes/blob/099e0ff3162ec2b374c0f9c8f0510d1c01a87080/evidence/i9-acceptance/back-forward/I9_BACK_FORWARD_ACCEPTANCE_MATRIX.md) · [Архив](https://github.com/IskhakovMA/fixes/blob/099e0ff3162ec2b374c0f9c8f0510d1c01a87080/evidence/i9-acceptance/back-forward/WP_I_I9_BACK_FORWARD_EVIDENCE.zip) · [Контрольные суммы](https://github.com/IskhakovMA/fixes/blob/099e0ff3162ec2b374c0f9c8f0510d1c01a87080/evidence/i9-acceptance/back-forward/SHA256SUMS)
- [Полный CI кандидата 45449168073](https://github.com/IskhakovMA/fixes/actions/runs/45449168073) — **15/15 PASS**, 2821/2821 backend exact-once, release-gate PASS.
- [Отдельный CI на merge SHA](https://github.com/IskhakovMA/fixes/actions/runs/45453776923) — **15/15 PASS**, 2821/2821 backend exact-once, release-gate PASS. [Verifier](https://github.com/IskhakovMA/fixes/actions/runs/45453776923/job/138666667945) · [Release gate](https://github.com/IskhakovMA/fixes/actions/runs/45453776923/job/138666732815)

Архив включает принятую браузерную матрицу и семь квитанций во вложенном неизменном ZIP, машиночитаемую квитанцию интеграции и текущий отчёт. SHA-256 исходного браузерного архива `f6cc757f3756bcd68566ff6886ef8eee80c4ed0ddb1333066dd1da80f697986e`. В квитанциях только синтетические сценарии.

## Неблокирующее замечание

В [presentation() в history.cjs](https://github.com/IskhakovMA/fixes/blob/29cd16d1d37f008467e449aa573df78f7b7a7970/tools/tests/wp_i_card/history.cjs#L123) ожидание всех `Animation.finished` через `Promise.all` не имеет собственного ограничения. Бесконечная или приостановленная CSS-анимация способна задержать тест. На принятом прогоне риск не воспроизвёлся. Для отдельной правки harness предложено ограниченное ожидание двух спокойных кадров или явный дедлайн с диагностикой при сохранении проверок axe. Принятый PR сохранён в точности.

## Открыто по I-9

- Ручная D8, включая Safari/VoiceOver, Firefox/NVDA и мобильные сценарии.
- Утверждение профиля нагрузки и критериев performance.
- Два исторических HTTP 503 без прикладного кода как отдельный риск.

Публичный Quality v1 закрыт. `main`, `clinic_tracker_new`, production, SQLite v33 и рабочая медицинская база вне интеграции. WP-J остаётся отдельным этапом.
