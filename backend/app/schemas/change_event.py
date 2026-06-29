"""Pydantic read schemas for ChangeEvent history endpoints."""
from __future__ import annotations

from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, computed_field

from app.models.change_event import ChangeEvent as ChangeEventModel


class ChangeEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_at: Any  # datetime — Any avoids tz-naivety issues across PG/Python
    target_type: str
    target_id: UUID
    kind: str
    reason: str
    actor_kind: str
    before: dict | None
    after: dict | None
    cited_claim_ids: list[UUID] | None
    reasoning_trace: Any | None
    source: str
    version_id: UUID | None

    @computed_field  # type: ignore[misc]
    @property
    def has_thinking(self) -> bool:
        return self.reasoning_trace is not None

    @classmethod
    def from_event(cls, ev: ChangeEventModel) -> "ChangeEventRead":
        """Build from an ORM instance, handling cited_claim_ids coercion."""
        raw_ids = ev.cited_claim_ids
        cited: list[UUID] | None = None
        if raw_ids is not None:
            cited = [UUID(str(c)) for c in raw_ids]
        return cls(
            id=ev.id,
            created_at=ev.created_at,
            target_type=ev.target_type,
            target_id=ev.target_id,
            kind=ev.kind,
            reason=ev.reason,
            actor_kind=ev.actor_kind,
            before=ev.before,
            after=ev.after,
            cited_claim_ids=cited,
            reasoning_trace=ev.reasoning_trace,
            source=ev.source,
            version_id=ev.version_id,
        )


class ChangeLogPage(BaseModel):
    """Paginated wrapper — used by Task 19 log endpoint."""

    items: list[ChangeEventRead]
    next_cursor: str | None
