#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "$#" -ne 3 ] || [ "${1:0:1}" != "/" ] || [ "${2:0:1}" != "/" ]; then
    printf '%s\n' 'Usage: launch-d8.sh /absolute/exact-worktree /absolute/pinned-venv/bin/python PORT' >&2
    exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$2" -I -B "$script_dir/d8_stand.py" "$1" "$3"
