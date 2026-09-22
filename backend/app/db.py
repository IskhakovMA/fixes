"""SQLite storage layer: connection handling, schema init, migrations."""
import hashlib
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from . import config

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_login (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    scope_strategy TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'blocked', 'deactivated')),
    password_hash TEXT NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT,
    password_changed_at TEXT
);

CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_departments (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    department_id TEXT NOT NULL REFERENCES departments(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, department_id)
);

CREATE TABLE IF NOT EXISTS department_heads (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    department_id TEXT NOT NULL REFERENCES departments(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, department_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS patients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    age INTEGER,
    priority TEXT NOT NULL,
    stage TEXT NOT NULL,
    phone TEXT,
    policy_number TEXT,
    complaint TEXT,
    diagnosis TEXT,
    consilium_code TEXT,
    pgi_code TEXT,
    pgi_malignancy_confirmed INTEGER CHECK (
        pgi_malignancy_confirmed IN (0, 1) OR pgi_malignancy_confirmed IS NULL
    ),
    pgi_result_date TEXT,
    nosology TEXT,
    disease_stage TEXT,
    arrival TEXT NOT NULL,
    doctor TEXT,
    head TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    treating_doctor_user_id TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS history_entries (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    stage TEXT NOT NULL,
    entered_at TEXT NOT NULL,
    checklist_json TEXT,
    note TEXT,
    UNIQUE (patient_id, seq)
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    history_entry_id TEXT NOT NULL REFERENCES history_entries(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    date TEXT,
    time TEXT,
    treatment_type TEXT,
    actual_date TEXT,
    actual_time TEXT,
    matched_plan INTEGER,
    no_plan INTEGER NOT NULL DEFAULT 0,
    consilium_decision TEXT CHECK (
        consilium_decision IN ('treatment_strategy_defined', 'treatment_strategy_changed', 'dispensary_observation')
        OR consilium_decision IS NULL
    ),
    set_at TEXT,
    UNIQUE (history_entry_id, seq)
);

CREATE TABLE IF NOT EXISTS patient_diagnosis_history (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    changed_at TEXT NOT NULL,
    actor_user_id TEXT REFERENCES users(id),
    old_diagnosis TEXT,
    new_diagnosis TEXT
);

CREATE TABLE IF NOT EXISTS future_plans (
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    template_index INTEGER NOT NULL,
    date TEXT,
    time TEXT,
    treatment_type TEXT,
    PRIMARY KEY (patient_id, template_index)
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    patient_id TEXT,
    result TEXT NOT NULL,
    request_id TEXT,
    detail TEXT,
    actor_user_id TEXT,
    actor_role TEXT,
    actor_department_id TEXT,
    target_user_id TEXT,
    target_department_id TEXT
);

CREATE TABLE IF NOT EXISTS patient_notification_preferences (
    patient_id TEXT PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
    sms_enabled INTEGER NOT NULL DEFAULT 0 CHECK (sms_enabled IN (0, 1)),
    consent_status TEXT NOT NULL DEFAULT 'not_recorded'
        CHECK (consent_status IN ('not_recorded', 'granted', 'revoked')),
    consent_recorded_at TEXT,
    consent_recorded_by_user_id TEXT REFERENCES users(id),
    consent_revoked_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_templates (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('sms')),
    body TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('sms')),
    template_id TEXT REFERENCES notification_templates(id),
    template_code TEXT NOT NULL,
    template_version INTEGER NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'event')),
    source_id TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled', 'skipped')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    next_attempt_at TEXT,
    processing_started_at TEXT,
    provider_message_id TEXT,
    provider_status TEXT,
    error_code TEXT,
    error_message_safe TEXT,
    created_by_user_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT,
    cancelled_at TEXT,
    cancelled_by_user_id TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS internal_notification_state (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stable_key TEXT NOT NULL,
    patient_id TEXT REFERENCES patients(id) ON DELETE CASCADE,
    notification_type TEXT NOT NULL CHECK (notification_type IN ('overdue', 'today', 'upcoming', 'checklist', 'data_quality', 'attention')),
    source_type TEXT NOT NULL CHECK (source_type IN ('event', 'future_plan', 'checklist', 'data_quality', 'attention')),
    source_id TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    read_at TEXT,
    resolved_at TEXT,
    UNIQUE (user_id, stable_key)
);

CREATE TABLE IF NOT EXISTS patient_attention_issues (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    reason_code TEXT NOT NULL CHECK (reason_code IN (
        'emergency_hospitalization',
        'route_change',
        'critical_overdue',
        'doctor_decision_required',
        'department_head_decision_required',
        'organizational_issue',
        'documents_or_data_issue',
        'patient_unavailable',
        'other'
    )),
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    comment TEXT,
    event_date TEXT,
    created_at TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    closed_at TEXT,
    closed_by_user_id TEXT REFERENCES users(id),
    resolution_comment TEXT,
    CHECK (status = 'open' OR (closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL))
);

"""

# Индексы создаются после миграции: часть из них ссылается на колонки,
# которые в v1-базе появляются только после guarded-ALTER.
INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_history_patient ON history_entries(patient_id);
CREATE INDEX IF NOT EXISTS idx_events_history ON events(history_entry_id);
CREATE INDEX IF NOT EXISTS idx_future_plans_patient ON future_plans(patient_id);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);
CREATE INDEX IF NOT EXISTS idx_patients_policy_number ON patients(policy_number);
CREATE INDEX IF NOT EXISTS idx_diagnosis_history_patient ON patient_diagnosis_history(patient_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_patients_head ON patients(head);
CREATE INDEX IF NOT EXISTS idx_patients_stage ON patients(stage);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_patients_treating_doctor ON patients(treating_doctor_user_id);
CREATE INDEX IF NOT EXISTS idx_user_departments_dept ON user_departments(department_id);
CREATE INDEX IF NOT EXISTS idx_department_heads_dept ON department_heads(department_id);
CREATE INDEX IF NOT EXISTS idx_notification_preferences_status ON patient_notification_preferences(consent_status, sms_enabled);
CREATE INDEX IF NOT EXISTS idx_notification_templates_code ON notification_templates(code);
CREATE INDEX IF NOT EXISTS idx_notifications_status_due ON notifications(status, next_attempt_at, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_patient ON notifications(patient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_source ON notifications(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_notifications_scheduled ON notifications(scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency_key ON notifications(idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency_active
    ON notifications(patient_id, source_type, source_id, template_code, scheduled_at)
    WHERE status IN ('pending', 'processing', 'sent');
CREATE INDEX IF NOT EXISTS idx_internal_notifications_user_active
    ON internal_notification_state(user_id, resolved_at, read_at, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_internal_notifications_patient
    ON internal_notification_state(patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_notifications_user_key
    ON internal_notification_state(user_id, stable_key);
CREATE INDEX IF NOT EXISTS idx_attention_patient_status
    ON patient_attention_issues(patient_id, status);
CREATE INDEX IF NOT EXISTS idx_attention_status
    ON patient_attention_issues(status);
CREATE INDEX IF NOT EXISTS idx_attention_reason
    ON patient_attention_issues(reason_code);
CREATE INDEX IF NOT EXISTS idx_attention_created_at
    ON patient_attention_issues(created_at);
"""

# Роли — справочник, а не бизнес-конфигурация: наполняется всегда.
# scope_strategy — стратегия области видимости пациентов; новые стратегии
# (например stage-based для лекарственной терапии) добавляются сюда и в
# policy.py, не переписывая endpoints.
ROLE_SEED = (
    ("developer", "Разработчик", "global"),
    ("deputy_chief_oncology", "Заместитель главного врача по онкологии", "global_readonly"),
    ("caop_head", "Заведующий ЦАОП", "global_readonly"),
    ("department_head", "Заведующий отделением", "by_department"),
    ("doctor", "Врач", "by_treating_doctor"),
)

REQUIRED_TABLES = (
    "schema_version",
    "app_login",
    "roles",
    "users",
    "departments",
    "user_departments",
    "department_heads",
    "sessions",
    "patients",
    "history_entries",
    "events",
    "patient_diagnosis_history",
    "future_plans",
    "audit_events",
    "patient_notification_preferences",
    "notification_templates",
    "notifications",
    "internal_notification_state",
    "patient_attention_issues",
)

NOTIFICATION_TEMPLATE_SEED = (
    (
        "appointment_reminder",
        "Напоминание о посещении",
        "sms",
        "Напоминаем о запланированном посещении {date} в {time}. Для уточнения информации свяжитесь с организацией.",
    ),
    (
        "examination_reminder",
        "Напоминание о посещении",
        "sms",
        "Напоминаем о запланированном посещении {date} в {time}. Для уточнения информации свяжитесь с организацией.",
    ),
    (
        "custom_reminder",
        "Ручное напоминание",
        "sms",
        "Напоминаем о запланированном посещении {date} в {time}. Для уточнения информации свяжитесь с организацией.",
    ),
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_hardened_paths: set[str] = set()


def _harden_permissions(db_path: Path) -> None:
    """Каталог данных 0700, файл БД 0600 (SQLite создаёт -wal/-shm с правами
    основного файла). Best effort, один раз на путь в процессе: не зависит
    от umask сервиса и чинит права существующей установки при старте."""
    key = str(db_path)
    if key in _hardened_paths:
        return
    db_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not db_path.exists():
        os.close(os.open(str(db_path), os.O_CREAT | os.O_WRONLY, 0o600))
    for path, mode in ((db_path.parent, 0o700), (db_path, 0o600),
                       (db_path.with_name(db_path.name + "-wal"), 0o600),
                       (db_path.with_name(db_path.name + "-shm"), 0o600)):
        try:
            if path.exists():
                path.chmod(mode)
        except (OSError, NotImplementedError):
            pass
    _hardened_paths.add(key)


def _connect(db_path: Path) -> sqlite3.Connection:
    _harden_permissions(db_path)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    # Wait instead of failing immediately when another writer (a CLI backup,
    # a second uvicorn worker) briefly holds the write lock.
    conn.execute(f"PRAGMA busy_timeout = {config.BUSY_TIMEOUT_MS}")
    return conn


def connect_readonly_check(db_path: Path) -> sqlite3.Connection:
    """Plain connection for integrity tooling — no schema creation side effects."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    existing = _table_columns(conn, table)
    if not existing:
        return  # таблицы ещё нет — её создаст SCHEMA_SQL сразу в новой форме
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def _seed_roles(conn: sqlite3.Connection) -> None:
    conn.executemany(
        "INSERT OR IGNORE INTO roles (id, label, scope_strategy) VALUES (?, ?, ?)", ROLE_SEED
    )


def _seed_notification_templates(conn: sqlite3.Connection) -> None:
    now = now_iso()
    for code, name, channel, body in NOTIFICATION_TEMPLATE_SEED:
        conn.execute(
            """INSERT OR IGNORE INTO notification_templates
               (id, code, name, channel, body, enabled, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)""",
            (f"tpl_{code}", code, name, channel, body, now, now),
        )


def _notification_idempotency_key(
    patient_id: str, source_type: str, source_id: str, template_code: str, scheduled_at: str
) -> str:
    raw = "\x1f".join((patient_id, source_type, source_id, template_code, scheduled_at))
    return "notif_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _ensure_notification_schema(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "notifications")
    if not columns:
        return
    if "idempotency_key" not in columns:
        conn.execute("ALTER TABLE notifications ADD COLUMN idempotency_key TEXT")
    if "processing_started_at" not in columns:
        conn.execute("ALTER TABLE notifications ADD COLUMN processing_started_at TEXT")
    rows = conn.execute(
        """SELECT id, patient_id, source_type, source_id, template_code, scheduled_at
           FROM notifications
           WHERE idempotency_key IS NULL OR idempotency_key = ''"""
    ).fetchall()
    used = {
        row["idempotency_key"]
        for row in conn.execute(
            "SELECT idempotency_key FROM notifications WHERE idempotency_key IS NOT NULL AND idempotency_key != ''"
        ).fetchall()
    }
    for row in rows:
        key = _notification_idempotency_key(
            row["patient_id"], row["source_type"], row["source_id"], row["template_code"], row["scheduled_at"]
        )
        if key in used:
            key = f"{key}:legacy:{row['id']}"
        used.add(key)
        conn.execute("UPDATE notifications SET idempotency_key = ? WHERE id = ?", (key, row["id"]))


def migrate_v1_to_v2(conn: sqlite3.Connection) -> None:
    """v1 → v2: RBAC-таблицы и связи. Безопасна для повторного запуска.

    Данные пациентов не трогаются: legacy-текст `doctor` сохраняется как есть,
    новая связь `treating_doctor_user_id` появляется пустой (unresolved) и
    заполняется только вручную Разработчиком. Сессии старой (общей) модели
    входа не переносимы на персональные учётные записи и удаляются.
    """
    _add_column_if_missing(conn, "sessions", "user_id",
                           "user_id TEXT REFERENCES users(id) ON DELETE CASCADE")
    _add_column_if_missing(conn, "patients", "treating_doctor_user_id",
                           "treating_doctor_user_id TEXT REFERENCES users(id)")
    for col in ("actor_user_id", "actor_role", "actor_department_id",
                "target_user_id", "target_department_id"):
        _add_column_if_missing(conn, "audit_events", col, f"{col} TEXT")
    # Сессии без user_id принадлежат снятой с эксплуатации общей модели входа.
    if "user_id" in _table_columns(conn, "sessions"):
        conn.execute("DELETE FROM sessions WHERE user_id IS NULL")


def migrate_v2_to_v3(conn: sqlite3.Connection) -> None:
    """v2 → v3: notification preferences, safe templates and queue.

    Patient records, users, departments and audit rows are not modified. Consent
    starts as `not_recorded`; phone presence is deliberately not interpreted as
    permission to send SMS.
    """
    conn.executescript(SCHEMA_SQL)
    _ensure_notification_schema(conn)
    _seed_notification_templates(conn)


def migrate_v3_to_v4(conn: sqlite3.Connection) -> None:
    """v3 → v4: nullable OMS policy number on patient cards."""
    _add_column_if_missing(conn, "patients", "policy_number", "policy_number TEXT")


def migrate_v4_to_v5(conn: sqlite3.Connection) -> None:
    """v4 → v5: read-state for computed internal notification conditions."""
    conn.executescript(SCHEMA_SQL)


def _rebuild_internal_notification_state_v6(conn: sqlite3.Connection) -> None:
    if "internal_notification_state" not in {
        row["name"] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    }:
        return
    columns = _table_columns(conn, "internal_notification_state")
    if not columns:
        return
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS internal_notification_state_v6 (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            stable_key TEXT NOT NULL,
            patient_id TEXT REFERENCES patients(id) ON DELETE CASCADE,
            notification_type TEXT NOT NULL CHECK (notification_type IN ('overdue', 'today', 'upcoming', 'checklist', 'data_quality', 'attention')),
            source_type TEXT NOT NULL CHECK (source_type IN ('event', 'future_plan', 'checklist', 'data_quality', 'attention')),
            source_id TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            read_at TEXT,
            resolved_at TEXT,
            UNIQUE (user_id, stable_key)
        );
        INSERT OR IGNORE INTO internal_notification_state_v6
            (id, user_id, stable_key, patient_id, notification_type, source_type, source_id,
             first_seen_at, last_seen_at, read_at, resolved_at)
        SELECT id, user_id, stable_key, patient_id, notification_type, source_type, source_id,
               first_seen_at, last_seen_at, read_at, resolved_at
        FROM internal_notification_state;
        DROP TABLE internal_notification_state;
        ALTER TABLE internal_notification_state_v6 RENAME TO internal_notification_state;
        """
    )


def migrate_v5_to_v6(conn: sqlite3.Connection) -> None:
    """v5 → v6: patient attention issues and attention notification type."""
    _rebuild_internal_notification_state_v6(conn)
    conn.executescript(SCHEMA_SQL)


def migrate_v6_to_v7(conn: sqlite3.Connection) -> None:
    """v6 → v7: doctor feedback optional patient codes and diagnosis history."""
    _add_column_if_missing(conn, "patients", "consilium_code", "consilium_code TEXT")
    _add_column_if_missing(conn, "patients", "pgi_code", "pgi_code TEXT")
    conn.executescript(SCHEMA_SQL)


def migrate_v7_to_v8(conn: sqlite3.Connection) -> None:
    """v7 → v8: structured OK decision and PGI result.

    Legacy free-text `consilium_code`/`pgi_code` are preserved as deprecated
    compatibility columns; no automatic conversion is attempted.
    """
    _add_column_if_missing(
        conn,
        "patients",
        "pgi_malignancy_confirmed",
        "pgi_malignancy_confirmed INTEGER CHECK (pgi_malignancy_confirmed IN (0, 1) OR pgi_malignancy_confirmed IS NULL)",
    )
    _add_column_if_missing(
        conn,
        "events",
        "consilium_decision",
        "consilium_decision TEXT CHECK (consilium_decision IN ('treatment_strategy_defined', 'treatment_strategy_changed', 'dispensary_observation') OR consilium_decision IS NULL)",
    )
    conn.executescript(SCHEMA_SQL)


def migrate_v8_to_v9(conn: sqlite3.Connection) -> None:
    """v8 → v9: PGI result date and retired active disease/future-plan fields.

    Existing disease_stage and future_plans storage is intentionally left in
    place as deprecated compatibility storage; active API/UI no longer reads
    or writes it. Existing PGI rows receive NULL date, never an invented date.
    """
    _add_column_if_missing(conn, "patients", "pgi_result_date", "pgi_result_date TEXT")
    conn.executescript(SCHEMA_SQL)


def init_db(conn: sqlite3.Connection) -> None:
    """Idempotent schema creation + migration. Safe on an empty DB
    and safe to call repeatedly (CREATE TABLE IF NOT EXISTS + guarded ALTERs).

    Порядок важен: сначала ALTER-ы существующих v1-таблиц (иначе индексы по
    новым колонкам из SCHEMA_SQL не создадутся), затем создание недостающих
    таблиц и индексов."""
    with conn:
        conn.executescript(SCHEMA_SQL)   # создаёт недостающие таблицы (IF NOT EXISTS)
        migrate_v1_to_v2(conn)           # добавляет новые колонки в v1-таблицы
        migrate_v3_to_v4(conn)           # добавляет nullable policy_number в существующие БД
        migrate_v4_to_v5(conn)           # создаёт read-state для внутреннего центра уведомлений
        migrate_v6_to_v7(conn)           # nullable doctor feedback columns/table
        migrate_v7_to_v8(conn)           # structured OK/PGI physician clarifications
        migrate_v8_to_v9(conn)           # PGI date + retired active fields
        _ensure_notification_schema(conn)
        conn.executescript(INDEX_SQL)    # индексы — когда все колонки уже есть
        _seed_roles(conn)
        _seed_notification_templates(conn)
        row = conn.execute("SELECT version FROM schema_version").fetchone()
        if row is None:
            conn.execute("INSERT INTO schema_version (version) VALUES (?)", (config.SCHEMA_VERSION,))
        elif row["version"] == 1:
            conn.execute("UPDATE schema_version SET version = ?", (config.SCHEMA_VERSION,))
        elif row["version"] == 2:
            migrate_v2_to_v3(conn)
            migrate_v3_to_v4(conn)
            conn.execute("UPDATE schema_version SET version = ?", (config.SCHEMA_VERSION,))
        elif row["version"] == 3:
            migrate_v3_to_v4(conn)
            migrate_v4_to_v5(conn)
            conn.execute("UPDATE schema_version SET version = ?", (config.SCHEMA_VERSION,))
        elif row["version"] == 4:
            migrate_v4_to_v5(conn)
            migrate_v5_to_v6(conn)
            conn.execute("UPDATE schema_version SET version = ?", (config.SCHEMA_VERSION,))
        elif row["version"] == 5:
            migrate_v5_to_v6(conn)
            migrate_v6_to_v7(conn)
            migrate_v7_to_v8(conn)
            conn.execute("UPDATE schema_version SET version = ?", (config.SCHEMA_VERSION,))
        elif row["version"] == 6:
            migrate_v6_to_v7(conn)
            migrate_v7_to_v8(conn)
            conn.execute("UPDATE schema_version SET version = ?", (config.SCHEMA_VERSION,))
        elif row["version"] == 7:
            migrate_v7_to_v8(conn)
            migrate_v8_to_v9(conn)
            conn.execute("UPDATE schema_version SET version = ?", (config.SCHEMA_VERSION,))
        elif row["version"] == 8:
            migrate_v8_to_v9(conn)
            conn.execute("UPDATE schema_version SET version = ?", (config.SCHEMA_VERSION,))
        elif row["version"] < config.SCHEMA_VERSION:
            conn.execute("UPDATE schema_version SET version = ?", (config.SCHEMA_VERSION,))


_singleton_conn: sqlite3.Connection | None = None


def get_connection() -> sqlite3.Connection:
    """Process-wide connection to the configured DB path (used by the app).
    Tests should build their own via `_connect` + `init_db` against a temp path."""
    global _singleton_conn
    if _singleton_conn is None:
        _singleton_conn = _connect(config.DB_PATH)
        init_db(_singleton_conn)
    return _singleton_conn


def reset_singleton_for_tests() -> None:
    global _singleton_conn
    if _singleton_conn is not None:
        _singleton_conn.close()
    _singleton_conn = None


@contextmanager
def transaction(conn: sqlite3.Connection):
    """Explicit transaction boundary for multi-statement writes (import etc.)."""
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
