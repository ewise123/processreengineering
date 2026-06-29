from uuid import UUID

from sqlalchemy import ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import IdMixin, TimestampMixin


class ChangeEvent(IdMixin, TimestampMixin, Base):
    """Append-only per-object reasoning trail. One row per semantic change to a
    node/edge/lane, plus version branch/restore. created_at is the event time.
    target_id is deliberately NOT a FK so the trail survives the target's
    deletion. See docs/superpowers/specs/2026-06-22-process-map-reasoning-trail-design.md."""

    __tablename__ = "change_events"
    __table_args__ = (
        Index("ix_change_events_target", "target_type", "target_id", "created_at"),
        Index("ix_change_events_model", "model_id", "created_at"),
    )

    target_type: Mapped[str] = mapped_column(String(20), nullable=False)
    target_id: Mapped[UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    model_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_models.id", ondelete="CASCADE"),
        nullable=False,
    )
    version_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    actor_kind: Mapped[str] = mapped_column(String(10), nullable=False)
    actor_id: Mapped[UUID | None] = mapped_column(PgUUID(as_uuid=True), nullable=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    before: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    cited_claim_ids: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    reasoning_trace: Mapped[list | dict | None] = mapped_column(JSONB, nullable=True)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    suggestion_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_suggestions.id", ondelete="SET NULL"),
        nullable=True,
    )
