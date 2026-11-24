# Clinic Tracker — дополнение к приемке I-9 по PR №9

24 ноября 2026 г. **Quality native zoom интегрирован. Приемка I-9 остается открытой.**

## Ревью и Git

[Независимое ревью 6043151854](https://github.com/IskhakovMA/fixes/pull/9#pullrequestreview-6043151854) относится к точному HEAD PR и содержит вердикт 9,5/10, принято к интеграции без блокирующих замечаний. GitHub сохранил ревью со статусом `COMMENTED`. При повторной проверке открытых веток обсуждения, inline-комментариев и дополнительных комментариев не было. У PR подтвержден переход из Draft в Ready for Review. GitHub API принял обычный merge с проверкой ожидаемого HEAD, после повторного чтения SHA целевой ветки.

| Git | SHA |
| --- | --- |
| Целевая ветка | `fix/wp-i-redesign-integration` |
| Merge commit | `20aa7ae3431a29ae08016cbc660400fb700b935a` |
| Первый родитель, принятая база | `a86a9680f88aa89e9d661095a30564f50afe23ba` |
| Второй родитель, принятый HEAD PR | `387318db8f466f0221bc146acb23461d443efbd2` |
| Git-дерево merge и принятого HEAD | `64dc9139595620cee241ee8d485d37ebb528576e` |

Локальный Git и GitHub API подтвердили одинаковое дерево и diff к базе из двух файлов: `tools/tests/wp_i_quality/browser_zoom.cjs` и `tools/tests/wp_i_quality/run_browser.py`. Состав merge сверили четыре независимых направления: Git и review threads, CI, безопасность синтетического стенда и интеграционный diff. [PR №9](https://github.com/IskhakovMA/fixes/pull/9) · [Merge commit](https://github.com/IskhakovMA/fixes/commit/20aa7ae3431a29ae08016cbc660400fb700b935a)

## Приемочные результаты

- **Исторический FAIL сохранен.** Исходный `quality-browser_zoom FAIL 1`. Контролируемое воспроизведение вернуло тот же exit 1. Chromium прервался с SIGABRT в `launchPersistentContext` после сообщения `Socket path too long` для пути к `SingletonSocket`. [Исходный FAIL](https://github.com/IskhakovMA/fixes/actions/runs/45394069815/job/138445065148) · [Воспроизведение](https://github.com/IskhakovMA/fixes/actions/runs/45429710744) · [Артефакт](https://github.com/IskhakovMA/fixes/actions/runs/45429710744/artifacts/14936929309)
- **Исправление тестового runner PASS.** Короткий TMPDIR только для Linux `browser_zoom`. Подтверждающий прогон с длинным каталогом вывода прошел с прежними и расширенными утверждениями. [Подтверждение](https://github.com/IskhakovMA/fixes/actions/runs/45430378780) · [Артефакт](https://github.com/IskhakovMA/fixes/actions/runs/45430378780/artifacts/14939276741)
- **Native zoom на HEAD PR PASS.** На Linux Chromium в шести сочетаниях двух тем и масштаба 100/200/400% подтверждены геометрия, 50 доступных имен, 50 переходов в каждом направлении реальными Tab и Shift+Tab и ноль нарушений axe A/AA. Дерево merge совпадает с деревом этого прогона. [Прогон точного HEAD](https://github.com/IskhakovMA/fixes/actions/runs/45432178099) · [Артефакт](https://github.com/IskhakovMA/fixes/actions/runs/45432178099/artifacts/14939512805)
- **Полный CI на HEAD PR PASS.** 15/15 jobs, 2821/2821 backend exact-once, release-gate PASS. [Прогон HEAD PR](https://github.com/IskhakovMA/fixes/actions/runs/45432093528)
- **Отдельный CI на merge SHA PASS.** 15/15 jobs, 2821/2821 backend exact-once, release-gate PASS. [Push-прогон](https://github.com/IskhakovMA/fixes/actions/runs/45437079931) · [Backend verifier](https://github.com/IskhakovMA/fixes/actions/runs/45437079931/job/138608622314) · [Release gate](https://github.com/IskhakovMA/fixes/actions/runs/45437079931/job/138608702084)

Три подготовленных GitHub ZIP проверены по SHA-256 и CRC. Их байты включены в итоговый архив вместе с этим дополнением, структурированной квитанцией и манифестом. Диагностические журналы предназначены для синтетического теста. В доказательства не включены БД, профиль Chromium, fixture или секреты.

## Открыто по I-9

- **Back/Forward** согласно ADR. Следующая отдельная задача.
- **Ручная D8** на Safari/VoiceOver и Firefox/NVDA.
- **Performance**. Профиль нагрузки и пороги еще требуют утверждения.
- **Два исторических HTTP 503 без прикладного кода** остаются известным отдельным риском.

Публичный Quality v1 закрыт. В пределах интеграции изменен только тестовый harness. Ветка `main` осталась на `20a7505d8ba0302f298f3d6998bb0fa20d0278e9`, ветка кандидата I-9 на `72dad18c11feb8d9d8b62b702b05f54ed7ffad1d`. Производственная среда, `clinic_tracker_new`, SQLite v33 и рабочая медицинская база не затрагивались. WP-J остается отдельным этапом.
