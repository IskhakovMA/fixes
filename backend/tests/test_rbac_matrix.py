"""Матрица прав доступа. Все сущности вымышленные — реальные ФИО
сотрудников в тестах не используются.

Схема стенда:
  отделение A: врач A1, врач A2, заведующий A
  отделение B: врач B1, заведующий B
  глобальные: разработчик, зам. главврача (read-only), заведующий ЦАОП (read-only)
  пациенты: у A1, у A2, у B1 и один несопоставленный (unresolved)
"""
import pytest

from .conftest import (
    TEST_PASSWORD,
    create_account,
    create_department,
    get_conn,
    login,
    make_patient_payload,
)


@pytest.fixture()
def rbac(client):
    """Стенд с отделениями, ролями и пациентами. Возвращает словарь id."""
    from backend.app import store, users
    ids = {}
    ids["dept_a"] = create_department("Отделение А (тестовое)")
    ids["dept_b"] = create_department("Отделение Б (тестовое)")

    ids["developer"] = create_account("dev.rbac", "developer", "Разработчиков Тест")
    ids["deputy"] = create_account("deputy.rbac", "deputy_chief_oncology", "Замов Глобальный")
    ids["caop"] = create_account("caop.rbac", "caop_head", "Цаопов Просмотр")
    ids["head_a"] = create_account("head.a", "department_head", "Заведуев А", department_ids=[ids["dept_a"]])
    ids["head_b"] = create_account("head.b", "department_head", "Заведуев Б", department_ids=[ids["dept_b"]])
    ids["doc_a1"] = create_account("doc.a1", "doctor", "Врачёв А-Первый", department_ids=[ids["dept_a"]])
    ids["doc_a2"] = create_account("doc.a2", "doctor", "Врачёв А-Второй", department_ids=[ids["dept_a"]])
    ids["doc_b1"] = create_account("doc.b1", "doctor", "Врачёв Б-Первый", department_ids=[ids["dept_b"]])

    conn = get_conn()
    from backend.app.models import PatientCreateIn

    def mk(name, doctor_id):
        data = PatientCreateIn(**make_patient_payload(name=name))
        return store.create_patient(conn, data, doctor_id)

    ids["p_a1"] = mk("Пациентов А-Один", ids["doc_a1"])
    ids["p_a2"] = mk("Пациентов А-Два", ids["doc_a2"])
    ids["p_b1"] = mk("Пациентов Б-Один", ids["doc_b1"])
    ids["p_unresolved"] = mk("Пациентов Без-Врача", None)
    return ids


def as_user(client, username):
    r = login(client, username)
    assert r.status_code == 200
    return client


def patient_names(client):
    return {p["name"] for p in client.get("/api/patients").json()}


# --- Разработчик ---------------------------------------------------------

def test_developer_sees_and_edits_everything(client, rbac):
    as_user(client, "dev.rbac")
    names = patient_names(client)
    assert names == {"Пациентов А-Один", "Пациентов А-Два", "Пациентов Б-Один", "Пациентов Без-Врача"}
    # изменение любого пациента
    r = client.patch(f"/api/patients/{rbac['p_b1']}",
                     json={"field": "age", "value": 61}, headers=client.csrf)
    assert r.status_code == 200
    # unresolved видим и открывается
    assert client.get(f"/api/patients/{rbac['p_unresolved']}").status_code == 200
    # список несопоставленных доступен
    unresolved = client.get("/api/patients/unresolved").json()["patients"]
    assert [p["id"] for p in unresolved] == [rbac["p_unresolved"]]


def test_developer_manages_users_and_departments(client, rbac):
    as_user(client, "dev.rbac")
    assert client.get("/api/users").status_code == 200
    assert client.get("/api/departments").status_code == 200


# --- Глобальные read-only роли -------------------------------------------

