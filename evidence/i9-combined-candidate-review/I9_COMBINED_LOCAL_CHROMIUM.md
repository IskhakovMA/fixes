# Локальная проверка Chromium объединенного кандидата

Продуктовый commit — `b5b408fe411f4431042eced96f0801cffb577a83`, дерево — `cd00d4d55140d377038783234cc204c602741869`. Все проверки работали против настоящего FastAPI и временной синтетической SQLite на loopback. Рабочее дерево было чистым до и после запуска. Chromium 151.0.7922.34. [Машинная квитанция](I9_COMBINED_LOCAL_CHROMIUM.json)

| Проверка | Результат |
|---|---|
| Focus | 14/14, одинаковые с focus-only статусы, число запросов, фокус, озвучиваемое описание ошибки, состояние скрытой таблицы, итоговый view и session epoch |
| Нативный Chromium zoom | 6/6 при 100%, 200% и 400% в обеих темах, без нарушений axe A/AA |
| Постоянный History | 7/7 адресно запущенных сценариев, 16 групп и 8 состояний axe; тест выполнен из файла кандидата без overlay |
| Quality | 9 групп отказов и 5 групп функциональных проверок; реальная смена пользователя между вкладками, отзыв владельца с 404 и очисткой карточки и черновика, 401, смена контекста и поздний старый ответ |

Одиночный конфликт выполнил 409→200 и передал фокус статусу страницы. Двойной конфликт выполнил ровно два GET 409, скрыл устаревшую таблицу и поместил фокус на явную кнопку обновления. Tab и Shift+Tab не отправили дополнительных GET. При явном Enter получили 200. Медицинских записей от клавиатурного восстановления не было. Покрыты реальный выход с 401, повторный вход и новая пагинация, модальное окно и Escape, навигация во время запроса, Back/Forward, задержанный 200 и сознательный перенос фокуса. Транспортные проверки 401, 409 смены контекста, истекшего курсора 410 и тайм-аута идут отдельными сценариями от реальных отказов.

Первый локальный процесс focus завершился до запуска Chromium: из очищенного окружения со временным HOME была исключена переменная `PLAYWRIGHT_BROWSERS_PATH`. После ее явной передачи в allowlist повторен только этот процесс. Приложение и assertions не менялись. Прочие процессы завершились с кодом 0.

## Воспроизведение

1. Подготовить чистый checkout точного SHA, locked Python 3.13 venv, Playwright 1.62.1, axe-core 4.11.0 и соответствующие установленные Chromium binaries. Учесть `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_BROWSERS_PATH`, `AXE_SOURCE` и `WP_H_FULL_CHROMIUM`, для фокусного запуска передать путь установленного headless Chromium через `BROWSER_EXECUTABLE` либо явно пропустить `PLAYWRIGHT_BROWSERS_PATH` в окружение запускаемого Node. Артефакты держать в новом частном каталоге вне Git.
2. Использовать опубликованные браузерные harness для focus и native zoom. Во внешних Python-launcher проверить clean HEAD на `b5b408fe411f4431042eced96f0801cffb577a83` и `HEAD^{tree}` на `cd00d4d55140d377038783234cc204c602741869` вместо условий старого focus-only и грязного B1. JavaScript тесты неизменны. Для focus передать `FOCUS_CASES=single:1440:light,double:1440:light,double:390:dark,move-focus:1440:light,move-back:1440:light,modal:1440:light,navigate:1440:light,stale-200:1440:light,401:1440:light,context:1440:light,network:1440:light,cursor:1440:light,repeat-enter:1440:light,real-401:1440:light`. [Focus harness](https://github.com/IskhakovMA/fixes/tree/815f0844c743bf34ea1676d0c4611c8a08b2d83b/evidence/i9-p-recovery-focus/browser) · [Native zoom harness](https://github.com/IskhakovMA/fixes/tree/815f0844c743bf34ea1676d0c4611c8a08b2d83b/evidence/i9-p-recovery-focus/native-zoom)
3. Для каждого из семи имен из квитанции вызвать `HISTORY_SCENARIO="$case" python -B tools/tests/wp_i_card/run.py --suite history --out "$PRIVATE_DIR/history-$case"` из checkout. Quality — `python -B tools/tests/wp_i_quality/run_browser.py --out "$PRIVATE_DIR/quality" --count 240`. Не заменять файлы кандидата.
4. Для каждой квитанции проверить статус, суммы SHA‑256 и отсутствие приватных данных перед публикацией. Локальная матрица отличается от отдельного обязательного hosted Chromium и не закрывает ручную D8.
