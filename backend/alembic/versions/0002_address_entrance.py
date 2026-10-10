"""address entrance (portaria) separate from postal location + location history

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-10
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("addresses", sa.Column("entrance_lat", sa.Float(), nullable=True))
    op.add_column("addresses", sa.Column("entrance_lon", sa.Float(), nullable=True))
    op.add_column("addresses", sa.Column("entrance_note", sa.String(200), nullable=True))
    op.add_column("addresses", sa.Column("entrance_confirmed_by", sa.UUID(), nullable=True))
    op.add_column("addresses", sa.Column("entrance_confirmed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key("fk_addresses_entrance_user", "addresses", "users", ["entrance_confirmed_by"], ["id"])
    op.create_table(
        "address_location_history",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("address_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("action", sa.String(30), nullable=False),
        sa.Column("before", sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["address_id"], ["addresses.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_address_location_history_org_id", "address_location_history", ["org_id"])
    op.create_index("ix_address_location_history_address_id", "address_location_history", ["address_id"])


def downgrade() -> None:
    op.drop_index("ix_address_location_history_address_id", table_name="address_location_history")
    op.drop_index("ix_address_location_history_org_id", table_name="address_location_history")
    op.drop_table("address_location_history")
    op.drop_constraint("fk_addresses_entrance_user", "addresses", type_="foreignkey")
    for c in ("entrance_confirmed_at", "entrance_confirmed_by", "entrance_note", "entrance_lon", "entrance_lat"):
        op.drop_column("addresses", c)
