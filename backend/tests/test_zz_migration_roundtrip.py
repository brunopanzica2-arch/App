"""Migração 0002 reversível (rollback seguro). Arquivo 'zz' para rodar por último: recria o schema."""
import os

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from app.core.db import engine

HERE = os.path.dirname(os.path.dirname(__file__))


def cols():
    with engine().connect() as c:
        return {r[0] for r in c.execute(text("select column_name from information_schema.columns where table_name='addresses'"))}


def tables():
    with engine().connect() as c:
        return {r[0] for r in c.execute(text("select table_name from information_schema.tables where table_schema='public'"))}


def test_0002_downgrade_removes_columns_and_upgrade_restores_them():
    cfg = Config(os.path.join(HERE, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(HERE, "alembic"))
    assert {"entrance_lat", "entrance_lon", "entrance_note"} <= cols() and "address_location_history" in tables()
    command.downgrade(cfg, "0001")
    assert not ({"entrance_lat", "entrance_lon"} & cols()) and "address_location_history" not in tables()
    assert "lat" in cols()  # dados legados preservados
    command.upgrade(cfg, "head")
    assert {"entrance_lat", "entrance_lon", "entrance_note"} <= cols() and "address_location_history" in tables()