@pytest.mark.parametrize("username", ["deputy.rbac", "caop.rbac"])
def test_readonly_roles_see_all_but_cannot_write(client, rbac, username):
    as_user(client, username)
    # видят всех, включая unresolved
    assert len(patient_names(client)) == 4
    assert client.get(f"/api/patients/{rbac['p_a1']}").status_code == 200

    csrf = client.csrf
    # создание запрещено
    r = client.post("/api/patients", json=make_patient_payload(), headers=csrf)
    assert r.status_code == 403
    # изменение запрещено
    assert client.patch(f"/api/patients/{rbac['p_a1']}",
                        json={"field": "age", "value": 70}, headers=csrf).status_code == 403
    # удаление запрещено
    assert client.delete(f"/api/patients/{rbac['p_a1']}", headers=csrf).status_code == 403
    # смена этапа запрещена
    assert client.post(f"/api/patients/{rbac['p_a1']}/stage",
                       json={"newStage": "appointment"}, headers=csrf).status_code == 403
    # события, заметки, чек-листы запрещены; старый endpoint будущих планов удалён
    assert client.post(f"/api/patients/{rbac['p_a1']}/history/0/events", headers=csrf).status_code == 403
    assert client.patch(f"/api/patients/{rbac['p_a1']}/history/0/note",
                        json={"note": "x"}, headers=csrf).status_code == 403
    assert client.patch(f"/api/patients/{rbac['p_a1']}/history/0/checklist",
                        json={"item": "Тест", "checked": True}, headers=csrf).status_code == 403
    assert client.put(f"/api/patients/{rbac['p_a1']}/future-plans/0",
                      json={"field": "date", "value": "2026-08-01"}, headers=csrf).status_code == 404
    # импорт запрещён
    assert client.post("/api/import/preview", json={"raw": "[]"}).status_code == 403
    assert client.post("/api/import/commit",
                       json={"raw": "[]", "mode": "add"}, headers=csrf).status_code == 403
    # экспорт запрещён (массовый экспорт read-only ролям не предоставляется)
    assert client.get("/api/export", headers=client.csrf).status_code == 403
    # управление сотрудниками и структурой запрещено
    assert client.get("/api/users").status_code == 403
    assert client.get("/api/departments").status_code == 403
    # системный аудит недоступен
    assert client.get("/api/audit").status_code == 403
    # смена лечащего врача запрещена
    assert client.put(f"/api/patients/{rbac['p_a1']}/treating-doctor",
                      json={"userId": rbac["doc_b1"]}, headers=csrf).status_code == 403


# --- Заведующий отделением -----------------------------------------------

def test_head_scope_limited_to_own_departments(client, rbac):
    as_user(client, "head.a")
    names = patient_names(client)
    # видит пациентов врачей A1 и A2, не видит B1 и unresolved
    assert names == {"Пациентов А-Один", "Пациентов А-Два"}
    # может изменять пациентов своего отделения
    assert client.patch(f"/api/patients/{rbac['p_a1']}",
                        json={"field": "age", "value": 55}, headers=client.csrf).status_code == 200
    assert client.patch(f"/api/patients/{rbac['p_a2']}",
                        json={"field": "age", "value": 56}, headers=client.csrf).status_code == 200
    # чужой пациент по прямому ID неотличим от несуществующего
    assert client.get(f"/api/patients/{rbac['p_b1']}").status_code == 404
    assert client.patch(f"/api/patients/{rbac['p_b1']}",
                        json={"field": "age", "value": 99}, headers=client.csrf).status_code == 404
    assert client.delete(f"/api/patients/{rbac['p_b1']}", headers=client.csrf).status_code == 404
    # unresolved не виден заведующему
    assert client.get(f"/api/patients/{rbac['p_unresolved']}").status_code == 404
    # экспорт отфильтрован scope даже при подмене ids
    import json as _json
    doc = _json.loads(client.get(f"/api/export?ids={rbac['p_b1']}", headers=client.csrf).text)
    assert doc["patients"] == []
    doc = _json.loads(client.get("/api/export", headers=client.csrf).text)
    assert {p["name"] for p in doc["patients"]} == {"Пациентов А-Один", "Пациентов А-Два"}
    # управление сотрудниками/структурой запрещено
    assert client.get("/api/users").status_code == 403
    assert client.get("/api/departments").status_code == 403
    # список несопоставленных запрещён
    assert client.get("/api/patients/unresolved").status_code == 403


