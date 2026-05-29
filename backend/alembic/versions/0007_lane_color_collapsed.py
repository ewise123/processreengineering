"""add color and collapsed to process_lanes

Revision ID: 0007_lane_color_collapsed
Revises: 0006_detection_run_updated_at
Create Date: 2026-05-29

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007_lane_color_collapsed"
down_revision: Union[str, None] = "0006_detection_run_updated_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "process_lanes",
        sa.Column("color", sa.String(length=9), nullable=True),
    )
    op.add_column(
        "process_lanes",
        sa.Column(
            "collapsed",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("process_lanes", "collapsed")
    op.drop_column("process_lanes", "color")
