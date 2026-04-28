"""add height_px to process_lanes

Revision ID: 0002_lane_height_px
Revises: 5f0feeb31d49
Create Date: 2026-04-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_lane_height_px"
down_revision: Union[str, None] = "5f0feeb31d49"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "process_lanes",
        sa.Column(
            "height_px", sa.Integer(), nullable=False, server_default="150"
        ),
    )


def downgrade() -> None:
    op.drop_column("process_lanes", "height_px")