def test_head_creates_patient_only_with_own_department_doctor(client, rbac):
    as_user(client, "head.a")
    # врач своего отделения — можно
    r = client.post("/api/patients",
                    json=make_patient_payload(name="Новый Пациентов А", treatingDoctorUserId=rbac["doc_a1"]),
                    headers=client.csrf)
    assert r.status_code == 201
    assert r.json()["treatingDoctorUserId"] == rbac["doc_a1"]
    # врач другого отделения — нельзя
    r = client.post("/api/patients",
                    json=make_patient_payload(name="Чужой Пациентов", treatingDoctorUserId=rbac["doc_b1"]),
                    headers=client.csrf)
    assert r.status_code == 403
    # без врача — нельзя (пациент не должен выпасть из области видимости)
    r = client.post("/api/patients", json=make_patient_payload(name="Безврачёв"), headers=client.csrf)
    assert r.status_code == 403
    # менять лечащего врача заведующий не может
    assert client.put(f"/api/patients/{rbac['p_a1']}/treating-doctor",
                      json={"userId": rbac["doc_a2"]}, headers=client.csrf).status_code == 403


def test_head_of_two_departments_sees_both(client, rbac):
    from backend.app import users
    conn = get_conn()
    # заведующий A получает и отделение Б
    conn.execute(
        "INSERT INTO department_heads (user_id, department_id, created_at) VALUES (?, ?, ?)",
        (rbac["head_a"], rbac["dept_b"], users.now_iso()),
    )
    conn.commit()
    as_user(client, "head.a")
    assert patient_names(client) == {"Пациентов А-Один", "Пациентов А-Два", "Пациентов Б-Один"}


# --- Врач -----------------------------------------------------------------

def test_doctor_sees_only_own_patients_even_same_department(client, rbac):
    as_user(client, "doc.a1")
    # только собственный пациент; коллега из ТОГО ЖЕ отделения не виден
    assert patient_names(client) == {"Пациентов А-Один"}
    assert client.get(f"/api/patients/{rbac['p_a2']}").status_code == 404
    assert client.get(f"/api/patients/{rbac['p_b1']}").status_code == 404
    assert client.get(f"/api/patients/{rbac['p_unresolved']}").status_code == 404
    # изменять чужого нельзя (404 — существование не раскрывается)
    assert client.patch(f"/api/patients/{rbac['p_a2']}",
                        json={"field": "age", "value": 33}, headers=client.csrf).status_code == 404
    # свой пациент — полный CRUD
    assert client.patch(f"/api/patients/{rbac['p_a1']}",
                        json={"field": "age", "value": 45}, headers=client.csrf).status_code == 200
    # экспорт — только свои
    import json as _json
    doc = _json.loads(client.get("/api/export", headers=client.csrf).text)
    assert {p["name"] for p in doc["patients"]} == {"Пациентов А-Один"}
    # аудит и администрирование закрыты
    assert client.get("/api/audit").status_code == 403
    assert client.get("/api/users").status_code == 403
    assert client.get("/api/departments").status_code == 403


def test_doctor_creates_patient_pinned_to_self(client, rbac):
    as_user(client, "doc.a1")
    # без указания врача — закрепляется за собой
    r = client.post("/api/patients", json=make_patient_payload(name="Свой Пациентов"), headers=client.csrf)
    assert r.status_code == 201
    assert r.json()["treatingDoctorUserId"] == rbac["doc_a1"]
    # выбрать коллегу нельзя
    r = client.post("/api/patients",
                    json=make_patient_payload(name="Коллегин Пациентов", treatingDoctorUserId=rbac["doc_a2"]),
                    headers=client.csrf)
    assert r.status_code == 403
    # менять лечащего врача нельзя
    assert client.put(f"/api/patients/{rbac['p_a1']}/treating-doctor",
                      json={"userId": rbac["doc_a2"]}, headers=client.csrf).status_code == 403
    # legacy-текст врача тоже менять нельзя
    assert client.patch(f"/api/patients/{rbac['p_a1']}",
                        json={"field": "doctor", "value": "Самозванцев"}, headers=client.csrf).status_code == 403


