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
