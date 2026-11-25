"""Diagnostic wrappers around native timings; no application policy changes."""
from functools import wraps
import time


def instrument(active, db, read_access):
    from backend.app import quality_revision

    def measured(label, original):
        @wraps(original)
        def timed(*args, **kwargs):
            sample = active.get()
            if sample is None:
                return original(*args, **kwargs)
            started = time.perf_counter_ns()
            cpu = time.thread_time_ns()
            try:
                return original(*args, **kwargs)
            finally:
                elapsed_cpu = time.thread_time_ns() - cpu
                elapsed_wall = time.perf_counter_ns() - started
                record = sample.setdefault('phase_timing', {}).setdefault(label, {'wall_ns': [], 'cpu_ns': []})
                record['wall_ns'].append(elapsed_wall)
                record['cpu_ns'].append(elapsed_cpu)
        return timed

    for module, names in (
        (db, ('init_db', 'connect_live', 'connect_release', 'require_release_admission', '_release_catalog')),
        (quality_revision, ('require_valid',)),
        (read_access, ('_persist',)),
    ):
        for name in names:
            original = getattr(module, name, None)
            if original is not None:
                setattr(module, name, measured(name, original))

    original_execute = db._i9_native_execute
    measure_catalog = measured('sqlite_catalog_execute', original_execute)

    def execute(conn, sql, parameters):
        command = sql.upper()
        if ('SQLITE_SCHEMA' in command or 'SQLITE_MASTER' in command) and command.lstrip().startswith(('SELECT ', 'WITH ')):
            return measure_catalog(conn, sql, parameters)
        return original_execute(conn, sql, parameters)

    db._i9_native_execute = execute
    lock = getattr(read_access, '_release_order', None)
    if lock is None:
        return

    class MeasuredLock:
        def __enter__(self):
            sample = active.get()
            started = time.perf_counter_ns()
            result = lock.__enter__()
            if sample is not None:
                acquired = time.perf_counter_ns()
                sample.setdefault('release_order_ns', []).append({'wait': acquired - started, 'acquired': acquired})
            return result

        def __exit__(self, *args):
            sample = active.get()
            try:
                return lock.__exit__(*args)
            finally:
                if sample is not None and sample.get('release_order_ns'):
                    row = sample['release_order_ns'][-1]
                    row['hold'] = time.perf_counter_ns() - row.pop('acquired')
    read_access._release_order = MeasuredLock()
