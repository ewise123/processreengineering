"""add bend_x / bend_y to process_edges

Revision ID: 0003_edge_bend_offsets
Revises: 0002_lane_height_px
Create Date: 2026-04-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_edge_bend_offsets"
down_revision: Union[str, None] = "0002_lane_height_px"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "process_edges", sa.Column("bend_x", sa.Float(), nullable=True)
    )
    op.add_column(
        "process_edges", sa.Column("bend_y", sa.Float(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("process_edges", "bend_y")
    op.drop_column("process_edges", "bend_x")
