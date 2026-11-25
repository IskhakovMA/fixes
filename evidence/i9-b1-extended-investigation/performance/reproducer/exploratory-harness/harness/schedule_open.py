"""Offered GET/PATCH timeline with bounded clients and no requeues."""
import asyncio
from fractions import Fraction
import resource
import time


def timeline(duration, level, get_hz, patch_hz):
    """Preschedule every arrival as an integer offset in monotonic nanoseconds."""
    rates = (('GET', get_hz * level, 0), ('PATCH', patch_hz, 37_000_000))
    spec = []
    for method, rate, phase_ns in rates:
        if not rate:
            continue
        index = 0
        period_ns = Fraction(1_000_000_000, rate)
        while True:
            # Predetermined phase offsets diversify relative GET/PATCH alignment.
            perturbation = Fraction(((index * 73) % 17) - 8, 64) if method == 'PATCH' and index else 0
            planned = phase_ns + int((index + perturbation) * period_ns)
            if planned >= duration * 1_000_000_000:
                break
            slot = index % level if method == 'GET' else 0
            spec.append((planned, method, slot, index))
            index += 1
    return sorted(spec)


async def operate(*, args, ctx, connection, db_path, request, writer, patient_id, version,
                  initial_age, prior_patch_events, initial_audited_total):
    level = args.sessions
    schedule = timeline(args.open_seconds, level, Fraction(args.get_hz), Fraction(args.patch_hz))
    gate = asyncio.Event()
    gate.set()
    # Warm identical request paths before establishing the measurement clock.
    warm = []
    for _ in range(args.warmup):
        warm.extend(await asyncio.gather(*(request(i, gate, asyncio.Event()) for i in range(level))))
    start = time.perf_counter_ns() + 100_000_000
    active = {}
    receipts = []
    results = {}
    current_age = initial_age
    starting_version = version
    patch_success = 0
    patch_state_unconfirmed = False
    cpu_start = time.process_time_ns()
    usage_start = resource.getrusage(resource.RUSAGE_SELF)

    async def patch():
        nonlocal current_age, version, patch_success, patch_state_unconfirmed
        value = 47 if current_age == 46 else 46
        sample = {'native': [], 'validation_ns': [], 'fallback_ns': [], 'event_ids': [],
                  'sql': 0, 'select': 0, 'clinical': True, 'expected_fixture_version': version}
        token = ctx.set(sample)
        try:
            reply = await asyncio.wait_for(writer.patch('/api/patients/' + patient_id,
                json={'field': 'age', 'value': value, 'expectedVersion': version},
                headers={'x-csrf-token': writer.cookies['clinic_csrf']}), timeout=8)
            sample['status'] = reply.status_code
            if reply.status_code == 200:
                try:
                    returned = reply.json()['version']
                except (KeyError, TypeError, ValueError):
                    returned = None
                if returned != version + 1:
                    sample['version_step_verified'] = False
                    patch_state_unconfirmed = True
                else:
                    sample['version_step_verified'] = True
                    sample['returned_fixture_version'] = returned
                    version, current_age = returned, value
                    patch_success += 1
            elif any(row.get('end') == 'COMMIT' and row['kind'] == 'clinical_write' for row in sample['native']):
                patch_state_unconfirmed = True
        except TimeoutError:
            sample['status'] = 'timeout'
            patch_state_unconfirmed = True
        finally:
            ctx.reset(token)
        return sample

    async def run(record, key):
        dispatch_ns = time.perf_counter_ns() - start
        if dispatch_ns >= args.open_seconds * 1_000_000_000:
            record['status'] = 'window_elapsed'
            active.pop(key, None)
            return
        record['dispatch_ns'] = dispatch_ns
        try:
            if record['method'] == 'PATCH':
                sample = await patch()
            else:
                sample = await asyncio.wait_for(request(record['slot'], gate, asyncio.Event()), timeout=8)
        except TimeoutError:
            sample = {'status': 'timeout', 'event_ids': [], 'native': []}
        finally:
            record['completion_ns'] = time.perf_counter_ns() - start
            active.pop(key, None)
        results[record['event']] = sample
        record['status'] = sample['status']
        record['deadline_missed'] = record['dispatch_ns'] - record['scheduled_ns'] > 20_000_000

    tasks = []
    for event, (offset, method, slot, index) in enumerate(schedule):
        await asyncio.sleep(max(0, (start + offset - time.perf_counter_ns()) / 1e9))
        observed = time.perf_counter_ns() - start
        key = (method, slot)
        record = dict(event=event, scheduled_ns=offset, scheduler_observed_ns=observed,
                      method=method, slot=slot, method_index=index, dispatch_ns=None,
                      completion_ns=None, deadline_missed=True)
        receipts.append(record)
        if key in active:
            record['status'] = 'client_busy'
        elif method == 'PATCH' and patch_state_unconfirmed:
            record['status'] = 'writer_state_unconfirmed'
        elif observed >= args.open_seconds * 1_000_000_000:
            record['status'] = 'window_elapsed'
        else:
            task = asyncio.create_task(run(record, key))
            tasks.append(task)
            active[key] = task
    await asyncio.gather(*tasks)
    wall_end = time.perf_counter_ns()
    cpu_end = time.process_time_ns()
    usage_end = resource.getrusage(resource.RUSAGE_SELF)
    verified_ids = set()
    patch_ids = set()
    patch_detail_ok = True
    count_200 = 0
    def verification(sample, verifier):
        ids = sample.pop('event_ids', [])
        digest = sample.pop('digest', None)
        if sample['status'] != 200:
            if sample['status'] == 'timeout':
                return None if not ids else False
            return not ids and not sample.get('response_contains_synthetic_patient', False)
        if len(ids) != 1 or ids[0] in verified_ids or not sample.get('scope_ok'):
            return False
        row = verifier.execute(
            "SELECT m.snapshot_sha256 FROM read_access_manifests m JOIN audit_events a ON a.id=m.audit_event_id "
            "WHERE a.id=? AND a.event_type='medical_read_release' AND a.result='ok'", (ids[0],)).fetchone()
        verified_ids.add(ids[0])
        return row is not None and row[0] == digest
    reads_ok = True
    warm_statuses = [sample['status'] for sample in warm]
    with connection(db_path) as verifier:
        for sample in warm:
            reads_ok = verification(sample, verifier) is not False and reads_ok
            count_200 += int(sample['status'] == 200)
        for record in receipts:
            sample = results.get(record['event'])
            if sample is None:
                continue
            if record['method'] == 'GET':
                record['audit_manifest_or_no_payload'] = verification(sample, verifier)
                reads_ok = record['audit_manifest_or_no_payload'] is not False and reads_ok
                count_200 += int(sample['status'] == 200)
            else:
                sample.pop('event_ids', None)
                identifiers = sample.pop('private_patch_audit_rowids', [])
                clinical_commits = [item for item in sample['native']
                                    if item['kind'] == 'clinical_write' and item.get('end') == 'COMMIT']
                if record['status'] == 200:
                    committed = (len(clinical_commits) == len(identifiers) == 1
                                 and identifiers[0] not in patch_ids
                                 and sample.get('version_step_verified') is True)
                    if committed:
                        audit = verifier.execute(
                            'SELECT event_type, result, detail, patient_id FROM audit_events WHERE id=?',
                            (identifiers[0],)).fetchone()
                        committed = audit is not None and tuple(audit) == ('patient_updated', 'ok', 'field=age', patient_id)
                        patch_ids.add(identifiers[0])
                    record['clinical_audit_commit_verified'] = committed
                    patch_detail_ok = patch_detail_ok and committed
                elif clinical_commits:
                    record['clinical_audit_commit_verified'] = False
                    patch_detail_ok = False
            for key in ('native', 'schema_functions_ns', 'schema_catalog_statements', 'sql', 'select',
                        'release_admission_path', 'known_conflict', 'scope_ok', 'snapshot_ready_ns',
                        'asgi_start_ns', 'asgi_end_ns', 'phase_timing', 'release_order_ns',
                        'validation_ns', 'fallback_ns', 'writer_object_outside_page', 'read_snapshots', 'fingerprint_build',
                        'asgi_response_start_ns', 'asgi_response_body_end_ns', 'conflict_code',
                        'release_versions', 'fingerprint_validation', 'fresh_reader', 'release_persist',
                        'clinical_store', 'result_projection', 'patch_endpoint_worker',
                        'expected_fixture_version', 'returned_fixture_version', 'version_step_verified',
                        'other_write_evidence'):
                if key in sample:
                    record[key] = sample[key]
        audited_total, paired_total = verifier.execute(
            "SELECT count(*), count(m.audit_event_id) FROM audit_events a LEFT JOIN read_access_manifests m "
            "ON m.audit_event_id=a.id WHERE a.event_type='medical_read_release' AND a.result='ok'").fetchone()
        final_version, final_age = verifier.execute("SELECT version, age FROM patients WHERE id=?",
                                                  (patient_id,)).fetchone()
        final_audits = verifier.execute("SELECT count(*) FROM audit_events WHERE event_type='patient_updated' "
                                        "AND patient_id=?", (patient_id,)).fetchone()[0]
    audit_ok = reads_ok and audited_total == paired_total == initial_audited_total + count_200
    patch_ok = (patch_detail_ok and final_version == starting_version + patch_success
                and final_age == current_age and final_audits - prior_patch_events == patch_success)
    from request_diagnostics import classify_conflicts
    classify_conflicts(receipts)
    args.open_result = {
        'events': receipts, 'get_hz_per_session': args.get_hz, 'patch_hz': args.patch_hz,
        'duration_seconds': args.open_seconds, 'start_monotonic_ns': start,
        'read_audit_manifest_verified': audit_ok, 'clinical_version_age_audit_verified': patch_ok,
        'process_cpu_ns': cpu_end - cpu_start, 'process_cpu_wall_ns': wall_end - (start - 100_000_000),
        'actual_clinical_changes': final_version - starting_version,
        'clinical_audit_events': final_audits - prior_patch_events, 'warmup_outcomes': warm_statuses,
        'verified_individual_clinical_audits': len(patch_ids),
        'clinical_chain_uncertain': patch_state_unconfirmed,
        'process_voluntary_context_switches': usage_end.ru_nvcsw - usage_start.ru_nvcsw,
        'process_involuntary_context_switches': usage_end.ru_nivcsw - usage_start.ru_nivcsw,
    }
    args.measured_window_ns = args.open_seconds * 1_000_000_000
