"""Pydantic shapes for the Process Inventory and AI suggestion inbox.

Distinct from schemas/process_map.py (which owns map/version/node shapes).
`Process` here is the durable inventory entity, not a ProcessModel/map.
"""
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ProcessRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    project_id: UUID
    name: str
    description: str
    order_index: int
    status: str
    created_at: datetime
    updated_at: datetime
    claim_count: int = 0
    map_count: int = 0


class ProcessCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=4000)


class ProcessUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=4000)
    order_index: int | None = Field(default=None, ge=0)
    status: str | None = Field(default=None, pattern=r"^(active|archived)$")


class ClaimRef(BaseModel):
    """Lightweight claim shape for triage lists and process claim views."""

    id: UUID
    kind: str
    subject: str
    source: str


class ClaimIdList(BaseModel):
    claim_ids: list[UUID] = Field(min_length=1)


class BulkAssignResult(BaseModel):
    process_id: UUID
    linked: int
    already_linked: int


class BulkUnassignResult(BaseModel):
    process_id: UUID
    removed: int


class SuggestProcessesRequest(BaseModel):
    scope_input_ids: list[UUID] | None = None


class SuggestionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    batch_id: UUID
    project_id: UUID
    kind: str
    process_id: UUID | None
    version_id: UUID | None
    op: str
    payload: dict
    rationale: str
    confidence: float | None
    status: str
    outcome: str | None
    created_at: datetime
    resolved_at: datetime | None


class SuggestBatchResult(BaseModel):
    batch_id: UUID
    suggestion_count: int


class AcceptSuggestionResult(BaseModel):
    suggestion_id: UUID
    status: str
    outcome: str
    process_id: UUID | None = None
    linked: int = 0


class BatchAcceptResult(BaseModel):
    batch_id: UUID
    accepted: int
    skipped: int


class ClaimMatchCandidate(BaseModel):
    claim_id: UUID
    subject: str
    kind: str
    confidence: float | None = None
    rationale: str = ""
    in_other_processes: bool = False


class SuggestClaimsResult(BaseModel):
    candidates: list[ClaimMatchCandidate] = Field(default_factory=list)
