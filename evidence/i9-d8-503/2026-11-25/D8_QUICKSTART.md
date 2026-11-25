# D8 — короткий запуск

Команды выполняйте в свежей рабочей копии ветки evidence, начиная с корня репозитория. Выделенный экземпляр приложения использует только точный интеграционный SHA ниже и новую синтетическую SQLite. Доступ к рабочей установке не нужен.

```bash
set -euo pipefail
BASE=f849b2909c2d23923e0ce996f0aca4b670ca9c18
EVIDENCE="$(cd evidence/i9-d8-503/2026-11-25 && pwd -P)"
START_DIR="$PWD"
SCRATCH="$(mktemp -d)"
git worktree add --detach "$SCRATCH/app" "$BASE"
test "$(git -C "$SCRATCH/app" rev-parse HEAD)" = "$BASE" || exit 1
test -z "$(git -C "$SCRATCH/app" status --porcelain)" || exit 1
python3.13 -m venv "$SCRATCH/venv"
"$SCRATCH/venv/bin/python" -m pip install --require-hashes -r "$SCRATCH/app/backend/requirements-dev.txt"
"$SCRATCH/venv/bin/python" -m pip check
cd "$EVIDENCE"
rc=0
bash stand/launch-d8.sh "$SCRATCH/app" "$SCRATCH/venv/bin/python" 18889 || rc=$?
case "$rc" in
  0|130) ;;
  *) printf 'D8 launcher returned %s\n' "$rc" >&2 ;;
esac
```

В другом терминале запустите `curl --noproxy '*' -fsS http://127.0.0.1:18889/healthz`. Проверяйте в браузере только `http://127.0.0.1:18889/`. Учетные данные синтетической фикстуры принадлежат временной сессии. Launcher печатает путь к файлу с режимом 0600. Значения из него читайте только локально и не включайте в квитанции.

Для Safari/VoiceOver используйте [полный сценарный runbook](I9_D8_MAC_OPERATOR_GUIDE.md). Для Windows и физического устройства есть [инструкции Windows](I9_D8_WINDOWS_OPERATOR_GUIDE.md) и [mobile](I9_D8_MOBILE_OPERATOR_GUIDE.md). Базовые 48 строк находятся в [реестре D8](I9_D8_RECEIPTS.tsv). Локальный стенд остановлен после проверки.

Завершите launcher через Ctrl+C. Его одноразовая медицинская фикстура и SQLite удаляются автоматически. Если работа со стендом окончена, из того же терминала выполните `git -C "$START_DIR" worktree remove "$SCRATCH/app"`. Окружение venv вне Git можно удалить отдельно после проверки используемого пути. Windows запускается из собственного WSL2 на 18890 после подтверждения Windows loopback. Мобильный профиль ожидает отдельно согласованного подключения.
