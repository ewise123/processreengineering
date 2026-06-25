from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.enums import ClaimKind, ConflictStatus


class ClaimRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    project_id: UUID
    kind: str
    subject: str
    normalized: dict
    confidence: float | None
    source: str
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
    detection_reason: str | None
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


class ClaimCreate(BaseModel):
    """Body for POST /claims — a manual claim. normalized defaults to empty."""

    kind: str = Field(min_length=1, max_length=30)
    subject: str = Field(min_length=1)
    normalized: dict = Field(default_factory=dict)

    @field_validator("kind")
    @classmethod
    def _kind_in_enum(cls, v: str) -> str:
        allowed = {k.value for k in ClaimKind}
        if v not in allowed:
            raise ValueError(f"kind must be one of {sorted(allowed)}")
        return v


class ClaimUpdate(BaseModel):
    """Partial edit of a claim's kind / subject / normalized."""

    kind: str | None = Field(default=None, min_length=1, max_length=30)
    subject: str | None = Field(default=None, min_length=1)
    normalized: dict | None = None

    @field_validator("kind")
    @classmethod
    def _kind_in_enum(cls, v: str | None) -> str | None:
        if v is None:
            return v
        allowed = {k.value for k in ClaimKind}
        if v not in allowed:
            raise ValueError(f"kind must be one of {sorted(allowed)}")
        return v


class ClaimImpactMap(BaseModel):
    """One process map whose nodes cite this claim."""

    model_id: UUID
    name: str


class ClaimImpact(BaseModel):
    """What a DELETE of this claim would empty — surfaced in the confirm dialog."""

    claim_id: UUID
    node_link_count: int
    maps: list[ClaimImpactMap]


class ConflictResolve(BaseModel):
    """Body for PATCH /conflicts/{id} — set the resolution state + notes."""

    resolution_status: str
    resolution_notes: str | None = None

    @field_validator("resolution_status")
    @classmethod
    def _status_in_enum(cls, v: str) -> str:
        allowed = {s.value for s in ConflictStatus}
        if v not in allowed:
            raise ValueError(f"resolution_status must be one of {sorted(allowed)}")
        return v
