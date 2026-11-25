# Воспроизведение на принятом SHA

Все команды выполняются на чистом временном detached worktree `f849b2909c2d23923e0ce996f0aca4b670ca9c18`. Нужны Python 3.13 из venv с prod/dev lock и Node 22.23.4. Для Chromium используйте `tools/tests/wp_h/package-lock.json` с `npm ci --ignore-scripts`, Chromium revision 1234 / 151.0.7922.34, Playwright 1.62.1, axe 4.11.0. Укажите абсолютные `PLAYWRIGHT_MODULE`, `AXE_SOURCE`, `PLAYWRIGHT_BROWSERS_PATH`, `BROWSER_EXECUTABLE`. Для всех браузерных запусков backend стартует на новой синтетической БД.

```bash
test "$(git rev-parse HEAD)" = f849b2909c2d23923e0ce996f0aca4b670ca9c18
export PYTHONDONTWRITEBYTECODE=1
python -m pip install --require-hashes -r backend/requirements-dev.txt
python -m pip check

# PACK / TMP — абсолютные пути к пакету и отдельной папке результатов.
python -I -B "$PACK/stand/verify-d8-mac.py" "$PWD"
PYTHONPATH="$PWD" I9_SERIALIZATION_RECEIPT="$TMP/serialization.jsonl" \
  python -B -m pytest -q -p no:cacheprovider -p backend.tests.conftest \
  --basetemp "$TMP/serialization-db" "$PACK/probes/test_i9_serialization.py"

python -B tools/tests/wp_i_card/run.py --suite errors --count 100 --out "$TMP/card"
python -B tools/tests/wp_h/run.py drafts --out "$TMP/drafts"
python -B tools/tests/wp_i_quality/run_browser.py --suite browser --count 240 --out "$TMP/quality"
python -B tools/tests/wp_i_card/run.py --suite clinical --count 100 --out "$TMP/clinical"
NODE_OPTIONS="--require=$PACK/probes/precommit-network-control.cjs" \
  python -B tools/tests/wp_i_card/run.py --suite clinical --count 100 --out "$TMP/network"
python -B tools/tests/wp_i_card/run.py --suite history --count 100 --out "$TMP/history"
HISTORY_SCENARIO=transportAndIdentity NODE_OPTIONS="--require=$PACK/probes/history-idle-observer.cjs" \
  python -B tools/tests/wp_i_card/run.py --suite history --count 100 --out "$TMP/history-observed"
```

Оригинальные тестовые случаи для серий E приведены в `evidence/BACKEND_RESULTS.json`. Преобразуйте части имени до `::` из dotted Python module в путь к файлу `.py`. Передайте каждый полученный node ID отдельным аргументом pytest. Обезличенный наблюдатель `probes/i9_503_receipts.py` подключается через `PYTHONPATH="$PACK/probes:$PWD"`, `I9_RECEIPTS="$TMP/faults.jsonl"`, `-p i9_503_receipts`. Используйте отдельные `--basetemp` для серий. Серии 118 и 13 имеют 11 общих случаев.

Не копируйте выходные каталоги браузера и pytest целиком. В пакет вошли только явно отобранные квитанции с результатом, статусом и счетчиками без содержимого карточек, технических секретов и токенов.
