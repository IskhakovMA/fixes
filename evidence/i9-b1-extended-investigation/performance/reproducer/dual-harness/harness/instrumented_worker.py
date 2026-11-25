#!/usr/bin/env python3
"""Isolated I-9 paired ASGI benchmark. Requires the locked Python 3.13 venv."""

import argparse
import ast
import inspect
import textwrap
import asyncio
import contextvars
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import threading
from urllib.parse import unquote, urlsplit


BASELINE = 'f849b2909c2d23923e0ce996f0aca4b670ca9c18'
FIXTURE_SHA256 = 'e156bf74af956bd47e87250876d6826669e99388ae4a822e569893c282a4f976'
ROLES = {'developer': ('dev', 100), 'doctor': ('doc0', 20), 'head': ('head', 80)}
COUNTS = (100, 1000, 10000)
LEVELS = (1, 4, 8)
CLOCK = '2026-11-24T10:00:00+03:00'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def git(root, *args):
    return subprocess.check_output(
        ['git', '--no-optional-locks', '-C', str(root), *args],
        env={'PATH': os.defpath, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'},
        text=True,
    ).strip()


def preflight(root, sha):
    require(git(root, 'rev-parse', 'HEAD') == sha, 'unexpected worktree SHA')
    require(not git(root, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--',
                    'backend', 'static', 'index.html', '.env'), 'runtime paths contain changes or extras')
    digests = {}
    for filename in ('requirements.txt', 'requirements-dev.txt'):
        contents = (root / 'backend' / filename).read_bytes()
        pins = re.findall(r'^([\w.-]+)==([^\s\\]+)', contents.decode(), flags=re.M)
        require(pins, 'missing dependency pins')
        for name, version in pins:
            require(importlib.metadata.version(name) == version, f'wrong installed version for {name}')
        digests[filename] = hashlib.sha256(contents).hexdigest()
    return digests


def benchmark_data(fixture):
    source = fixture.read_bytes()
    require(hashlib.sha256(source).hexdigest() == FIXTURE_SHA256, 'unexpected WP-H seed fixture')
    prefix, marker, _ = source.decode().partition(' from backend.app.main import app\n')
    require(marker, 'WP-H seed terminator missing')
    return prefix.replace('root=Path(__file__).resolve().parents[3]', 'root=target_root', 1).replace(
        ' from backend.app import db,users,store,operations_state,security',
        ' from backend.app import clock\n clock.now_moscow = lambda: frozen\n'
        ' from backend.app import db,users,store,operations_state,security', 1)


def instrument(db, deps, read_access, patient_pages, data_root):
    active = contextvars.ContextVar('i9_active_sample', default=None)
    phase = contextvars.ContextVar('i9_release_phase', default=False)
    original_connect = db._connect
    original_persist = read_access._persist
    original_validate = patient_pages.validate_release
    original_rollback = db._ClinicConnection.rollback
    original_page = patient_pages.page

    def observe_db_function(name):
        original = getattr(db, name)

        def observed(*args, **kwargs):
            sample = active.get()
            if sample is None:
                return original(*args, **kwargs)
            started = time.perf_counter_ns()
            try:
                result = original(*args, **kwargs)
                if name == 'connect_release':
                    sample['release_admission_path'] = 'legacy' if result[1].prepared else 'canonical'
                return result
            finally:
                sample.setdefault('schema_functions_ns', {}).setdefault(name, []).append(
                    time.perf_counter_ns() - started)

        setattr(db, name, observed)

    for name in ('init_db', *DIAG_ARGS.admission_function):
        if hasattr(db, name):
            observe_db_function(name)

    def observed_page(*args, **kwargs):
        result = original_page(*args, **kwargs)
        sample = active.get()
        if sample is not None:
            sample['snapshot_ready_ns'] = time.perf_counter_ns()
            expected_scope = DIAG_ARGS.count * ROLES[DIAG_ARGS.role][1] // 100
            targets = {f'Синтетический Пациент {expected_scope - i:05d}' for i in (1, 2)}
            sample['writer_object_outside_page'] = (result['page']['total'] == expected_scope
                and all(row['name'] not in targets for row in result['patients']))
            callback = sample.get('on_snapshot_ready')
            if callback is not None:
                callback()
        return result

    patient_pages.page = observed_page
    factories = {}

    def persist(*args, **kwargs):
        token = phase.set(True)
        try:
            return original_persist(*args, **kwargs)
        finally:
            phase.reset(token)

    def validate(*args, **kwargs):
        conn = args[0]
        field = 'fallback_ns' if getattr(conn, 'i9_window', None) else 'validation_ns'
        start = time.perf_counter_ns()
        sample = active.get()
        try:
            result = original_validate(*args, **kwargs)
        except patient_pages.QueryChanged:
            if sample is not None:
                sample['fingerprint_validation'] = 'changed'
            raise
        else:
            if sample is not None:
                sample['fingerprint_validation'] = 'matched'
            return result
        finally:
            if sample is not None:
                sample[field].append(time.perf_counter_ns() - start)

    def kind_for_begin(sample):
        frame = sys._getframe(1)
        while frame:
            if frame.f_code.co_name == 'init_db':
                return 'schema_init'
            frame = frame.f_back
        if phase.get():
            return 'release_audit'
        return ('clinical_write' if sample.get('clinical') else 'activity' if sample.get('heartbeat')
                else 'request_writer')

    def native_execute(conn, sql, parameters):
        sample = active.get()
        if sample is None:
            return sqlite3.Connection.execute(conn, sql, parameters)
        command = sql.strip().upper()
        if command.startswith('SELECT ') and 'SCOPED_' in command:
            started = time.perf_counter_ns()
            try:
                return sqlite3.Connection.execute(conn, sql, parameters)
            finally:
                sample.setdefault('revision_read_prepare_ns', []).append(time.perf_counter_ns() - started)
        if command.startswith('INSERT INTO READ_ACCESS_MANIFESTS '):
            sample['event_ids'].append(parameters[0])
        if command == 'BEGIN IMMEDIATE':
            kind = kind_for_begin(sample)
            started = time.perf_counter_ns()
            row = {'kind': kind, 'waiting_started_ns': started}
            sample['native'].append(row)
            try:
                result = sqlite3.Connection.execute(conn, sql, parameters)
            except BaseException as e:
                row.update(wait_ns=time.perf_counter_ns() - started, end='BEGIN_ERROR',
                           sqlite_error=getattr(e, 'sqlite_errorcode', None))
                raise
            acquired = time.perf_counter_ns()
            row.update(wait_ns=acquired - started, acquired_ns=acquired)
            conn.i9_window = row
            conn.i9_changes_when_acquired = conn.total_changes
            callback = sample.get('on_release_acquired')
            if kind == 'release_audit' and callback is not None:
                callback()
            return result
        if (command.startswith('UPDATE SESSIONS SET LAST_SEEN_AT') or sample.get('measure_dml')) and command.startswith(
                ('INSERT ', 'UPDATE ', 'DELETE ')):
            started = time.perf_counter_ns()
            try:
                return sqlite3.Connection.execute(conn, sql, parameters)
            finally:
                sample.setdefault('dml_ns', []).append(time.perf_counter_ns() - started)
        require(command not in ('COMMIT', 'ROLLBACK') or not getattr(conn, 'i9_window', None),
                'unmeasured SQL transaction terminator')
        return sqlite3.Connection.execute(conn, sql, parameters)

    def native_end(conn, operation, method):
        row = getattr(conn, 'i9_window', None)
        if row is None:
            return method(conn)
        started = time.perf_counter_ns()
        try:
            result = method(conn)
        except BaseException as e:
            row[operation.lower() + '_error_ns'] = time.perf_counter_ns() - started
            row['sqlite_error'] = getattr(e, 'sqlite_errorcode', None)
            raise
        ended = time.perf_counter_ns()
        row['end'] = operation
        row['finished_ns'] = ended
        row['hold_ns'] = ended - row.pop('acquired_ns')
        row[operation.lower() + '_ns'] = ended - started
        if operation == 'COMMIT':
            row['commit_started_ns'] = started
            row['affected_rows'] = conn.total_changes - conn.i9_changes_when_acquired
        conn.i9_window = None
        return result

    def native_commit(conn):
        return native_end(conn, 'COMMIT', sqlite3.Connection.commit)

    def rollback(conn):
        return native_end(conn, 'ROLLBACK', original_rollback)

    # Preserve exact product wrapper logic, instrument only underlying C call.
    # AST checks require exactly one matching super().execute/commit occurrence.
    class ObserveNative(ast.NodeTransformer):
        def __init__(self, name):
            self.name, self.count = name, 0

        def visit_Call(self, call):
            self.generic_visit(call)
            target = call.func
            if (isinstance(target, ast.Attribute) and target.attr == self.name
                    and isinstance(target.value, ast.Call) and isinstance(target.value.func, ast.Name)
                    and target.value.func.id == 'super' and not target.value.args and not target.value.keywords):
                self.count += 1
                return ast.copy_location(ast.Call(
                    ast.Name('_i9_native_' + self.name, ast.Load()),
                    [ast.Name('self', ast.Load()), *call.args], call.keywords), call)
            return call

    for name, hook in ('execute', native_execute), ('commit', native_commit):
        function = getattr(db._ClinicConnection, name)
        module = ast.parse(textwrap.dedent(inspect.getsource(function)))
        transformer = ObserveNative(name)
        module = ast.fix_missing_locations(transformer.visit(module))
        require(transformer.count == 1, 'native wrapper instrumentation did not identify exact call')
        db.__dict__['_i9_native_' + name] = hook
        namespace = {}
        exec(compile(module, '<i9-runtime-probe:' + name + '>', 'exec'), db.__dict__, namespace)
        setattr(db._ClinicConnection, name, namespace[name])
    db._ClinicConnection.rollback = rollback

    def on_sql(statement):
        sample = active.get()
        if sample is not None:
            sample['sql'] += 1
            command = statement.lstrip().upper()
            if 'SQLITE_SCHEMA' in command or 'SQLITE_MASTER' in command:
                sample['schema_catalog_statements'] = sample.get('schema_catalog_statements', 0) + 1
            if command.startswith(('SELECT ', 'WITH ')):
                sample['select'] += 1

    def connect(path, **kwargs):
        require(Path(path).resolve() == data_root / 'clinic.db', 'unapproved application DB path')
        factory = kwargs.get('factory', db._ClinicConnection)
        if factory not in factories:
            class Measured(factory):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, **kwargs)
                    self.set_trace_callback(on_sql)

            factories[factory] = Measured
        kwargs['factory'] = factories[factory]
        return original_connect(path, **kwargs)

    db._connect = deps._connect = connect
    read_access._persist = persist
    patient_pages.validate_release = validate
    from probes import instrument as install_probes
    from request_diagnostics import install as install_request_diagnostics
    install_probes(active, db, read_access)
    install_request_diagnostics(active, phase, db, read_access, patient_pages)
    return active, original_connect


