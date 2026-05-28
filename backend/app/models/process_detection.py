from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import IdMixin, TimestampMixin
from app.enums import DetectionRunStatus


class DetectionRun(IdMixin, TimestampMixin, Base):
    __tablename__ = "detection_runs"

    project_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=DetectionRunStatus.DRAFT.value
    )
    claim_count_at_run: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    claim_id_set: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    model_used: Mapped[str | None] = mapped_column(String(120), nullable=True)
    prompt_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reasoning_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )


class ProcessSegment(IdMixin, TimestampMixin, Base):
    __tablename__ = "process_segments"

    detection_run_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("detection_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    project_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    claim_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_unassigned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class ClaimSegmentMembership(IdMixin, Base):
    __tablename__ = "claim_segment_memberships"
    __table_args__ = (
        UniqueConstraint(
            "claim_id",
            "detection_run_id",
            name="uq_claim_segment_memberships_claim_id_detection_run_id",
        ),
    )

    claim_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("claims.id", ondelete="CASCADE"),
        nullable=False,
    )
    segment_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_segments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    detection_run_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("detection_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
