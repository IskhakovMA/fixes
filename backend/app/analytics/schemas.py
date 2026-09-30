"""Pydantic response schemas for management analytics."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class AnalyticsMeta(BaseModel):
    computed_at: str
    timezone: str
    scope: str
    filters: dict[str, Any] = Field(default_factory=dict)
    definitions: dict[str, str] = Field(default_factory=dict)


class MetricCard(BaseModel):
    code: str
    label: str
    value: int | float | str | None
    kind: Literal["current", "period"]
    unit: str = "count"
    detail_type: str | None = None
    definition: str


class AnalyticsSummaryOut(BaseModel):
    meta: AnalyticsMeta
    cards: list[MetricCard]


class PulseMetric(BaseModel):
    code: str
    label: str
    value: int | float | None
    unit: Literal["count", "percent"] = "count"
    detail_type: str
    definition: str
    numerator: int | None = None
    denominator: int | None = None


class PulseWorkspace(BaseModel):
    code: Literal["clinic_pulse", "department_contour", "my_day", "admin"]
    title: str
    subtitle: str


class ExecutivePulseOut(BaseModel):
    meta: AnalyticsMeta
    workspace: PulseWorkspace
    metrics: list[PulseMetric]


class DashboardChartRow(BaseModel):
    code: str | None = None
    label: str
    count: int
    percent: float = 0.0
    detail_type: str | None = None
    filter: dict[str, Any] = Field(default_factory=dict)
    meta: dict[str, Any] = Field(default_factory=dict)


class DashboardTrendRow(BaseModel):
    date: str
    label: str
    new_patients: int
    completed_patients: int = 0


class DashboardSection(BaseModel):
    title: str
    total: int = 0
    rows: list[DashboardChartRow] = Field(default_factory=list)


class AnalyticsDashboardOut(BaseModel):
    meta: AnalyticsMeta
    summary: AnalyticsSummaryOut
    stages: "AnalyticsStagesOut"
    profiles: DashboardSection
    route_state: DashboardSection
    data_quality: DashboardSection
    trend: dict[str, Any]
    workload: "WorkloadOut"
    attention: DashboardSection
    operations: DashboardSection


class StageRow(BaseModel):
    stage: str
    stage_label: str
    count: int
    percent: float
    overdue_patients: int
    quality_patients: int
    detail_type: str = "patients"


class AnalyticsStagesOut(BaseModel):
    meta: AnalyticsMeta
    total: int
    rows: list[StageRow]


class OverdueBucket(BaseModel):
    code: str
    label: str
    count: int


class OverdueItem(BaseModel):
    patient_id: str
    patient_name: str
    treating_doctor_name: str
    department_names: list[str] = Field(default_factory=list)
    event_type: str
    planned_date: str
    days_overdue: int
    stage: str
    stage_label: str


class AnalyticsOverdueOut(BaseModel):
    meta: AnalyticsMeta
    total: int
    buckets: list[OverdueBucket]
    by_doctor: list[dict[str, Any]]
    by_department: list[dict[str, Any]]
    items: list[OverdueItem]


class StageDurationStats(BaseModel):
    stage: str
    stage_label: str
    observations: int
    average_days: float | None = None
    median_days: float | None = None
    min_days: int | None = None
    max_days: int | None = None


class StageDurationOut(BaseModel):
    meta: AnalyticsMeta
    available: bool
    reason: str | None = None
    stats: list[StageDurationStats] = Field(default_factory=list)
    current_stage_age: list[dict[str, Any]] = Field(default_factory=list)


class WorkloadRow(BaseModel):
    doctor_user_id: str | None = None
    doctor_name: str
    department_ids: list[str] = Field(default_factory=list)
    department_names: list[str] = Field(default_factory=list)
    active_patients: int
    overdue_patients: int
    incomplete_required_checklists: int
    critical_quality_issues: int
    pending_notifications: int
    failed_notifications: int


class WorkloadOut(BaseModel):
    meta: AnalyticsMeta
    title: str
    rows: list[WorkloadRow]


class DataQualityAnalyticsOut(BaseModel):
    meta: AnalyticsMeta
    title: str
    current_state_only: bool
    summary: dict[str, Any]
    by_severity: list[dict[str, Any]]
    by_code: list[dict[str, Any]]
    by_doctor: list[dict[str, Any]]
    by_department: list[dict[str, Any]]


class ChecklistAnalyticsOut(BaseModel):
    meta: AnalyticsMeta
    formula: str
    total_required_items: int
    completed_required_items: int
    incomplete_required_items: int
    completion_percent: float | None
    status: str
    by_stage: list[dict[str, Any]]
    by_doctor: list[dict[str, Any]]
    by_department: list[dict[str, Any]]
    patients: list[dict[str, Any]]


class NotificationsAnalyticsOut(BaseModel):
    meta: AnalyticsMeta
    provider: str
    status_counts: dict[str, int]
    skip_reasons: dict[str, int]
    by_template: list[dict[str, Any]]
    by_source: list[dict[str, Any]]
    technical_errors: list[dict[str, Any]]


class DetailsOut(BaseModel):
    meta: AnalyticsMeta
    detail_type: str
    total: int
    limit: int
    offset: int
    items: list[dict[str, Any]]


class AnalyticsExportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reportType: Literal["summary", "stages", "workload", "data_quality", "checklists", "notifications"] = "summary"
    detailLevel: Literal["aggregate", "details"] = "aggregate"
