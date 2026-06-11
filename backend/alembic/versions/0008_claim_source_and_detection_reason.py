"""add claims.source and claim_conflicts.detection_reason

Revision ID: 0008_claim_source_detect_reason
Revises: 0007_lane_color_collapsed
Create Date: 2026-06-11

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008_claim_source_detect_reason"
down_revision: Union[str, None] = "0007_lane_color_collapsed"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "claims",
        sa.Column(
            "source",
            sa.String(length=20),
            nullable=False,
            server_default="extracted",
        ),
    )
    op.add_column(
        "claim_conflicts",
        sa.Column("detection_reason", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("claim_conflicts", "detection_reason")
    op.drop_column("claims", "source")
