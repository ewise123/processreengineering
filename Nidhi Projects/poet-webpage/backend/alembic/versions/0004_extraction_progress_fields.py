"""add extraction progress fields to inputs

Revision ID: 0004_extraction_progress_fields
Revises: 0003_edge_bend_offsets
Create Date: 2026-05-27

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_extraction_progress_fields"
down_revision: Union[str, None] = "0003_edge_bend_offsets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "inputs",
        sa.Column(
            "chunks_processed",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "inputs",
        sa.Column(
            "chunks_total",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "inputs",
        sa.Column(
            "extraction_started_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "inputs",
        sa.Column("extraction_error", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("inputs", "extraction_error")
    op.drop_column("inputs", "extraction_started_at")
    op.drop_column("inputs", "chunks_total")
    op.drop_column("inputs", "chunks_processed")