async def measure(app, ctx, connection, db_path, password, role, patients, level, warmup, waves, with_writer, activity_mode):
    from contextlib import AsyncExitStack
    import httpx

    user, percentage = ROLES[role]
    expected_count = min(50, patients * percentage // 100)
    events = set()
    output = []
    fixed_seconds = DIAG_ARGS.fixed_seconds
    after_warmup = None
    cadence = activity_mode in ('cadence', 'cadence_own')

    async def observed_app(scope, receive, send):
        sample = ctx.get()
        if sample is None:
            return await app(scope, receive, send)
        sample['asgi_start_ns'] = time.perf_counter_ns()

        async def measured_send(message):
            if message['type'] == 'http.response.start':
                sample['asgi_response_start_ns'] = time.perf_counter_ns()
            elif message['type'] == 'http.response.body' and not message.get('more_body'):
                sample['asgi_response_body_end_ns'] = time.perf_counter_ns()
            return await send(message)

        try:
            return await app(scope, receive, measured_send)
        finally:
            sample['asgi_end_ns'] = time.perf_counter_ns()

    async with app.router.lifespan_context(app), AsyncExitStack() as clients_stack:
        clients = []
        sessions = set()
        for _ in range(level):
            transport = httpx.ASGITransport(app=observed_app, raise_app_exceptions=False)
            client = await clients_stack.enter_async_context(httpx.AsyncClient(
                transport=transport, base_url='http://127.0.0.1', trust_env=False))
            response = await client.post('/api/auth/login', json={'username': 'wph.' + user, 'password': password})
            require(response.status_code == 200, f'synthetic login HTTP {response.status_code}')
            token = client.cookies.get('clinic_session')
            require(token and token not in sessions, 'missing or duplicate cookie session')
            sessions.add(token)
            clients.append(client)


        with connection(db_path) as verifier:
            initial_audited_total = verifier.execute(
                'SELECT count(*) FROM audit_events WHERE event_type=? AND result=?',
                ('medical_read_release', 'ok')).fetchone()[0]

        other_staff = clients if activity_mode == 'cadence_own' else []
        if activity_mode and activity_mode not in ('own', 'cadence_own'):
            cohort_size = 8 if activity_mode in ('overlap', 'cadence') else 1
            for index in range(cohort_size):
                client = await clients_stack.enter_async_context(httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=observed_app, raise_app_exceptions=False),
                    base_url='http://127.0.0.1', trust_env=False))
                activity_user = user if activity_mode == 'same_user' else 'doc' + str(index)
                reply = await client.post('/api/auth/login', json={'username': 'wph.' + activity_user, 'password': password})
                cookie = client.cookies.get('clinic_session')
                require(reply.status_code == 200 and client.cookies.get('clinic_csrf') and cookie not in sessions,
                        'distinct staff login failed')
                sessions.add(cookie)
                other_staff.append(client)

        async def activity(client, staff_slot):
            from backend.app import security

            token_hash = security.hash_token(client.cookies['clinic_session'])
            def seen():
                with connection(db_path) as verifier:
                    return tuple(verifier.execute(
                        'SELECT last_seen_at FROM sessions WHERE token_hash=?', (token_hash,)).fetchone())
            prior = seen()
            sample = {'staff_slot': staff_slot, 'heartbeat': True, 'sql': 0, 'select': 0, 'native': [], 'event_ids': []}
            token = ctx.set(sample)
            try:
                reply = await client.post('/api/auth/activity', headers={'x-csrf-token': client.cookies['clinic_csrf']})
                sample['status'] = reply.status_code
            finally:
                ctx.reset(token)
                sample.pop('event_ids')
            after = seen()
            sample['touch_verified'] = (sample['status'] == 200 and after[0] > prior[0]
                                        and [(w['kind'], w['end']) for w in sample['native']] == [('activity', 'COMMIT')])
            return sample

        if with_writer:
            writer = await clients_stack.enter_async_context(httpx.AsyncClient(
                transport=httpx.ASGITransport(app=observed_app, raise_app_exceptions=False),
                base_url='http://127.0.0.1', trust_env=False))
            signed_in = await writer.post('/api/auth/login', json={'username': 'wph.dev', 'password': password})
            require(signed_in.status_code == 200 and writer.cookies.get('clinic_csrf'), 'synthetic writer login')
            require(writer.cookies.get('clinic_session') not in sessions, 'non-unique synthetic writer session')
            synthetic_name = f'Синтетический Пациент {patients * percentage // 100 - 1:05d}'
            with connection(db_path) as verifier:
                patient_id, version, initial_age = verifier.execute(
                    'SELECT id, version, age FROM patients WHERE name=?', (synthetic_name,)).fetchone()
                write_events = verifier.execute(
                    "SELECT COUNT(*) FROM audit_events WHERE event_type='patient_updated' AND patient_id=?",
                    (patient_id,)).fetchone()[0]

        async def clinical_write(gate, ready, release_acquired, value):
            nonlocal version, write_events
            sample = {'native': [], 'validation_ns': [], 'fallback_ns': [], 'event_ids': [],
                      'sql': 0, 'select': 0, 'clinical': True}
            ready.set()
            await gate.wait()
            await asyncio.wait_for(release_acquired.wait(), timeout=60)
            token = ctx.set(sample)
            try:
                reply = await asyncio.wait_for(writer.patch('/api/patients/' + patient_id,
                    json={'field': 'age', 'value': value, 'expectedVersion': version},
                    headers={'x-csrf-token': writer.cookies['clinic_csrf']}), timeout=60)
                sample['status'] = reply.status_code
                if reply.status_code == 200:
                    version = reply.json()['version']
                    write_events += 1
                    with connection(db_path) as verifier:
                        row = verifier.execute('SELECT version, age FROM patients WHERE id=?', (patient_id,)).fetchone()
                        count = verifier.execute(
                            "SELECT COUNT(*) FROM audit_events WHERE event_type='patient_updated' AND patient_id=?",
                            (patient_id,)).fetchone()[0]
                    sample['write_audit_verified'] = tuple(row) == (version, value) and count == write_events
            except TimeoutError:
                sample['status'] = 'timeout'
            finally:
                ctx.reset(token)
            sample.pop('event_ids')
            sample.pop('validation_ns')
            sample.pop('fallback_ns')
            return sample

        async def request(slot, gate, ready, on_release_acquired=None, on_snapshot_ready=None):
            sample = {'slot': slot, 'sql': 0, 'select': 0, 'validation_ns': [], 'fallback_ns': [], 'native': [], 'event_ids': []}
            ready.set()
            await gate.wait()
            token = ctx.set(sample)
            sample['start_ns'] = time.perf_counter_ns()
            sample['on_release_acquired'] = on_release_acquired
            sample['on_snapshot_ready'] = on_snapshot_ready
            try:
                response = await asyncio.wait_for(clients[slot].get('/api/patients', params={
                    'view': 'page', 'limit': 50, 'sort': 'name'}), timeout=60)
                sample['status'] = response.status_code
            except TimeoutError:
                sample['status'] = 'timeout'
                response = None
            finally:
                sample['end_ns'] = time.perf_counter_ns()
                ctx.reset(token)
            if response is not None and response.status_code == 200:
                payload = response.json()
                rows = payload['patients']
                owners = {row['name'] for row in rows}
                prefix = 'Синтетический Пациент '
                sample['scope_ok'] = len(rows) == len(owners) == expected_count and all(
                    name.startswith(prefix) and name[len(prefix):].isdigit()
                    and int(name[len(prefix):]) < patients * percentage // 100 for name in owners)
                sample['digest'] = hashlib.sha256(response.content).hexdigest()
            if response is not None and response.status_code != 200:
                sample['response_contains_synthetic_patient'] = 'Синтетический Пациент ' in response.text or '"patients":' in response.text
            if response is not None and response.status_code == 409:
                try:
                    body = response.json()
                    code = body.get('code') or (body['detail'].get('code') if isinstance(body.get('detail'), dict) else None)
                    categories = {'PATIENT_QUERY_CHANGED', 'ACCESS_CONTEXT_CHANGED', 'SESSION_IDENTITY_CHANGED'}
                    sample['known_conflict'] = code == 'PATIENT_QUERY_CHANGED'
                    sample['conflict_code'] = code if isinstance(code, str) and code in categories else 'other'
                except (ValueError, AttributeError):
                    sample['known_conflict'] = False
            return sample

        if DIAG_ARGS.open_seconds:
            from schedule_open import operate
            second = await clients_stack.enter_async_context(httpx.AsyncClient(
                transport=httpx.ASGITransport(app=observed_app, raise_app_exceptions=False),
                base_url='http://127.0.0.1', trust_env=False))
            reply = await second.post('/api/auth/login', json={'username': 'wph.dev', 'password': password})
            require(reply.status_code == 200 and second.cookies.get('clinic_csrf'), 'second synthetic writer login')
            require(second.cookies.get('clinic_session') not in sessions | {writer.cookies.get('clinic_session')},
                    'second synthetic writer shares a session')
            other_name = f'Синтетический Пациент {patients * percentage // 100 - 2:05d}'
            with connection(db_path) as verifier:
                other, other_ver, other_age = verifier.execute(
                    'SELECT id, version, age FROM patients WHERE name=?', (other_name,)).fetchone()
                other_events = verifier.execute(
                    "SELECT COUNT(*) FROM audit_events WHERE event_type='patient_updated' AND patient_id=?",
                    (other,)).fetchone()[0]
            require(other != patient_id, 'writer targets must differ')
            writers = [dict(client=client, id=p, version=v, age=a, before_version=v, before_audit=n, success=0)
                       for client,p,v,a,n in ((writer,patient_id,version,initial_age,write_events),
                                               (second,other,other_ver,other_age,other_events))]
            await operate(args=DIAG_ARGS, ctx=ctx, connection=connection, db_path=db_path,
                          request=request, writers=writers, initial_audited_total=initial_audited_total)
            return [], []

        periodic = []
        periodic_stop = asyncio.Event()

        async def periodic_activity(client, offset, staff_slot):
            try:
                await asyncio.wait_for(periodic_stop.wait(), timeout=offset)
                return
            except TimeoutError:
                pass
            while not periodic_stop.is_set():
                periodic.append(await activity(client, staff_slot))
                try:
                    await asyncio.wait_for(periodic_stop.wait(), timeout=30)
                except TimeoutError:
                    pass

        schedules = ([asyncio.create_task(periodic_activity(client, 0.25 + slot * .4, slot))
                      for slot, client in enumerate(other_staff)] if cadence else [])
        cadence_start = time.perf_counter_ns()
        wave_count = 0
        while (time.perf_counter_ns() - cadence_start < 35_000_000_000 if cadence else
               (wave_count < warmup or (fixed_seconds and
                time.perf_counter_ns() - (after_warmup or cadence_start) < fixed_seconds * 1_000_000_000)
                or (not fixed_seconds and wave_count < warmup + waves))):
            if wave_count == warmup and after_warmup is None and not cadence:
                after_warmup = time.perf_counter_ns()
            wave = wave_count
            wave_count += 1
            gate = asyncio.Event()
            ready = [asyncio.Event() for _ in clients]
            release_acquired = asyncio.Event()
            all_snapshots = asyncio.Event()
            allow_release = threading.Event()
            snapshots_seen = 0
            loop = asyncio.get_running_loop()

            def arrived():
                nonlocal snapshots_seen
                snapshots_seen += 1
                if snapshots_seen == level:
                    all_snapshots.set()

            def block_at_snapshot():
                loop.call_soon_threadsafe(arrived)
                require(allow_release.wait(timeout=20), 'synthetic after-snapshot barrier timed out')

            with_barrier = activity_mode in ('one', 'same_user', 'own', 'overlap')
            signal_release = lambda: loop.call_soon_threadsafe(release_acquired.set) if with_writer else None
            tasks = [asyncio.create_task(request(slot, gate, ready[slot], signal_release,
                                                  block_at_snapshot if with_barrier else None))
                     for slot in range(level)]
            if with_writer:
                writer_ready = asyncio.Event()
                tasks.append(asyncio.create_task(clinical_write(gate, writer_ready, release_acquired, 46 + wave % 2)))
                ready.append(writer_ready)
            await asyncio.gather(*(entry.wait() for entry in ready))
            gate.set()
            heartbeats = []
            if with_barrier:
                try:
                    await asyncio.wait_for(all_snapshots.wait(), timeout=15)
                    cohort = clients[:1] if activity_mode == 'own' else other_staff
                    heartbeats = await asyncio.gather(*(activity(client, slot) for slot, client in enumerate(cohort)))
                finally:
                    allow_release.set()
            samples = await asyncio.gather(*tasks)
            writer_sample = samples.pop() if with_writer else None
            born = min(sample['start_ns'] for sample in samples)
            read_wave_ns = max(sample['end_ns'] for sample in samples) - born
            if writer_sample is not None:
                astart, aend = writer_sample.pop('asgi_start_ns', None), writer_sample.pop('asgi_end_ns', None)
                writer_sample['asgi_wall_ns'] = aend - astart if aend is not None and astart is not None else None
                writer_sample['overlaps_read'] = aend is not None and astart is not None and any(
                    astart < s['asgi_end_ns'] and s['asgi_start_ns'] < aend
                    for s in samples if 'asgi_start_ns' in s and 'asgi_end_ns' in s)
                read_locks = [tx for s in samples for tx in s['native']
                              if tx['kind'] == 'release_audit' and 'hold_ns' in tx]
                writer_sample['read_lock_present_at_attempt'] = any(
                    r['finished_ns'] - r['hold_ns'] <= w['waiting_started_ns'] < r['finished_ns']
                    for r in read_locks for w in writer_sample['native'] if w['kind'] == 'clinical_write')
            edge = sorted((sample[key], delta) for sample in samples
                          if 'asgi_start_ns' in sample and 'asgi_end_ns' in sample
                          for key, delta in (('asgi_start_ns', 1), ('asgi_end_ns', -1)))
            current = peak = 0
            for _, delta in edge:
                current += delta
                peak = max(peak, current)
            require(peak == level, f'actual ASGI overlap {peak} differs from intended {level}')
            with connection(db_path) as verifier:
                for sample in samples:
                    sample.pop('asgi_start_ns', None)
                    sample.pop('asgi_end_ns', None)
                    sample.pop('on_release_acquired')
                    sample.pop('on_snapshot_ready')
                    if sample['status'] != 200:
                        sample['no_patient_payload'] = (not sample.get('response_contains_synthetic_patient', False))
                    if sample['status'] == 409:
                        sample['conflict_category'] = ('audit_only_workload' if sample.get('known_conflict')
                                                       and not activity_mode and not with_writer else 'unresolved')
                    identifiers = sample.pop('event_ids')
                    digest = sample.pop('digest', None)
                    sample['audit_ok'] = False
                    sample['started_offset_ns'] = sample.pop('start_ns') - born
                    sample['wall_ns'] = sample.pop('end_ns') - born - sample['started_offset_ns']
                    if digest is not None and len(identifiers) == 1 and identifiers[0] not in events:
                        identifier = identifiers[0]
                        row = verifier.execute("SELECT m.snapshot_sha256 FROM read_access_manifests m JOIN audit_events a ON a.id=m.audit_event_id WHERE a.id=? AND a.event_type=? AND a.result=?",
                                               (identifier, 'medical_read_release', 'ok')).fetchone()
                        sample['audit_ok'] = row is not None and row[0] == digest
                        events.add(identifier)
                    sample['timings_complete'] = (len(sample['validation_ns']) == 1
                        and len(sample['fallback_ns']) <= 1
                        and [(window['kind'], window.get('end')) for window in sample['native']]
                        in ([('schema_init', 'COMMIT'), ('release_audit', 'COMMIT')],
                            [('release_audit', 'COMMIT')]))
                    sample['manifest_insertions'] = len(identifiers)
                    if sample['status'] == 200:
                        require(sample['audit_ok'] and sample['scope_ok'] and sample['timings_complete'],
                                'successful GET violated audit, scope or transaction invariant')
                    else:
                        require(sample['no_patient_payload'] and not identifiers,
                                'failed GET included patient payload or a manifest insertion')
            if with_barrier:
                require(len(heartbeats) == (8 if activity_mode == 'overlap' else 1)
                        and all(h['touch_verified'] for h in heartbeats), 'unverified synthetic heartbeat')
            if wave < warmup and not cadence:
                require((activity_mode or with_writer or any(s['status'] == 200 for s in samples)) and all(
                    (s['status'] == 200 and s['audit_ok'] and s.get('scope_ok') and s['timings_complete'])
                    or (s['status'] == 409 and s.get('known_conflict')) for s in samples),
                    'warmup detected invalid response, scope, audit or timings')
                continue
            output.append({'wave': wave - warmup + 1, 'peak_overlap': peak, 'samples': samples,
                           'duration_ns': read_wave_ns, 'clinical_writer': writer_sample,
                           'activity': heartbeats})
            if cadence:
                # No measurement of an artificially saturated browser queue.
                await asyncio.sleep(0.12)
        elapsed_window = time.perf_counter_ns() - (after_warmup or cadence_start)
        DIAG_ARGS.measured_window_ns = elapsed_window
        if schedules:
            periodic_stop.set()
            await asyncio.gather(*schedules)
            require(len(periodic) == 2 * len(other_staff) and all(item['touch_verified'] for item in periodic),
                    'expected exactly two verified heartbeat writes per session')
            commits = sorted((w['finished_ns'], item['staff_slot']) for item in periodic if item['status'] == 200
                             for w in item['native'] if w['kind'] == 'activity' and w['end'] == 'COMMIT')
            for entry in output:
                for sample in entry['samples']:
                    snapshot_ns = sample.get('snapshot_ready_ns')
                    locked = next((w for w in sample['native'] if w['kind'] == 'release_audit'), None)
                    # For v33 the authoritative baseline PRAGMA is sampled AFTER
                    # this boundary; mark overlap, not per-conflict causation.
                    if snapshot_ns and locked and 'hold_ns' in locked:
                        through_ns = locked['finished_ns'] - locked['hold_ns']
                        touched = {slot for commit, slot in commits if snapshot_ns < commit < through_ns}
                        sample['activity_commit_between_snapshot_and_release'] = bool(touched)
                        sample['own_activity_commit_between_snapshot_and_release'] = (
                            activity_mode == 'cadence_own' and sample['slot'] in touched)
        for entry in output:
            for sample in entry['samples']:
                sample.pop('snapshot_ready_ns', None)
        with connection(db_path) as verifier:
            audited_total, paired_total = verifier.execute(
                'SELECT count(*), count(m.audit_event_id) FROM audit_events a LEFT JOIN read_access_manifests m '
                'ON m.audit_event_id=a.id WHERE a.event_type=? AND a.result=?',
                ('medical_read_release', 'ok')).fetchone()
        require(audited_total == paired_total == initial_audited_total + len(events), 'successful SQL audit and manifests disagree')
        return output, periodic


def worker(args):
    from datetime import datetime
    require(os.environ.get('CLINIC_I9_CHILD') == '1', 'worker requires orchestrator')
    require(sys.flags.isolated and sys.dont_write_bytecode, 'worker requires python -I -B')
    digests = preflight(args.worktree, args.sha)
    source = benchmark_data(args.fixture)
    root = args.worktree.resolve()
    os.environ.clear()
    os.environ.update(PATH=os.defpath, TMPDIR=str(args.out.parent.resolve()), LANG='C.UTF-8')
    sys.path.insert(0, str(root))
    # Read application modules only after the WP-H fixture has configured synthetic data.
    suffix = '''
 from backend.app import config, clock, deps, patient_pages, read_access
 from backend.app.main import app
 from contextlib import closing
 data_root = Path(td).resolve()
 require(config.SCHEMA_VERSION == 33, 'unexpected schema version')
 require(config.APP_ENV == 'test' and config.DB_PATH.resolve() == data_root / 'clinic.db', 'unsafe benchmark config')
 require(config.NOTIFICATION_PROVIDER == 'mock' and config.AI_MODE == 'disabled', 'unsafe side-effect config')
 clock.now_moscow = lambda: frozen
 context, observed_connection = instrument(db, deps, read_access, patient_pages, data_root)
 with closing(observed_connection(config.DB_PATH)) as check:
  sqlite_settings = {'journal_mode':check.execute('PRAGMA journal_mode').fetchone()[0],
                     'busy_timeout_ms':check.execute('PRAGMA busy_timeout').fetchone()[0]}
 from contextlib import contextmanager
 @contextmanager
 def verifier(path):
  with closing(observed_connection(path)) as opened:
   yield opened
 output, periodic = asyncio.run(measure(app, context, verifier, config.DB_PATH, password, planned.role,
                              planned.count, planned.sessions, planned.warmup, planned.waves, planned.clinical_writer, planned.activity))
 receipt = {'sha': planned.sha, 'count': planned.count, 'role': planned.role,
            'sessions': planned.sessions, 'sqlite_version': sqlite3.sqlite_version, 'sqlite':sqlite_settings,
            'dependency_lock_sha256': lock_digests, 'python': sys.version.split()[0],
            'synthetic_only': True, 'business_clock': frozen.isoformat(), 'clinical_writer': planned.clinical_writer,
            'schema_version': config.SCHEMA_VERSION, 'activity_mode': planned.activity, 'periodic_activity': periodic,
            'waves': output, 'measured_window_ns': planned.measured_window_ns, 'target_window_seconds': planned.fixed_seconds}
 if planned.open_seconds:
  receipt['open_loop'] = planned.open_result
 planned.out.write_text(json.dumps(receipt, indent=2) + '\\n')
'''
    prefix = 'clinic-wph-baseline-'

    def deny_external(event, values):
        if event in {'socket.connect', 'socket.bind', 'socket.sendto', 'socket.sendmsg', 'os.system',
                     'subprocess.Popen', 'os.posix_spawn'}:
            raise PermissionError('I-9 worker blocks outbound traffic and child processes')
        if event == 'sqlite3.connect' and values[0] != ':memory:':
            database = str(values[0])
            uri_mode = None
            if database.startswith('file:'):
                uri = urlsplit(database)
                require(not uri.netloc and uri.query in ('mode=ro', 'mode=rw') and not uri.fragment,
                        'unapproved database URI')
                uri_mode = uri.query
                database = unquote(uri.path)
            path = Path(database).resolve()
            parts = path.relative_to(args.out.parent.resolve()).parts
            require(parts and parts[0].startswith(prefix) and (parts[1:] == ('clinic.db',)
                    or uri_mode != 'mode=rw' and len(parts) == 3
                    and parts[1].startswith('clinic-check-') and parts[2] == 'diagnose.sqlite'),
                    'unapproved synthetic SQLite location')

    sys.addaudithook(deny_external)
    sys.argv = [str(args.fixture), '--count', str(args.count), '--port', '9999']
    # Capture fixture seed summary and app logs privately. Public receipts contain timings and checks only.
    exec(compile(source + suffix, str(args.fixture), 'exec'), {
        '__file__': str(args.fixture), 'target_root': root, 'planned': args, 'asyncio': asyncio,
        'sqlite3': sqlite3, 'frozen': datetime.fromisoformat(CLOCK), 'lock_digests': digests,
        'require': require, 'instrument': instrument, 'measure': measure,
    })


def main():
    require(sys.version_info[:2] == (3, 13) and sys.prefix != sys.base_prefix, 'use the locked Python 3.13 venv')
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    child = sub.add_parser('worker')
    child.add_argument('--worktree', type=Path, required=True)
    child.add_argument('--sha', required=True)
    child.add_argument('--count', type=int, choices=COUNTS, required=True)
    child.add_argument('--role', choices=ROLES, required=True)
    child.add_argument('--sessions', type=int, choices=LEVELS, required=True)
    child.add_argument('--warmup', type=int, required=True)
    child.add_argument('--waves', type=int, required=True)
    child.add_argument('--clinical-writer', action='store_true')
    child.add_argument('--activity', choices=('one', 'same_user', 'own', 'overlap', 'cadence', 'cadence_own'))
    child.add_argument('--fixture', type=Path, required=True)
    child.add_argument('--out', type=Path, required=True)
    child.add_argument('--admission-function', action='append', default=[])
    child.add_argument('--fixed-seconds', type=int, default=0)
    child.add_argument('--open-seconds', type=int, default=0)
    child.add_argument('--get-hz', default='0')
    child.add_argument('--patch-hz', default='0')
    args = parser.parse_args()
    if args.open_seconds:
        require(args.clinical_writer and not args.activity and args.open_seconds <= 60, 'invalid independent scheduler profile')
    global DIAG_ARGS
    DIAG_ARGS = args
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    require(args.count in COUNTS and args.role in ROLES and args.sessions in LEVELS, 'multiscale budget')
    worker(args)


if __name__ == '__main__':
    main()
