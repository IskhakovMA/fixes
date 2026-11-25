"""Bounded synthetic telemetry. Values, identifiers, SQL and fingerprints stay local."""

from contextlib import contextmanager
from functools import wraps
import time


CLOCK = time.perf_counter_ns


def _stage_result(exception, *, page, session):
    if isinstance(exception, page.QueryChanged):
        return 'query_changed'
    if isinstance(exception, session.ContextChanged):
        return 'access_context_changed'
    if getattr(exception, 'status_code', None) == 401:
        return 'unauthenticated'
    return 'other_error'


def install(active, release_phase, db, read_access, page):
    from backend.app import session_context, store
    from fastapi import routing

    get_stage = lambda: 'validation' if release_phase.get() else 'original'
    snapshot = page.snapshot

    @contextmanager
    def measured_snapshot(conn):
        sample = active.get()
        if sample is None:
            with snapshot(conn):
                yield
            return
        entry = {'phase': get_stage(), 'enter_ns': CLOCK()}
        sample.setdefault('read_snapshots', []).append(entry)
        sample['_current_snapshot'] = entry
        try:
            with snapshot(conn):
                entry['begin_done_ns'] = CLOCK()
                yield
        finally:
            entry['end_ns'] = CLOCK()
            sample.pop('_current_snapshot', None)

    page.snapshot = measured_snapshot

    def observed_phase(owner, name, receipt_key):
        original = getattr(owner, name)

        @wraps(original)
        def measured(*args, **kwargs):
            sample = active.get()
            if sample is None:
                return original(*args, **kwargs)
            entry = {'start_ns': CLOCK()}
            if receipt_key == 'fresh_reader':
                entry['under_writer'] = bool(getattr(args[0], 'i9_window', None))
            sample.setdefault(receipt_key, []).append(entry)
            cpu_started = time.thread_time_ns()
            try:
                result = original(*args, **kwargs)
            except Exception as error:
                entry['outcome'] = _stage_result(error, page=page, session=session_context)
                raise
            else:
                entry['outcome'] = 'ok'
                return result
            finally:
                entry['end_ns'] = CLOCK()
                entry['thread_cpu_ns'] = time.thread_time_ns() - cpu_started

        setattr(owner, name, measured)

    compute_fingerprint = page._page_fingerprint

    @wraps(compute_fingerprint)
    def measured_fingerprint(*args, **kwargs):
        sample = active.get()
        if sample is None:
            return compute_fingerprint(*args, **kwargs)
        event = {'phase': get_stage(), 'start_ns': CLOCK()}
        sample.setdefault('fingerprint_build', []).append(event)
        try:
            return compute_fingerprint(*args, **kwargs)
        finally:
            event['end_ns'] = CLOCK()

    page._page_fingerprint = measured_fingerprint
    observed_phase(read_access, '_fresh_reader', 'fresh_reader')
    observed_phase(read_access, '_persist', 'release_persist')
    observed_phase(store, 'update_patient_field_with_actor', 'clinical_store')
    observed_phase(store, 'patient_to_dict', 'result_projection')

    original_threadpool = routing.run_in_threadpool

    async def threadpool(func, *args, **kwargs):
        sample = active.get()
        if sample is None or not sample.get('clinical') or getattr(func, '__name__', None) != 'update_patient_field':
            return await original_threadpool(func, *args, **kwargs)
        spans = sample['patch_endpoint_worker'] = {'queued_ns': CLOCK()}

        @wraps(func)
        def run(*inner_args, **inner_kwargs):
            cpu_started = time.thread_time_ns()
            spans['started_ns'] = CLOCK()
            try:
                return func(*inner_args, **inner_kwargs)
            finally:
                spans['ended_ns'] = CLOCK()
                spans['thread_cpu_ns'] = time.thread_time_ns() - cpu_started

        try:
            return await original_threadpool(run, *args, **kwargs)
        finally:
            spans['returned_ns'] = CLOCK()

    routing.run_in_threadpool = threadpool

    original_execute = db._i9_native_execute

    def measured_execute(conn, sql, params):
        sample = active.get()
        if sample is None:
            return original_execute(conn, sql, params)
        command = sql.lstrip().upper()
        if release_phase.get() and command == 'PRAGMA DATA_VERSION':
            # Production calls fetchone immediately. The wrapper does not consume
            # or duplicate the data_version sample or modify the returned row.
            entry = {'start_ns': CLOCK(), 'under_writer': bool(getattr(conn, 'i9_window', None))}
            all_links = sample.setdefault('_release_version_connections', [])
            all_links.append(conn)
            entry['connection_ordinal'] = next(index for index, link in enumerate(all_links) if link is conn)
            sample.setdefault('release_versions', []).append(entry)
            cursor = original_execute(conn, sql, params)

            class ObservedVersion:
                def fetchone(self):
                    row = cursor.fetchone()
                    entry.update(end_ns=CLOCK(), value=int(row[0]))
                    return row

            return ObservedVersion()
        snapshot_entry = sample.get('_current_snapshot')
        if snapshot_entry is not None and command.startswith(('SELECT ', 'WITH ')) and 'first_read_start_ns' not in snapshot_entry:
            snapshot_entry['first_read_start_ns'] = CLOCK()
            try:
                return original_execute(conn, sql, params)
            finally:
                snapshot_entry['first_read_execute_done_ns'] = CLOCK()
        if command.startswith(('INSERT INTO AUDIT_EVENTS ', 'INSERT INTO READ_ACCESS_MANIFESTS ')):
            window = getattr(conn, 'i9_window', None)
            if window is not None:
                before = conn.total_changes
                cursor = original_execute(conn, sql, params)
                delta = conn.total_changes - before
                if command.startswith('INSERT INTO READ_ACCESS_MANIFESTS '):
                    window['manifest_rows_changed'] = window.get('manifest_rows_changed', 0) + delta
                else:
                    if len(params) > 1 and params[1] == 'medical_read_release':
                        window['read_audit_rows_changed'] = window.get('read_audit_rows_changed', 0) + delta
                    if len(params) > 1 and params[1] == 'patient_updated' and window['kind'] == 'clinical_write':
                        sample.setdefault('private_patch_audit_rowids', []).append(cursor.lastrowid)
                return cursor
        if (not getattr(conn, 'i9_window', None)
                and command.startswith(('INSERT ', 'UPDATE ', 'DELETE ', 'REPLACE ', 'CREATE ', 'ALTER ', 'DROP '))):
            before = conn.total_changes
            started = CLOCK()
            cursor = original_execute(conn, sql, params)
            if conn.total_changes != before or command.startswith(('CREATE ', 'ALTER ', 'DROP ')):
                sample.setdefault('other_write_evidence', []).append(
                    {'start_ns': started, 'end_ns': CLOCK(), 'pending_transaction': conn.in_transaction})
            return cursor
        return original_execute(conn, sql, params)

    db._i9_native_execute = measured_execute


