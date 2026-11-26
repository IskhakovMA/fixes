"""Defense checks for the isolated F7 proposal, using only synthetic fixtures."""
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from threading import Barrier

import httpx
import pytest
from fastapi.testclient import TestClient

from .conftest import DEV_USERNAME, consilium_grid, create_account, get_conn, login
from .test_consilium_appointments import appointment_payload, create_patient


DAY = '2026-11-12'
PATH = '/api/consilium/appointments'
ACTIONS = {
    'review': {},
    'sign': {'treatmentType': 'surgery'},
    'return': {'comment': 'Синтетическая доработка F7'},
}
AUDIT = {
    'review': 'consilium_review_started',
    'sign': 'consilium_signed',
    'return': 'consilium_returned_for_revision',
}
VERSION_CONFLICT = 'consilium_version_conflict'


@pytest.fixture
def record(client):
    create_account(DEV_USERNAME, 'developer')
    create_account('chair.f7.one', 'consilium_chair')
    create_account('chair.f7.two', 'consilium_chair')
    login(client, DEV_USERNAME)
    patient = create_patient(client, name='Синтетический Пациент F7')
    consilium_grid((DAY,), times=('10:30',), groups=('thoracic',))
    response = client.post(PATH, json=appointment_payload(patient['id']), headers=client.csrf)
    assert response.status_code == 201
    login(client, 'chair.f7.one')
    return response.json()


def act(client, record, action, *, with_version=True, with_csrf=True):
    body = dict(ACTIONS[action])
    if with_version:
        body['version'] = record['version']
    return client.post(f'{PATH}/{record["id"]}/{action}', json=body, headers=client.csrf if with_csrf else {})


def under_review(client, record):
    response = act(client, record, 'review')
    assert response.status_code == 200
    fresh = response.json()
    assert fresh['status'] == 'in_review' and fresh['version'] == record['version'] + 1
    return fresh


def persisted(record):
    conn = get_conn()
    row = conn.execute(
        '''SELECT a.*, p.stage AS current_patient_stage FROM oncology_consilium_appointments a
           JOIN patients p ON p.id = a.patient_id WHERE a.id = ?''', (record['id'],),
    ).fetchone()
    history = conn.execute(
        '''SELECT * FROM consilium_revision_history WHERE appointment_id = ? ORDER BY round''', (record['id'],),
    ).fetchall()
    audit = conn.execute(
        '''SELECT event_type, actor_user_id, detail FROM audit_events WHERE patient_id = ?
           AND event_type IN ('consilium_review_started', 'consilium_signed', 'consilium_returned_for_revision')
           ORDER BY id''', (record['patientId'],),
    ).fetchall()
    return dict(row), list(map(dict, history)), list(map(dict, audit))


@pytest.mark.parametrize('action', ACTIONS)
def test_version_required_and_csrf_unchanged(client, record, action):
    if action != 'review':
        record = under_review(client, record)
    before = persisted(record)
    assert act(client, record, action, with_version=False).status_code == 422
    assert act(client, record, action, with_csrf=False).status_code == 403
    assert persisted(record) == before


@pytest.mark.parametrize('action', ACTIONS)
def test_version_mismatch_does_not_change_state(client, record, action):
    if action != 'review':
        record = under_review(client, record)
    before = persisted(record)
    response = act(client, {**record, 'version': record['version'] + 1}, action)
    assert response.status_code == 409 and response.json()['code'] == VERSION_CONFLICT
    assert persisted(record) == before


def test_same_status_update_requires_new_version(client, record):
    login(client, DEV_USERNAME)
    response = client.put(f'{PATH}/{record["id"]}', json=appointment_payload(
        record['patientId'], version=record['version'], comment='Синтетическая корректировка F7',
    ), headers=client.csrf)
    assert response.status_code == 200
    assert response.json()['status'] == record['status']
    assert response.json()['version'] == record['version'] + 1
    login(client, 'chair.f7.one')
    before = persisted(record)
    response = act(client, record, 'review')
    assert response.status_code == 409 and response.json()['code'] == VERSION_CONFLICT
    assert persisted(record) == before


def test_matching_version_with_illegal_state_is_a_distinct_conflict(client, record):
    before = persisted(record)
    response = act(client, record, 'sign')
    assert response.status_code == 409 and 'code' not in response.json()
    assert persisted(record) == before


def test_unknown_object_is_neutral_and_role_is_checked(client, record):
    before = persisted(record)
    response = act(client, {**record, 'id': 'absent-synthetic-record'}, 'review')
    assert response.status_code == 404 and response.json() == {'detail': 'Appointment not found'}
    login(client, DEV_USERNAME)
    assert act(client, record, 'review').status_code == 403
    assert persisted(record) == before


