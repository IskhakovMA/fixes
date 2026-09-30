"""Management analytics API.

Read-only endpoints. Every response is computed server-side inside the current
patient scope; filters cannot expand visibility.
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response

from .. import audit, policy
from ..analytics import schemas, service
from ..analytics.filters import AnalyticsFilters, analytics_filters
from ..deps import abuse_rate_limit, get_db, require_active_password, require_csrf

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/pulse", response_model=schemas.ExecutivePulseOut)
def pulse(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.pulse(conn, user, filters)


@router.get("/summary", response_model=schemas.AnalyticsSummaryOut)
def summary(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.summary(conn, user, filters)


@router.get("/dashboard", response_model=schemas.AnalyticsDashboardOut)
def dashboard(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.dashboard(conn, user, filters)


@router.get("/stages", response_model=schemas.AnalyticsStagesOut)
def stages(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.stages(conn, user, filters)


@router.get("/overdue", response_model=schemas.AnalyticsOverdueOut)
def overdue(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.overdue(conn, user, filters)


@router.get("/stage-durations", response_model=schemas.StageDurationOut)
def stage_durations(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.stage_durations(conn, user, filters)


@router.get("/workload", response_model=schemas.WorkloadOut)
def workload(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.workload(conn, user, filters)


@router.get("/data-quality", response_model=schemas.DataQualityAnalyticsOut)
def data_quality(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.data_quality_state(conn, user, filters)


@router.get("/checklists", response_model=schemas.ChecklistAnalyticsOut)
def checklists(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.checklists(conn, user, filters)


@router.get("/notifications", response_model=schemas.NotificationsAnalyticsOut)
def notifications(
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    return service.notifications_state(conn, user, filters)


@router.get("/details", response_model=schemas.DetailsOut)
def details(
    type: str = Query(..., max_length=60),
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    try:
        return service.details(conn, user, filters, type)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc


@router.post("/export", dependencies=[Depends(require_csrf), Depends(abuse_rate_limit("analytics_export", 20))])
def export(
    body: schemas.AnalyticsExportIn,
    filters: AnalyticsFilters = Depends(analytics_filters),
    conn: sqlite3.Connection = Depends(get_db),
    user: policy.CurrentUser = Depends(require_active_password),
):
    try:
        result = service.export_csv(
            conn,
            user,
            filters,
            report_type=body.reportType,
            detail_level=body.detailLevel,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    audit.record(
        conn,
        audit.ANALYTICS_REPORT_EXPORTED,
        detail=(
            f"report_type={body.reportType} detail_level={body.detailLevel} "
            f"row_count={result['row_count']} format=csv "
            f"department_id={filters.department_id or ''} doctor_user_id={filters.doctor_user_id or ''} "
            f"stage={filters.stage or ''}"
        ),
        **audit.actor_ctx(user),
    )
    return Response(
        content=result["content"],
        media_type=result["content_type"],
        headers={"Content-Disposition": f'attachment; filename="{result["filename"]}"'},
    )
