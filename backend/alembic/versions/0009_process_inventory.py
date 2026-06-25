"""process inventory: processes, process_claim_links, process_suggestions;
re-home maps onto processes; drop detection tables.

Revision ID: 0009_process_inventory
Revises: 0008_claim_source_detect_reason
Create Date: 2026-06-11

This migration is intentionally one-way (lossy downgrade). It carries data out
of the accepted detection runs into the durable inventory, then drops the
detection tables. The downgrade recreates the three tables EMPTY — accepted
curation is not recoverable. This is acceptable: no production data exists
(auth is stubbed). Called out in the PR.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID

revision: str = "0009_process_inventory"
down_revision: Union[str, None] = "0008_claim_source_detect_reason"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create the three new tables and the process_models.process_id column.
    op.create_table(
        "processes",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(length=300), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="active"),
        sa.Column(
            "created_by",
            PgUUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
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
    op.create_index("ix_processes_project_id", "processes", ["project_id"])

    op.create_table(
        "process_claim_links",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column(
            "process_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("processes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "claim_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("claims.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("assigned_by", sa.String(length=20), nullable=False, server_default="user"),
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
        sa.UniqueConstraint(
            "process_id", "claim_id", name="uq_process_claim_links_process_claim"
        ),
    )
    op.create_index(
        "ix_process_claim_links_process_id", "process_claim_links", ["process_id"]
    )
    op.create_index(
        "ix_process_claim_links_claim_id", "process_claim_links", ["claim_id"]
    )

    op.create_table(
        "process_suggestions",
        sa.Column("id", PgUUID(as_uuid=True), primary_key=True),
        sa.Column("batch_id", PgUUID(as_uuid=True), nullable=False),
        sa.Column(
            "project_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=30), nullable=False),
        sa.Column(
            "process_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("processes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "version_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("process_versions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("op", sa.String(length=40), nullable=False),
        sa.Column("payload", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("rationale", sa.Text(), nullable=False, server_default=""),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("outcome", sa.String(length=20), nullable=True),
        sa.Column("model_used", sa.String(length=120), nullable=True),
        sa.Column("prompt_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
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
        "ix_process_suggestions_batch_id", "process_suggestions", ["batch_id"]
    )
    op.create_index(
        "ix_process_suggestions_project_id", "process_suggestions", ["project_id"]
    )

    op.add_column(
        "process_models",
        sa.Column(
            "process_id",
            PgUUID(as_uuid=True),
            sa.ForeignKey("processes.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_process_models_process_id", "process_models", ["process_id"])

    # 2. DATA MIGRATION (raw SQL). Each non-unassigned segment of an ACCEPTED
    #    run becomes one process; each of its memberships becomes a link with
    #    assigned_by='inherited'. Segment ids and process ids are 1:1, so we
    #    reuse the segment's own uuid as the process id to make re-linking
    #    trivial in step 3.
    op.execute(
        """
        INSERT INTO processes (
            id, project_id, name, description, order_index, status,
            created_by, deleted_at, created_at, updated_at
        )
        SELECT
            ps.id,
            ps.project_id,
            ps.name,
            ps.description,
            ps.order_index,
            'active',
            NULL,
            NULL,
            ps.created_at,
            ps.updated_at
        FROM process_segments ps
        JOIN detection_runs dr ON dr.id = ps.detection_run_id
        WHERE dr.status = 'accepted'
          AND ps.is_unassigned = false
        """
    )
    op.execute(
        """
        INSERT INTO process_claim_links (
            id, process_id, claim_id, assigned_by, created_at, updated_at
        )
        SELECT
            uuid_generate_v4(),
            csm.segment_id,
            csm.claim_id,
            'inherited',
            now(),
            now()
        FROM claim_segment_memberships csm
        JOIN process_segments ps ON ps.id = csm.segment_id
        JOIN detection_runs dr ON dr.id = ps.detection_run_id
        WHERE dr.status = 'accepted'
          AND ps.is_unassigned = false
        ON CONFLICT (process_id, claim_id) DO NOTHING
        """
    )

    # 3. Re-link maps. A ProcessModel is linked to the process whose id equals
    #    the source_segment_id of ANY of the model's versions that points at a
    #    segment we migrated (i.e. now present in `processes`). Unresolvable
    #    models keep process_id = NULL ("unlinked maps", attachable in the UI).
    op.execute(
        """
        UPDATE process_models pm
        SET process_id = sub.process_id
        FROM (
            SELECT DISTINCT ON (pv.model_id)
                pv.model_id,
                pv.source_segment_id AS process_id
            FROM process_versions pv
            JOIN processes p ON p.id = pv.source_segment_id
            WHERE pv.source_segment_id IS NOT NULL
            ORDER BY pv.model_id, pv.version_number DESC
        ) AS sub
        WHERE pm.id = sub.model_id
        """
    )

    # 4. Drop the source_segment_id column, then the three detection tables.
    op.drop_column("process_versions", "source_segment_id")
    op.drop_table("claim_segment_memberships")
    op.drop_table("process_segments")
    op.execute("DROP INDEX IF EXISTS uq_detection_runs_one_draft_per_project")
    op.drop_table("detection_runs")


def downgrade() -> None:
    # LOSSY: recreate the three detection tables EMPTY and re-add the column.
    # Migrated processes/links/suggestions are NOT carried back.
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
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_detection_runs_project_id", "detection_runs", ["project_id"])
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
        sa.Column("is_unassigned", sa.Boolean(), nullable=False, server_default=sa.text("false")),
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
        "ix_process_segments_detection_run_id", "process_segments", ["detection_run_id"]
    )
    op.create_index("ix_process_segments_project_id", "process_segments", ["project_id"])
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
        "ix_claim_segment_memberships_segment_id", "claim_segment_memberships", ["segment_id"]
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

    op.drop_index("ix_process_models_process_id", table_name="process_models")
    op.drop_column("process_models", "process_id")
    op.drop_index("ix_process_suggestions_project_id", table_name="process_suggestions")
    op.drop_index("ix_process_suggestions_batch_id", table_name="process_suggestions")
    op.drop_table("process_suggestions")
    op.drop_index("ix_process_claim_links_claim_id", table_name="process_claim_links")
    op.drop_index("ix_process_claim_links_process_id", table_name="process_claim_links")
    op.drop_table("process_claim_links")
    op.drop_index("ix_processes_project_id", table_name="processes")
    op.drop_table("processes")
