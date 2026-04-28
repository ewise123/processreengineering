from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ProcessMapGenerateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    level: str = Field(pattern=r"^(1|2|3|4|L1|L2|L3|L4)$")
    focus: str | None = Field(default=None, max_length=300)
    map_type: str | None = Field(default=None, pattern=r"^(current_state|future_state)?$")
    scope_input_ids: list[UUID] | None = None


class ProcessMapGenerateResult(BaseModel):
    model_id: UUID
    version_id: UUID
    process_name: str
    level: str
    lane_count: int
    node_count: int
    edge_count: int
    node_link_count: int
    bpmn_xml_size: int


class ProcessLaneRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    order_index: int
    height_px: int


class LaneCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    order_index: int = Field(ge=0)
    height_px: int | None = Field(default=None, ge=80)


class LaneUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    order_index: int | None = Field(default=None, ge=0)
    height_px: int | None = Field(default=None, ge=80)


class NodeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=500)
    lane_id: UUID | None = None
    x: float | None = None
    relative_y: float | None = None


class NodeCreate(BaseModel):
    """Body for the palette → drop-on-canvas flow. The canvas knows the
    target lane and where the user dropped, so we accept those directly
    instead of re-running auto-layout."""

    type: str = Field(
        pattern=r"^(task|event_start|event_end|event_intermediate|gateway_exclusive|gateway_parallel|gateway_inclusive|subprocess)$"
    )
    name: str = Field(min_length=1, max_length=500)
    lane_id: UUID
    x: float
    relative_y: float


class EdgeCreate(BaseModel):
    """Body for the connect-tool flow: drag from source node to target."""

    source_node_id: UUID
    target_node_id: UUID
    label: str | None = Field(default=None, max_length=300)


class EdgeUpdate(BaseModel):
    """Partial update for an edge. Empty-string labels are normalized to None
    on the server so the persisted state matches 'no label'."""

    label: str | None = Field(default=None, max_length=300)


class CitationDetail(BaseModel):
    """A single supporting quote with the input + section it came from."""

    citation_id: UUID
    chunk_id: UUID
    quote: str
    confidence: float | None
    input_id: UUID
    input_name: str
    input_type: str
    section_kind: str
    section_ref: dict


class ClaimWithCitations(BaseModel):
    """A claim plus its supporting citations, scoped to a single node."""

    id: UUID
    kind: str
    subject: str
    normalized: dict
    confidence: float | None
    link_kind: str
    citations: list[CitationDetail]


class NodeCitationsRead(BaseModel):
    node_id: UUID
    claims: list[ClaimWithCitations]


class NodeIssueRead(BaseModel):
    """Surfaces open conflicts on claims linked to a given node so the canvas
    can render an issue badge. Severity is derived from the count of distinct
    open conflicts touching this node's claims."""

    node_id: UUID
    severity: str = Field(pattern=r"^(medium|high)$")
    conflict_count: int


class ClaimSummary(BaseModel):
    """Lightweight claim shape used inside conflict listings — no citations."""

    id: UUID
    kind: str
    subject: str
    normalized: dict
    confidence: float | None


class NodeIssueDetail(BaseModel):
    """A single open conflict touching one of this node's claims, with both
    sides of the conflict surfaced for the properties panel."""

    conflict_id: UUID
    kind: str
    resolution_status: str
    detected_by: str
    resolution_notes: str | None
    this_claim: ClaimSummary
    other_claim: ClaimSummary


class NodeIssuesDetailRead(BaseModel):
    node_id: UUID
    issues: list[NodeIssueDetail]


class ProcessNodeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    type: str
    name: str
    lane_id: UUID | None
    position: dict
    properties: dict


class ProcessEdgeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    source_node_id: UUID
    target_node_id: UUID
    label: str | None
    condition_text: str | None


class ProcessVersionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    model_id: UUID
    version_number: int
    status: str
    bpmn_xml: str | None
    notes: str | None
    created_at: datetime


class ProcessGraphRead(BaseModel):
    version: ProcessVersionRead
    lanes: list[ProcessLaneRead]
    nodes: list[ProcessNodeRead]
    edges: list[ProcessEdgeRead]


class ProcessModelRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    project_id: UUID
    name: str
    level: str
    parent_model_id: UUID | None
    created_at: datetime
    updated_at: datetime
    latest_version_id: UUID | None = None
    latest_version_number: int | None = None