def test_changed_role_is_rechecked_inside_transaction(client, record, monkeypatch):
    from backend.app import config, policy
    from backend.app.services import consilium

    perform = consilium.start_review
    entered = []

    def with_changed_role(conn, actor, *args, **kwargs):
        # Synthetic lifecycle fixture. Only the proposal's transaction is exercised.
        with sqlite3.connect(config.DB_PATH) as fixture:
            fixture.execute("UPDATE users SET role_id = 'developer' WHERE id = ?", (actor.id,))
        entered.append(policy.ROLE_CONSILIUM_CHAIR == actor.role_id)
        return perform(conn, actor, *args, **kwargs)

    monkeypatch.setattr(consilium, 'start_review', with_changed_role)
    before = persisted(record)
    response = act(client, record, 'review')
    assert entered == [True]
    assert response.status_code == 409
    assert response.json()['code'] == 'ACCESS_CONTEXT_CHANGED'
    assert persisted(record) == before


@pytest.mark.parametrize('actions', [('review', 'review'), ('return', 'return'), ('sign', 'return')])
def test_two_chair_actions_with_same_version_commit_once(client, record, actions):
    if actions[0] != 'review':
        record = under_review(client, record)
    before = persisted(record)
    start = Barrier(2, timeout=10)
    # Share the already running app while keeping an independent cookie jar.
    with closing(TestClient(client.app, base_url='http://127.0.0.1', raise_server_exceptions=False)) as second:
        login(second, 'chair.f7.two')

        def perform(actor, action):
            start.wait()
            return act(actor, record, action)

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(perform, actor, action) for actor, action in zip((client, second), actions)]
            responses = [future.result(timeout=15) for future in futures]
    assert sorted(response.status_code for response in responses) == [200, 409]
    succeeded, refused = sorted(responses, key=lambda response: response.status_code)
    assert refused.json()['code'] == VERSION_CONFLICT
    result = succeeded.json()
    assert result['version'] == record['version'] + 1
    after = persisted(record)
    assert after[0]['version'] == result['version']
    assert after[0]['current_patient_stage'] == before[0]['current_patient_stage']
    assert len(after[2]) == len(before[2]) + 1
    assert len(after[1]) - len(before[1]) == int(result['status'] == 'needs_revision')


@pytest.mark.parametrize('action', ACTIONS)
def test_mandatory_audit_outage_rolls_back_transition(client, record, monkeypatch, action):
    from backend.app import audit

    if action != 'review':
        record = under_review(client, record)
    before = persisted(record)
    write = audit.record_required_or_fail

    def fail_for_action(conn, event, **kwargs):
        if event == AUDIT[action]:
            raise audit.AuditWriteFailed()
        return write(conn, event, **kwargs)

    monkeypatch.setattr(audit, 'record_required_or_fail', fail_for_action)
    assert act(client, record, action).status_code == 503
    assert persisted(record) == before


def test_busy_transaction_refuses_without_state_change(client, record):
    from backend.app import config

    before = persisted(record)
    with sqlite3.connect(config.DB_PATH) as lock:
        lock.execute('BEGIN IMMEDIATE')
        response = act(client, record, 'review')
    assert response.status_code == 503 and 'занята' in response.json()['detail']
    assert persisted(record) == before


def test_sign_once_and_reconcile_an_unknown_response_by_reading(client, record):
    record = under_review(client, record)
    before = persisted(record)

    def lose_client_response():
        response = act(client, record, 'sign')
        assert response.status_code == 200  # The synthetic transport drops this after commit.
        raise httpx.ReadError('Synthetic loss after commit')

    with pytest.raises(httpx.ReadError):
        lose_client_response()
    response = client.get(PATH)
    assert response.status_code == 200
    fresh = next(item for item in response.json()['appointments'] if item['id'] == record['id'])
    assert fresh['status'] == 'signed' and fresh['version'] == record['version'] + 1
    signed = persisted(record)
    assert signed[0]['signed_at'] and signed[0]['current_patient_stage'] == before[0]['current_patient_stage']
    assert signed[2][-1]['event_type'] == AUDIT['sign']
    assert len(signed[2]) == len(before[2]) + 1
    repeat = act(client, record, 'sign')
    assert repeat.status_code == 409 and repeat.json()['code'] == VERSION_CONFLICT
    assert act(client, fresh, 'sign').status_code == 409
    assert persisted(record) == signed
