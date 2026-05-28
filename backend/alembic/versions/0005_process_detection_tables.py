"""add process detection tables

Revision ID: 0005_process_detection_tables
Revises: 0004_extraction_progress_fields
Create Date: 2026-05-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID

revision: str = "0005_process_detection_tables"
down_revision: Union[str, None] = "0004_extraction_progress_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "detection_runs",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
        sa.Column("claim_count_at_run", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("claim_id_set", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("model_used", sa.String(length=120), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("reasoning_summary", sa.Text(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_by",
            PgUUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_detection_runs_project_id",
        "detection_runs",
        ["project_id"],
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_detection_runs_one_draft_per_project "
        "ON detection_runs(project_id) WHERE status='draft'"
    )

    op.create_table(
        "process_segments",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "detection_run_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("detection_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "project_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=300), nullable=False, server_default=""),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("claim_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column(
            "is_unassigned",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_process_segments_detection_run_id",
        "process_segments",
        ["detection_run_id"],
    )
    op.create_index(
        "ix_process_segments_project_id",
        "process_segments",
        ["project_id"],
    )

    op.create_table(
        "claim_segment_memberships",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "claim_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("claims.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "segment_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("process_segments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "detection_run_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("detection_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "claim_id",
            "detection_run_id",
            name="uq_claim_segment_memberships_claim_id_detection_run_id",
        ),
    )
    op.create_index(
        "ix_claim_segment_memberships_segment_id",
        "claim_segment_memberships",
        ["segment_id"],
    )
    op.create_index(
        "ix_claim_segment_memberships_detection_run_id",
        "claim_segment_memberships",
        ["detection_run_id"],
    )

    op.add_column(
        "process_versions",
        sa.Column(
            "source_segment_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("process_segments.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("process_versions", "source_segment_id")
    op.drop_index(
        "ix_claim_segment_memberships_detection_run_id",
        table_name="claim_segment_memberships",
    )
    op.drop_index(
        "ix_claim_segment_memberships_segment_id",
        table_name="claim_segment_memberships",
    )
    op.drop_table("claim_segment_memberships")
    op.drop_index(
        "ix_process_segments_project_id", table_name="process_segments"
    )
    op.drop_index(
        "ix_process_segments_detection_run_id", table_name="process_segments"
    )
    op.drop_table("process_segments")
    op.execute("DROP INDEX IF EXISTS uq_detection_runs_one_draft_per_project")
    op.drop_index(
        "ix_detection_runs_project_id", table_name="detection_runs"
    )
    op.drop_table("detection_runs")
