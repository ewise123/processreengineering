"""merge agent_run and edge anchor sides

Revision ID: 0012_merge_agent_run_sides
Revises: 0011_edge_anchor_sides, 6a9519d29890
Create Date: 2026-09-24 17:35:47.149562+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0012_merge_agent_run_sides'
down_revision: Union[str, None] = ('0011_edge_anchor_sides', '6a9519d29890')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