def classify_conflicts(events):
    """Bounded attribution under the synthetic harness's closed world."""
    commits = []
    for event in events:
        for other in event.get('other_write_evidence', ()):
            # An implicit transaction has no precise observed commit boundary.
            # Use its full uncertainty envelope to prevent audit-only attribution.
            end_ns = event.get('asgi_end_ns', other['end_ns']) if other['pending_transaction'] else other['end_ns']
            commits.append({'start_ns': other['start_ns'], 'end_ns': end_ns,
                            'event': event['event'], 'kind': 'other_write'})
        for txn in event.get('native', ()):
            if txn.get('end') != 'COMMIT' or 'commit_started_ns' not in txn or 'finished_ns' not in txn:
                continue
            if txn.get('affected_rows') == 0:
                continue
            kind = 'other_write'
            if txn['kind'] == 'clinical_write' and event.get('clinical_audit_commit_verified') is True:
                kind = 'medical'
            elif (txn['kind'] == 'release_audit' and event.get('audit_manifest_or_no_payload') is True
                  and txn.get('affected_rows') == 2 and txn.get('manifest_rows_changed') == 1
                  and txn.get('read_audit_rows_changed') == 1 and event['status'] == 200):
                kind = 'technical_read_audit'
            commits.append({'start_ns': txn['commit_started_ns'], 'end_ns': txn['finished_ns'],
                            'event': event['event'], 'kind': kind})

    for event in events:
        if event['method'] != 'GET' or event['status'] != 409:
            continue
        explanation = {'category': 'UNKNOWN', 'reason': 'insufficient phase evidence', 'commits': []}
        event['conflict_explanation'] = explanation
        event['session_kind'] = 'individually_authenticated_same_role'
        outcome = [row.get('outcome') for row in event.get('release_persist', ())]
        if (event.get('conflict_code') in {'ACCESS_CONTEXT_CHANGED', 'SESSION_IDENTITY_CHANGED'}
                and 'access_context_changed' in outcome):
            explanation.update(category='access_or_session', reason='release reader rejected the access context')
            continue
        if event.get('conflict_code') != 'PATIENT_QUERY_CHANGED' or 'query_changed' not in outcome:
            continue
        snapshots = {row['phase']: row for row in event.get('read_snapshots', ())}
        validation = event.get('fingerprint_validation')
        versions = event.get('release_versions', [])
        lock = next((row for row in event.get('native', ()) if row['kind'] == 'release_audit'), {})
        if not {'original', 'validation'} <= snapshots.keys() or not validation or lock.get('end') != 'ROLLBACK':
            continue
        original = snapshots['original']
        verify = snapshots['validation']
        if not all('first_read_start_ns' in row and 'first_read_execute_done_ns' in row for row in (original, verify)):
            continue
        if validation == 'changed':
            explanation['point'] = 'full_fingerprint'
            possible = [c for c in commits if c['event'] != event['event']
                        and original['first_read_start_ns'] <= c['end_ns']
                        and c['start_ns'] <= verify['first_read_execute_done_ns']]
            explanation['commits'] = possible
            proven = [c for c in possible if original['first_read_execute_done_ns'] < c['start_ns']
                      and c['end_ns'] < verify['first_read_start_ns']]
            if proven and all(c['kind'] in {'medical', 'technical_read_audit'} for c in possible) and any(
                    c['kind'] == 'medical' for c in proven):
                explanation.update(category='medical', reason='fingerprint changed and a confirmed clinical commit falls strictly between snapshots')
                explanation['writer_object_outside_page'] = event.get('writer_object_outside_page')
            else:
                explanation['reason'] = 'fingerprint changed but the commit source or snapshot order is not fully proven'
            continue
        if (validation != 'matched' or len(versions) != 2 or not all('value' in row for row in versions)
                or versions[0]['under_writer'] or not versions[1]['under_writer']
                or versions[0]['connection_ordinal'] != versions[1]['connection_ordinal']
                or versions[0]['value'] == versions[1]['value']):
            continue
        explanation['point'] = 'data_version'
        before, after = versions
        possible = [c for c in commits if c['event'] != event['event']
                    and before['start_ns'] <= c['end_ns'] and c['start_ns'] <= after['end_ns']]
        explanation['commits'] = possible
        if possible and all(c['kind'] == 'technical_read_audit' and before['end_ns'] < c['start_ns']
                            and c['end_ns'] < after['start_ns'] for c in possible):
            explanation.update(category='technical_read_audit',
                               reason='unchanged fingerprint and only enclosed, audited technical commits')
        elif (possible and any(c['kind'] == 'medical' and verify['first_read_execute_done_ns'] < c['start_ns']
                               and c['end_ns'] < after['start_ns'] for c in possible)
              and all(c['kind'] in {'medical', 'technical_read_audit'} for c in possible)):
            explanation.update(category='medical',
                               reason='matched snapshot predated a confirmed clinical commit before the differing same-connection sample')
            explanation['writer_object_outside_page'] = event.get('writer_object_outside_page')
        else:
            explanation['reason'] = 'same-connection data_version drift without sufficient enclosed commit evidence'
