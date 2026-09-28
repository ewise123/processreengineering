"""add color to process_edges

Revision ID: 0013_edge_color
Revises: 0012_merge_agent_run_sides
Create Date: 2026-09-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013_edge_color"
down_revision: Union[str, None] = "0012_merge_agent_run_sides"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # "#rrggbb" or NULL (NULL → the canvas's default connector colour).
    op.add_column("process_edges", sa.Column("color", sa.String(9), nullable=True))


def downgrade() -> None:
    op.drop_column("process_edges", "color")