# --- Смена лечащего врача -------------------------------------------------

def test_treating_doctor_change_moves_scope_immediately(client, rbac):
    # Разработчик переводит пациента A1 → B1
    as_user(client, "dev.rbac")
    r = client.put(f"/api/patients/{rbac['p_a1']}/treating-doctor",
                   json={"userId": rbac["doc_b1"]}, headers=client.csrf)
    assert r.status_code == 200
    assert r.json()["treatingDoctorUserId"] == rbac["doc_b1"]

    # A1 немедленно теряет доступ
    as_user(client, "doc.a1")
    assert client.get(f"/api/patients/{rbac['p_a1']}").status_code == 404
    # B1 немедленно получает доступ
    as_user(client, "doc.b1")
    assert client.get(f"/api/patients/{rbac['p_a1']}").status_code == 200
    # заведующий A теряет, заведующий B получает
    as_user(client, "head.a")
    assert client.get(f"/api/patients/{rbac['p_a1']}").status_code == 404
    as_user(client, "head.b")
    assert client.get(f"/api/patients/{rbac['p_a1']}").status_code == 200
    # глобальные роли продолжают видеть
    as_user(client, "deputy.rbac")
    assert client.get(f"/api/patients/{rbac['p_a1']}").status_code == 200
    # аудит содержит событие
    as_user(client, "dev.rbac")
    events = client.get("/api/audit?limit=200").json()["events"]
    assert any(e["event_type"] == "treating_doctor_changed" for e in events)


def test_unresolved_assignment_by_developer(client, rbac):
    as_user(client, "dev.rbac")
    r = client.put(f"/api/patients/{rbac['p_unresolved']}/treating-doctor",
                   json={"userId": rbac["doc_a1"]}, headers=client.csrf)
    assert r.status_code == 200
    # очередь несопоставленных опустела
    assert client.get("/api/patients/unresolved").json()["patients"] == []
    # врач A1 теперь видит пациента
    as_user(client, "doc.a1")
    assert client.get(f"/api/patients/{rbac['p_unresolved']}").status_code == 200


# --- Блокировка -----------------------------------------------------------

def test_blocking_terminates_sessions_and_forbids_login(client, rbac):
    as_user(client, "doc.a1")
    assert client.get("/api/patients").status_code == 200
    doc_cookies = dict(client.cookies)

    as_user(client, "dev.rbac")
    r = client.patch(f"/api/users/{rbac['doc_a1']}", json={"status": "blocked"}, headers=client.csrf)
    assert r.status_code == 200

    # существующая сессия врача мертва
    client.cookies.clear()
    for k, v in doc_cookies.items():
        client.cookies.set(k, v)
    assert client.get("/api/patients").status_code == 401
    # новый вход запрещён
    client.cookies.clear()
    assert login(client, "doc.a1").status_code == 401

    # разблокировка не воскрешает старые сессии
    login(client, "dev.rbac")
    client.patch(f"/api/users/{rbac['doc_a1']}", json={"status": "active"}, headers=client.csrf)
    client.cookies.clear()
    for k, v in doc_cookies.items():
        client.cookies.set(k, v)
    assert client.get("/api/patients").status_code == 401
    # но новый вход снова возможен
    client.cookies.clear()
    assert login(client, "doc.a1").status_code == 200


# --- Прямые и косвенные утечки -------------------------------------------

