"""change_events table + origin backfill; drop audit_events/ai_interactions.

Revision ID: 0010_change_event
Revises: 0009_process_inventory
Create Date: 2026-06-22

One-way for the dropped tables: audit_events/ai_interactions were never written
(no production data; auth stubbed), so downgrade recreates them EMPTY.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Session

revision: str = "0010_change_event"
down_revision: Union[str, None] = "0009_process_inventory"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "change_events",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("target_type", sa.String(length=20), nullable=False),
        sa.Column("target_id", PgUUID(as_uuid=True), nullable=False),
        sa.Column("model_id", PgUUID(as_uuid=True), sa.ForeignKey("process_models.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_id", PgUUID(as_uuid=True), sa.ForeignKey("process_versions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("actor_kind", sa.String(length=10), nullable=False),
        sa.Column("actor_id", PgUUID(as_uuid=True), nullable=True),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("before", JSONB(), nullable=True),
        sa.Column("after", JSONB(), nullable=True),
        sa.Column("cited_claim_ids", JSONB(), nullable=True),
        sa.Column("reasoning_trace", JSONB(), nullable=True),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("suggestion_id", PgUUID(as_uuid=True), sa.ForeignKey("process_suggestions.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_change_events_target", "change_events", ["target_type", "target_id", "created_at"])
    op.create_index("ix_change_events_model", "change_events", ["model_id", "created_at"])

    # Backfill origin events for pre-existing nodes/edges.
    from app.services.change_log import backfill_origin_events

    bind = op.get_bind()
    session = Session(bind=bind)
    backfill_origin_events(session)
    session.commit()

    op.drop_table("ai_interactions")
    op.drop_table("audit_events")


def downgrade() -> None:
    # Recreate the dropped tables EMPTY (they were never written).
    op.create_table(
        "audit_events",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("actor_id", PgUUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("project_id", PgUUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=True),
        sa.Column("target_type", sa.String(length=50), nullable=False),
        sa.Column("target_id", PgUUID(as_uuid=True), nullable=True),
        sa.Column("action", sa.String(length=50), nullable=False),
        sa.Column("before", JSONB(), nullable=True),
        sa.Column("after", JSONB(), nullable=True),
    )
    op.create_table(
        "ai_interactions",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("project_id", PgUUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_type", sa.String(length=50), nullable=True),
        sa.Column("target_id", PgUUID(as_uuid=True), nullable=True),
        sa.Column("model", sa.String(length=100), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("response", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("proposed_patch", JSONB(), nullable=True),
        sa.Column("applied", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", PgUUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
    )
    op.drop_index("ix_change_events_model", table_name="change_events")
    op.drop_index("ix_change_events_target", table_name="change_events")
    op.drop_table("change_events")
