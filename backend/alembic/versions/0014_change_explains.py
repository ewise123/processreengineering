"""add explains_id to change_events

An explanation added after the fact is its own `explain` event pointing at
the change it explains, so the original row is never rewritten.

Revision ID: 0014_change_explains
Revises: 0013_edge_color
Create Date: 2026-09-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_change_explains"
down_revision: Union[str, None] = "0013_edge_color"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "change_events",
        sa.Column(
            "explains_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("change_events.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.create_index("ix_change_events_explains", "change_events", ["explains_id"])


def downgrade() -> None:
    op.drop_index("ix_change_events_explains", table_name="change_events")
    op.drop_column("change_events", "explains_id")
