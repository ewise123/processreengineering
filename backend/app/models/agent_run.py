"""Persisted record of one agent (ask-mode) investigation run.

Kept SEPARATE from the change-event stream: a read is not a change. This is the
observability / reproducibility / eval substrate for the read-only agent loop
(Layer 0). See docs/superpowers/specs/2026-07-01-agent-loop-layer0-readonly-design.md.
"""
from uuid import UUID

from sqlalchemy import Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import IdMixin, TimestampMixin
from app.enums import AgentRunStopReason


class AgentRun(IdMixin, TimestampMixin, Base):
    """No FKs on project_id/model_id/version_id. Unlike ChangeEvent (which keeps
    FKs on model_id/version_id and drops it only on its polymorphic target_id),
    AgentRun drops all three: an eval/observability log for a whole run should
    survive deletion of any of those entities, not just its immediate target.
    See docs/superpowers/specs/2026-07-01-agent-loop-layer0-readonly-design.md."""

    __tablename__ = "agent_runs"

    project_id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    model_id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    version_id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False, index=True)
    session_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(200), nullable=True)

    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)

    tool_calls: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    cited_claim_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    consulted_claim_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    round_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stop_reason: Mapped[str] = mapped_column(
        String(20), nullable=False, default=AgentRunStopReason.NORMAL.value
    )
    grounded: Mapped[bool] = mapped_column(nullable=False, default=True)