def test_no_indirect_leaks(client, rbac):
    as_user(client, "doc.a1")
    # единое поведение для недоступного и несуществующего пациента
    missing = client.get("/api/patients/does-not-exist")
    foreign = client.get(f"/api/patients/{rbac['p_b1']}")
    assert missing.status_code == foreign.status_code == 404
    assert missing.json() == foreign.json()
    # вложенные endpoints не обходят scope
    assert client.post(f"/api/patients/{rbac['p_b1']}/history/0/events",
                       headers=client.csrf).status_code == 404
    assert client.patch(f"/api/patients/{rbac['p_b1']}/history/0/note",
                        json={"note": "x"}, headers=client.csrf).status_code == 404
    assert client.put(f"/api/patients/{rbac['p_b1']}/future-plans/0",
                      json={"field": "date", "value": "2026-08-01"}, headers=client.csrf).status_code == 404
    # чужие ФИО не приходят в списке (поиск/статистика/календарь строятся из него)
    body = client.get("/api/patients").text
    assert "Пациентов Б-Один" not in body
    assert "Пациентов А-Два" not in body
    # селект врачей пуст для врача (чужие врачи не раскрываются)
    assert client.get("/api/users/doctors").json()["doctors"] == []


def test_head_doctor_select_limited_to_own_departments(client, rbac):
    as_user(client, "head.a")
    doctors = {d["id"] for d in client.get("/api/users/doctors").json()["doctors"]}
    assert doctors == {rbac["doc_a1"], rbac["doc_a2"]}


# --- Импорт по scope ------------------------------------------------------

def test_import_scope_enforced(client, rbac):
    import json as _json
    # врач: запись с чужим врачом отклоняется, без врача — закрепляется за собой
    as_user(client, "doc.a1")
    ok_doc = _json.dumps([make_patient_payload(name="Импортов Свой")], ensure_ascii=False)
    r = client.post("/api/import/commit", json={"raw": ok_doc, "mode": "add"}, headers=client.csrf)
    assert r.status_code == 200 and r.json()["added"] == 1
    foreign = _json.dumps(
        [dict(make_patient_payload(name="Импортов Чужой"), treatingDoctorUserId=rbac["doc_b1"])],
        ensure_ascii=False,
    )
    r = client.post("/api/import/commit", json={"raw": foreign, "mode": "add"}, headers=client.csrf)
    assert r.status_code == 422
    # режимы update/replace врачу недоступны
    assert client.post("/api/import/commit",
                       json={"raw": ok_doc, "mode": "replace"}, headers=client.csrf).status_code == 403
    assert client.post("/api/import/commit",
                       json={"raw": ok_doc, "mode": "update"}, headers=client.csrf).status_code == 403

    # заведующий: врач чужого отделения — отказ, своего — успех
    as_user(client, "head.a")
    bad = _json.dumps(
        [dict(make_patient_payload(name="Импортов Не-Тот"), treatingDoctorUserId=rbac["doc_b1"])],
        ensure_ascii=False,
    )
    assert client.post("/api/import/commit",
                       json={"raw": bad, "mode": "add"}, headers=client.csrf).status_code == 422
    good = _json.dumps(
        [dict(make_patient_payload(name="Импортов Тот"), treatingDoctorUserId=rbac["doc_a2"])],
        ensure_ascii=False,
    )
    r = client.post("/api/import/commit", json={"raw": good, "mode": "add"}, headers=client.csrf)
    assert r.status_code == 200 and r.json()["added"] == 1

    # разработчик: запись без врача остаётся unresolved
    as_user(client, "dev.rbac")
    plain = _json.dumps([make_patient_payload(name="Импортов Неразрешённый")], ensure_ascii=False)
    r = client.post("/api/import/commit", json={"raw": plain, "mode": "add"}, headers=client.csrf)
    assert r.status_code == 200
    unresolved_names = {p["name"] for p in client.get("/api/patients/unresolved").json()["patients"]}
    assert "Импортов Неразрешённый" in unresolved_names
