"""add anchor sides and edge_kind to process_edges

Supports manual "rework" / backtrack connections: an edge can pin which face
(top/bottom) it exits the source and enters the target, and is tagged with a
kind so the canvas can render it distinctly. NULL sides keep today's purely
geometric auto-routing for every existing and AI-generated edge.

Revision ID: 0011_edge_anchor_sides
Revises: 0010_change_event
Create Date: 2026-06-25

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011_edge_anchor_sides"
down_revision: Union[str, None] = "0010_change_event"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "process_edges",
        sa.Column("source_side", sa.String(length=10), nullable=True),
    )
    op.add_column(
        "process_edges",
        sa.Column("target_side", sa.String(length=10), nullable=True),
    )
    op.add_column(
        "process_edges",
        sa.Column(
            "edge_kind",
            sa.String(length=20),
            nullable=False,
            server_default="flow",
        ),
    )


def downgrade() -> None:
    op.drop_column("process_edges", "edge_kind")
    op.drop_column("process_edges", "target_side")
    op.drop_column("process_edges", "source_side")
