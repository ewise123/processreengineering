from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class ClaimRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    project_id: UUID
    kind: str
    subject: str
    normalized: dict
    confidence: float | None
    created_at: datetime
    updated_at: datetime


class ClaimCitationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    claim_id: UUID
    chunk_id: UUID
    quote: str
    confidence: float | None


class ClaimConflictRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    claim_a_id: UUID
    claim_b_id: UUID
    kind: str
    detected_by: str
    resolution_status: str
    resolution_notes: str | None
    created_at: datetime


class ClaimExtractionResult(BaseModel):
    input_id: UUID
    claim_count: int
    citation_count: int


class ConflictDetectionResult(BaseModel):
    project_id: UUID
    claim_count: int
    new_conflict_count: int


class EmbedResult(BaseModel):
    input_id: UUID
    embedded_count: int
    skipped_count: int
