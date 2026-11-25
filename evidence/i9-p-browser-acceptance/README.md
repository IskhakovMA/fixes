# Clinic Tracker I-9 — реальный браузерный shakedown профиля P

Продукт B1 `3a0cb5db434032b3f7b6370c305c558a4b5d331c`. История test-only `b4b1661ec6359800bfd700405b73b03f6c46b30d`. Изолированный инструмент и результаты относятся к точному чистому B1. Evidence-коммит добавляет только этот каталог; исходники продукта и принятые ветки не изменены.

- [Результаты двух реальных браузерных окон](P_BROWSER_SHAKEDOWN_REVIEW.md) · [Машинные агрегаты](P_BROWSER_SHAKEDOWN.json) · [Self-tests](P_HARNESS_SELF_TESTS.json)
- [Реальный 409, права, черновики и поздние ответы](fault/P_BROWSER_409_REGRESSIONS.md)
- [Оператор Mac D8](d8/D8_OPERATOR_README.md) · [Клавиатурный Chromium](d8/D8_KEYBOARD_CHROMIUM.json)
- [Независимое ревью](P_INDEPENDENT_REVIEW.md) · [Заявка на полную серию](P_CONFIRMATION_REQUEST.md)
- [Три уровня допуска](I9_CANDIDATE_READINESS.md) · [Решение владельца по 503](I9_503_OWNER_SIGNOFF.md) · [Манифест](SHA256SUMS)

Оба shakedown окна инструментально прошли. Доли первых своевременных 200 — 50/60 и 49/60. Предложенная цель 98% не подтверждена. Draft PR, синтетический пилот и production — **NO-GO**. Сеанс Mac готов оператору. Ручная приемка 0/48. Исторические 503 UNKNOWN, объяснено 0/2.

## Повтор короткой технической проверки

Понадобятся отдельный чистый checkout B1, Python 3.13 venv с установленными lock‑версиями B1, Node, Playwright и соответствующая ему установленная Chromium-ревизия. На Mac доступен `lsof`. Переменные указывают на существующие локальные компоненты. Каталоги результатов должны быть новыми, лежать вне Git и быть доступны только оператору. Supervisor проверяет SHA и зависимости, занимает свободный loopback, запускает отдельную временную БД и проверяет остановку. Harness не предназначен для рабочего медицинского сервера.

```sh
node browser_p_self_tests.cjs
"$B1_PYTHON" -I -B p_run.py --repo "$B1_CHECKOUT" --out "$PRIVATE_DIR/preflight" --preflight-only
for mode in 4 8; do
  "$B1_PYTHON" -I -B p_run.py --repo "$B1_CHECKOUT" --out "$PRIVATE_DIR/mode-${mode}" \
    --node "$NODE" --playwright "$PLAYWRIGHT_MODULE" --browsers "$PLAYWRIGHT_BROWSERS_PATH" \
    --mode "$mode" --seconds 20 --warmup 4
  node browser_p_audit.cjs "$PRIVATE_DIR/mode-${mode}/driver.json"
done
```

`driver.json` и журналы остаются частными. `public.json` содержит сокращенные агрегаты, которые все равно проверяются перед публикацией. У файлов в опубликованном [P_BROWSER_SHAKEDOWN.json](P_BROWSER_SHAKEDOWN.json) сохранены исходные контрольные суммы для сверки уполномоченным рецензентом. Полный CI и hosted Chromium не перезапускались. Профиль подтверждения и масштаб можно менять только отдельным решением.
