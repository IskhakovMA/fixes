"""Импорт и экспорт. Оба ограничены областью видимости актора:
экспорт фильтруется тем же scope-условием, что и список пациентов;
импорт не может закрепить пациента за врачом вне scope актора.
"""
import json
import sqlite3
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from .. import audit, config, importexport, policy, store
from ..deps import abuse_rate_limit, get_db, require_active_password, require_csrf
from ..models import ImportCommitRequest, ImportPreviewRequest

router = APIRouter(prefix="/api", tags=["import-export"])


def _deny(conn: sqlite3.Connection, user: policy.CurrentUser, detail: str):
    audit.record(conn, audit.ACCESS_DENIED, result=audit.RESULT_DENIED,
                 detail=detail, **audit.actor_ctx(user))
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


@router.post("/import/preview", dependencies=[Depends(abuse_rate_limit("import_preview", 20))])
def import_preview(
    body: ImportPreviewRequest,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    if not policy.can_import(user):
        _deny(conn, user, "action=import")
    try:
        document, errors = importexport.validate_import(body.raw)
    except importexport.ImportStructureError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if document is None:
        return {"valid": False, "errors": errors}
    scope_errors = importexport.scope_errors(conn, document, user)
    if scope_errors:
        return {"valid": False, "errors": scope_errors}
    report = importexport.preview_report(conn, document)
    return {"valid": True, "errors": [], **report}


@router.post("/import/commit", dependencies=[Depends(require_csrf), Depends(abuse_rate_limit("import_commit", 10))])
def import_commit(
    body: ImportCommitRequest,
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    if not policy.can_import(user, body.mode):
        _deny(conn, user, f"action=import mode={body.mode}")
    ctx = audit.actor_ctx(user)
    try:
        document, errors = importexport.validate_import(body.raw)
    except importexport.ImportStructureError as e:
        audit.record(conn, audit.IMPORT_COMMITTED, result=audit.RESULT_DENIED,
                     detail=f"mode={body.mode} structure_rejected", **ctx)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if document is None:
        audit.record(conn, audit.IMPORT_COMMITTED, result=audit.RESULT_DENIED,
                     detail=f"mode={body.mode} invalid_records={len(errors)}", **ctx)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"errors": errors})
    scope_errors = importexport.scope_errors(conn, document, user)
    if scope_errors:
        audit.record(conn, audit.IMPORT_COMMITTED, result=audit.RESULT_DENIED,
                     detail=f"mode={body.mode} scope_rejected={len(scope_errors)}", **ctx)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                            detail={"errors": scope_errors})
    result = importexport.commit_import(conn, document, body.mode, user)
    audit.record(
        conn, audit.IMPORT_COMMITTED,
        detail=f"mode={body.mode} added={result['added']} updated={result['updated']} skipped={result['skipped']}",
        **ctx,
    )
    return result


def _safe_export_filename() -> str:
    return f"patients_export_{date.today().isoformat()}.json"


# GET, но с обязательным X-CSRF-Token: SameSite=Lax cookie отправляется и при
# межсайтовой навигации верхнего уровня, а навигация не может задать заголовок.
@router.get("/export", dependencies=[Depends(require_csrf)])
def export_patients(
    ids: str | None = Query(None, description="Comma-separated patient ids; omit for all"),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    if not policy.can_export(user):
        _deny(conn, user, "action=export")
    # Экспорт всегда фильтруется scope на сервере: изменённые frontend-параметры
    # (чужие ids) молча отбрасываются тем же условием, что и список пациентов.
    scoped = store.list_patients(conn, policy.patient_scope_filter(user))
    if ids:
        wanted = {i for i in ids.split(",") if i}
        selected = [p for p in scoped if p["id"] in wanted]
    else:
        selected = scoped
    exported = []
    for patient in selected:
        row = dict(patient)
        # `attention` is a live UI summary for the current user scope, not part
        # of the import/export patient record format. Historical attention
        # issues remain in the database and backups.
        row.pop("attention", None)
        exported.append(row)

    payload = {
        "schemaVersion": config.SCHEMA_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "patients": exported,
    }
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    audit.record(conn, audit.EXPORT, detail=f"records={len(exported)}",
                 **audit.actor_ctx(user))
    return Response(
        content=body,
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="{_safe_export_filename()}"',
            "Cache-Control": "no-store",
        },
    )
