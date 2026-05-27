from uuid import UUID

from sqlalchemy import Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import IdMixin, SoftDeleteMixin, TimestampMixin
from app.enums import ClaimLinkKind, ProcessVersionStatus


class ProcessModel(IdMixin, TimestampMixin, SoftDeleteMixin, Base):
    __tablename__ = "process_models"

    project_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    level: Mapped[str] = mapped_column(String(4), nullable=False)
    parent_model_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_models.id", ondelete="SET NULL"),
        nullable=True,
    )


class ProcessVersion(IdMixin, TimestampMixin, Base):
    __tablename__ = "process_versions"
    __table_args__ = (
        UniqueConstraint(
            "model_id", "version_number", name="uq_process_versions_model_version"
        ),
    )

    model_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_models.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    parent_version_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ProcessVersionStatus.DRAFT.value
    )
    bpmn_xml: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    generated_by_job_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("generation_jobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_by: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )


class ProcessLane(IdMixin, TimestampMixin, Base):
    __tablename__ = "process_lanes"

    version_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    entity_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("entities.id", ondelete="SET NULL"),
        nullable=True,
    )
    order_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    height_px: Mapped[int] = mapped_column(
        Integer, nullable=False, default=150, server_default="150"
    )


class ProcessNode(IdMixin, TimestampMixin, Base):
    __tablename__ = "process_nodes"

    version_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    lane_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_lanes.id", ondelete="SET NULL"),
        nullable=True,
    )
    type: Mapped[str] = mapped_column(String(40), nullable=False)
    name: Mapped[str] = mapped_column(String(500), nullable=False)
    position: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    properties: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)


class ProcessEdge(IdMixin, TimestampMixin, Base):
    __tablename__ = "process_edges"

    version_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_node_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_nodes.id", ondelete="CASCADE"),
        nullable=False,
    )
    target_node_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_nodes.id", ondelete="CASCADE"),
        nullable=False,
    )
    label: Mapped[str | None] = mapped_column(String(300), nullable=True)
    condition_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    condition_claim_id: Mapped[UUID | None] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("claims.id", ondelete="SET NULL"),
        nullable=True,
    )
    # User-overridden orthogonal bend coordinates. When the routing chooses
    # horizontal layout, bend_x sets the x-coordinate of the vertical mid
    # segment; bend_y is the analog for vertical routing. NULL → auto-route.
    bend_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    bend_y: Mapped[float | None] = mapped_column(Float, nullable=True)


class NodeClaimLink(IdMixin, TimestampMixin, Base):
    __tablename__ = "node_claim_links"
    __table_args__ = (
        UniqueConstraint("node_id", "claim_id", name="uq_node_claim_links_node_claim"),
    )

    node_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_nodes.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    claim_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("claims.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    link_kind: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ClaimLinkKind.SUPPORTS.value
    )


class EdgeClaimLink(IdMixin, TimestampMixin, Base):
    __tablename__ = "edge_claim_links"
    __table_args__ = (
        UniqueConstraint("edge_id", "claim_id", name="uq_edge_claim_links_edge_claim"),
    )

    edge_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("process_edges.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    claim_id: Mapped[UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("claims.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    link_kind: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ClaimLinkKind.SUPPORTS.value
    )
