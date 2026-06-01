from uuid import UUID

from pydantic import BaseModel, Field


class NodeReviewUpdate(BaseModel):
    status: str = Field(pattern=r"^(approved|changes_requested)$")
    note: str | None = Field(default=None, max_length=2000)


class NodeReviewRead(BaseModel):
    node_id: UUID
    status: str
    note: str | None = None


class ReviewCounts(BaseModel):
    approved: int
    changes_requested: int
    pending: int
    total: int


class ReviewStateRead(BaseModel):
    version_id: UUID
    version_status: str
    request_status: str | None = None
    nodes: list[NodeReviewRead]  # only nodes with a decision; absence = pending
    counts: ReviewCounts
