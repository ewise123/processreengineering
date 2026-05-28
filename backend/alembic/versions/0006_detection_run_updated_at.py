"""add updated_at to detection_runs

Revision ID: 0006_detection_run_updated_at
Revises: 0005_process_detection_tables
Create Date: 2026-05-28

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006_detection_run_updated_at"
down_revision: Union[str, None] = "0005_process_detection_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "detection_runs",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("detection_runs", "updated_at")
