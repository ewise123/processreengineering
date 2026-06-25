"""Schemas for the per-node AI-edit feature (SP-5a).

The propose endpoint returns one of four action-specific payloads. Each
proposal carries a human-readable rationale and the UUIDs of the project
claims that justify it (already resolved + hygiene-filtered by the endpoint).
"""
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.enums import NodeType

_NODE_TYPE_PATTERN = rf"^({'|'.join(t.value for t in NodeType)})$"


class AiEditAction(StrEnum):
    RELABEL = "relabel"
    DESCRIBE = "describe"
    VALIDATE = "validate"
    SUGGEST_NEXT = "suggest_next"
    DECOMPOSE = "decompose"


class AiEditRequest(BaseModel):
    action: AiEditAction


class RelabelProposal(BaseModel):
    proposed_name: str = Field(min_length=1, max_length=500)
    unchanged: bool = False  # model judged the current label already faithful
    rationale: str = Field(max_length=2000)
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class DescribeProposal(BaseModel):
    proposed_description: str = Field(min_length=0, max_length=5000)
    rationale: str = Field(max_length=2000)
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class ValidateGap(BaseModel):
    summary: str = Field(min_length=1, max_length=1000)
    severity: str = Field(pattern=r"^(low|medium|high)$")
    cited_claim_ids: list[UUID] = Field(default_factory=list)


# No proposal-level rationale: the per-gap `summary` carries the reasoning
# intentionally — asymmetry vs other proposals is deliberate.
class ValidateProposal(BaseModel):
    gaps: list[ValidateGap] = Field(default_factory=list)


class SuggestedStep(BaseModel):
    proposed_name: str = Field(min_length=1, max_length=500)
    proposed_type: str = Field(pattern=_NODE_TYPE_PATTERN)
    edge_label: str | None = None
    rationale: str = Field(max_length=2000)
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class SuggestNextProposal(BaseModel):
    steps: list[SuggestedStep] = Field(default_factory=list)


class SubStep(BaseModel):
    """One sub-step of a decomposed parent step. In a propose response,
    `cited_claim_ids` are the surviving (node+neighbor-scoped) claim UUIDs; in
    an apply request they are the user-accepted ids."""
    proposed_name: str = Field(min_length=1, max_length=500)
    proposed_type: str = Field(pattern=_NODE_TYPE_PATTERN)
    role: str = Field(min_length=1, max_length=300)
    edge_label: str | None = Field(default=None, max_length=300)
    rationale: str = Field(default="", max_length=2000)
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class DecomposeProposal(BaseModel):
    sub_steps: list[SubStep] = Field(default_factory=list)


class AiEditResponse(BaseModel):
    """Exactly one of the action fields is populated, matching the request."""
    action: AiEditAction
    relabel: RelabelProposal | None = None
    describe: DescribeProposal | None = None
    validate_: ValidateProposal | None = Field(default=None, alias="validate")
    suggest_next: SuggestNextProposal | None = None
    decompose: DecomposeProposal | None = None

    model_config = ConfigDict(populate_by_name=True)


class AiProposedStepRequest(BaseModel):
    """Apply a suggested next step: create an ai_proposed node downstream of
    `source_node_id`, plus the connecting edge and any ai_proposed claim links."""
    source_node_id: UUID
    name: str = Field(min_length=1, max_length=500)
    type: str = Field(pattern=_NODE_TYPE_PATTERN)
    lane_id: UUID
    x: float
    relative_y: float
    edge_label: str | None = Field(default=None, max_length=300)
    cited_claim_ids: list[UUID] = Field(default_factory=list)


class DecomposeRequest(BaseModel):
    """Apply a decompose proposal: create/append a child version from these
    accepted sub-steps."""
    sub_steps: list[SubStep] = Field(min_length=1)


class DecomposeResult(BaseModel):
    child_model_id: UUID
    child_version_id: UUID


class AncestryCrumb(BaseModel):
    model_id: UUID
    version_id: UUID | None
    level: str
    label: str
