from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ClaimRef(BaseModel):
    """Minimal claim representation surfaced inside a segment."""

    id: UUID
    kind: str
    subject: str


class ProcessSegmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    detection_run_id: UUID
    name: str
    description: str
    order_index: int
    claim_count: int
    confidence: float | None
    is_unassigned: bool
    claims: list[ClaimRef] = Field(default_factory=list)


class DetectionRunRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    project_id: UUID
    status: str
    claim_count_at_run: int
    model_used: str | None
    reasoning_summary: str | None
    created_at: datetime


class DetectionRunDetail(DetectionRunRead):
    segments: list[ProcessSegmentRead]
    unassigned_segment: ProcessSegmentRead


class DetectionRunListRow(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    status: str
    claim_count_at_run: int
    segment_count: int
    created_at: datetime


class DetectProcessesRequest(BaseModel):
    scope_input_ids: list[UUID] | None = None


class SegmentUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=300)
    description: str | None = Field(default=None, max_length=2000)


class SegmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)


class SegmentMergeRequest(BaseModel):
    into_segment_id: UUID


class SegmentMoveClaimRequest(BaseModel):
    claim_id: UUID


class AcceptDetectionRunResult(BaseModel):
    run_id: UUID
    accepted_segment_count: int
