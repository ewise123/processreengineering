"""Schemas for the per-node AI-edit feature (SP-5a).

The propose endpoint returns one of four action-specific payloads. Each
proposal carries a human-readable rationale and the UUIDs of the project
claims that justify it (already resolved + hygiene-filtered by the endpoint).
"""
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field


class AiEditAction(StrEnum):
    RELABEL = "relabel"
    DESCRIBE = "describe"
    VALIDATE = "validate"
    SUGGEST_NEXT = "suggest_next"


class AiEditRequest(BaseModel):
    action: AiEditAction


class RelabelProposal(BaseModel):
    proposed_name: str
    unchanged: bool = False  # model judged the current label already faithful
    rationale: str
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class DescribeProposal(BaseModel):
    proposed_description: str
    rationale: str
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class ValidateGap(BaseModel):
    summary: str
    severity: str = Field(pattern=r"^(low|medium|high)$")
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class ValidateProposal(BaseModel):
    gaps: list[ValidateGap] = Field(default_factory=list)


class SuggestedStep(BaseModel):
    proposed_name: str
    proposed_type: str
    edge_label: str | None = None
    rationale: str
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class SuggestNextProposal(BaseModel):
    steps: list[SuggestedStep] = Field(default_factory=list)


class AiEditResponse(BaseModel):
    """Exactly one of the action fields is populated, matching the request."""
    action: AiEditAction
    relabel: RelabelProposal | None = None
    describe: DescribeProposal | None = None
    validate_: ValidateProposal | None = Field(default=None, alias="validate")
    suggest_next: SuggestNextProposal | None = None

    model_config = {"populate_by_name": True}


class AiProposedStepRequest(BaseModel):
    """Apply a suggested next step: create an ai_proposed node downstream of
    `source_node_id`, plus the connecting edge and any ai_proposed claim links."""
    source_node_id: UUID
    name: str = Field(min_length=1, max_length=500)
    type: str
    lane_id: UUID
    x: float
    relative_y: float
    edge_label: str | None = Field(default=None, max_length=300)
    cited_claim_ids: list[UUID] = Field(default_factory=list)
