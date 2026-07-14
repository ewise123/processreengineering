"""Schemas for the chat-suggest feature (Word-style suggested changes).

A response carries prose (`message`) plus a list of `ChatSuggestion`s. Each
suggestion wraps one typed `SuggestionOp`. Op ref fields hold a resolved object
id (UUID as string) or a `tmp:N` placeholder for an object created within the
same response (so a new edge can reference a new node). Per-kind required-field
validation drops malformed model output before it reaches the client.
"""
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from app.enums import NodeType

_NODE_TYPE_VALUES = {t.value for t in NodeType}


class ChatMode(StrEnum):
    ASK = "ask"
    SUGGEST = "suggest"


class RefKind(StrEnum):
    NODE = "node"
    EDGE = "edge"
    LANE = "lane"


class OpKind(StrEnum):
    RELABEL_NODE = "relabel_node"
    DESCRIBE_NODE = "describe_node"
    ADD_NODE = "add_node"
    REMOVE_NODE = "remove_node"
    ADD_EDGE = "add_edge"
    REMOVE_EDGE = "remove_edge"
    RELABEL_EDGE = "relabel_edge"
    REROUTE_EDGE = "reroute_edge"
    MOVE_TO_LANE = "move_to_lane"
    ADD_LANE = "add_lane"
    RENAME_LANE = "rename_lane"
    DECOMPOSE = "decompose"
    CHANGE_NODE_TYPE = "change_node_type"
    REMOVE_LANE = "remove_lane"
    SET_EDGE_CONDITION = "set_edge_condition"


# Per-kind required op fields. reroute_edge needs edge_ref plus at least one of
# from_ref/to_ref (checked separately below).
_REQUIRED_BY_KIND: dict[OpKind, tuple[str, ...]] = {
    OpKind.RELABEL_NODE: ("node_ref", "new_label"),
    OpKind.DESCRIBE_NODE: ("node_ref", "description"),
    OpKind.ADD_NODE: ("temp_id", "lane_ref", "node_type", "new_label"),
    OpKind.REMOVE_NODE: ("node_ref",),
    OpKind.ADD_EDGE: ("from_ref", "to_ref"),
    OpKind.REMOVE_EDGE: ("edge_ref",),
    OpKind.RELABEL_EDGE: ("edge_ref", "new_label"),
    OpKind.REROUTE_EDGE: ("edge_ref",),
    OpKind.MOVE_TO_LANE: ("node_ref", "lane_ref"),
    OpKind.ADD_LANE: ("temp_id", "name"),
    OpKind.RENAME_LANE: ("lane_ref", "name"),
    OpKind.DECOMPOSE: ("node_ref", "sub_steps"),
    OpKind.CHANGE_NODE_TYPE: ("node_ref", "node_type"),
    OpKind.REMOVE_LANE: ("lane_ref",),
    OpKind.SET_EDGE_CONDITION: ("edge_ref", "condition_text"),
}


class SubStepInput(BaseModel):
    proposed_name: str = Field(min_length=1, max_length=500)
    proposed_type: str = Field(default="task", pattern=rf"^({'|'.join(sorted(_NODE_TYPE_VALUES))})$")
    role: str | None = None
    edge_label: str | None = None


class SuggestionOp(BaseModel):
    kind: OpKind
    node_ref: str | None = None
    edge_ref: str | None = None
    lane_ref: str | None = None
    temp_id: str | None = None
    from_ref: str | None = None
    to_ref: str | None = None
    new_label: str | None = Field(default=None, max_length=500)
    description: str | None = Field(default=None, max_length=5000)
    name: str | None = Field(default=None, max_length=500)
    node_type: str | None = None
    near_node_ref: str | None = None
    edge_label: str | None = Field(default=None, max_length=300)
    sub_steps: list[SubStepInput] | None = None
    condition_text: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_required(self) -> "SuggestionOp":
        for field in _REQUIRED_BY_KIND[self.kind]:
            if getattr(self, field) in (None, "", []):
                raise ValueError(f"{self.kind} requires '{field}'")
        if self.node_type is not None and self.node_type not in _NODE_TYPE_VALUES:
            raise ValueError(f"unknown node_type '{self.node_type}'")
        if self.kind == OpKind.REROUTE_EDGE and not (self.from_ref or self.to_ref):
            raise ValueError("reroute_edge requires from_ref or to_ref")
        return self


class ObjectRef(BaseModel):
    kind: RefKind
    id: UUID


class ChatSuggestion(BaseModel):
    id: str = Field(min_length=1)
    group: str | None = None
    title: str = Field(min_length=1, max_length=300)
    op: SuggestionOp
    affected_refs: list[ObjectRef] = Field(default_factory=list)
    rationale: str = Field(default="", max_length=2000)
    cited_claim_ids: list[UUID] = Field(default_factory=list)
    # For rename-family ops (relabel_node/rename_lane/relabel_edge): the target's
    # name/label as it was when proposed, so the card can show a stable
    # "old -> new" transition that doesn't collapse once the change is applied.
    before_label: str | None = Field(default=None, max_length=500)


class ChatTurn(BaseModel):
    role: str = Field(pattern=r"^(user|assistant)$")
    content: str = Field(min_length=1, max_length=20_000)


class ChatSuggestRequest(BaseModel):
    history: list[ChatTurn] = Field(default_factory=list, max_length=40)
    user_message: str = Field(min_length=1, max_length=4000)
    mode: ChatMode = ChatMode.SUGGEST
    context_refs: list[ObjectRef] = Field(default_factory=list)
    session_id: str | None = Field(default=None, max_length=100)


class MentionSource(BaseModel):
    claim_id: UUID
    input_id: UUID
    input_name: str
    section_ref: dict | None = None
    quote: str | None = None


class ActivityStep(BaseModel):
    tool: str
    summary: str
    detail: str | None = None


class GroupSummary(BaseModel):
    """One-line purpose of a bundle of related suggestions sharing a `group`."""
    id: str = Field(min_length=1)
    summary: str = Field(min_length=1, max_length=500)


class AgentOption(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=300)


class AgentQuestion(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    options: list[AgentOption] = Field(default_factory=list)


class ChatSuggestResponse(BaseModel):
    message: str
    suggestions: list[ChatSuggestion] = Field(default_factory=list)
    mention_sources: list[MentionSource] = Field(default_factory=list)
    group_summaries: list[GroupSummary] = Field(default_factory=list)
    activity_trace: list[ActivityStep] = Field(default_factory=list)
    run_id: UUID | None = None
    grounded: bool = True
    question: AgentQuestion | None = None
