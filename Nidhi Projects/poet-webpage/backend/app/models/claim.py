from uuid import UUID

from sqlalchemy import Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import IdMixin, TimestampMixin
from app.enums import ConflictStatus


class Claim(IdMixin, TimestampMixin, Base):
    __tablename__ = "claims"

    project_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    subject: Mapped[str] = mapped_column(Text, nullable=False)
    normalized: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    extracted_by_job_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("generation_jobs.id", ondelete="SET NULL"),
        nullable=True,
    )


class ClaimCitation(IdMixin, TimestampMixin, Base):
    __tablename__ = "claim_citations"

    claim_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("claims.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    chunk_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("chunks.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    quote: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)


class ClaimConflict(IdMixin, TimestampMixin, Base):
    __tablename__ = "claim_conflicts"

    claim_a_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("claims.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    claim_b_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("claims.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    detected_by: Mapped[str] = mapped_column(String(50), nullable=False, default="ai")
    resolution_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ConflictStatus.DETECTED.value
    )
    resolution_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
