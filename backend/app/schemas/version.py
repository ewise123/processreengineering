"""SP-4 version-control schemas: version summaries, copy request, and diff shapes."""
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class VersionSummaryRead(BaseModel):
    id: UUID
    version_number: int
    parent_version_id: UUID | None
    status: str
    notes: str | None
    created_at: datetime
    node_count: int
    lane_count: int
    edge_count: int


class VersionCopyRequest(BaseModel):
    note: str | None = None


class NodeChange(BaseModel):
    name: str
    from_name: str | None = None
    from_lane: str | None = None
    to_lane: str | None = None


class EdgeChange(BaseModel):
    source: str
    target: str


class LaneChange(BaseModel):
    name: str


class NodeDiff(BaseModel):
    added: list[NodeChange]
    removed: list[NodeChange]
    renamed: list[NodeChange]
    moved: list[NodeChange]
    unchanged_count: int


class EdgeDiff(BaseModel):
    added: list[EdgeChange]
    removed: list[EdgeChange]


class LaneDiff(BaseModel):
    added: list[LaneChange]
    removed: list[LaneChange]


class VersionDiffRead(BaseModel):
    nodes: NodeDiff
    edges: EdgeDiff
    lanes: LaneDiff
