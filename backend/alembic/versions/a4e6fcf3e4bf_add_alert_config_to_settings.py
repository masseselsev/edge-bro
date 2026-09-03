"""add_alert_config_to_settings

Revision ID: a4e6fcf3e4bf
Revises: f2b7e4a19c3d
Create Date: 2026-09-03 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4e6fcf3e4bf'
down_revision: Union[str, None] = 'f2b7e4a19c3d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('settings', sa.Column('alert_config', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('settings', 'alert_config')
