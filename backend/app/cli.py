"""Comandos administrativos.

  python -m app.cli create-admin --org "Agência Santos" --email a@b.c --name Admin
  python -m app.cli build-network        # baixa/constrói a malha de pedestres da área operacional
"""

from __future__ import annotations

import argparse
import getpass
import os

from sqlalchemy import select

from .core.config import get_settings
from .core.db import SessionLocal
from .core.security import hash_password
from .models import Organization, User


def create_admin(args):
    db = SessionLocal()
    org = db.scalar(select(Organization).where(Organization.name == args.org))
    if org is None:
        org = Organization(name=args.org, settings={})
        db.add(org)
        db.flush()
    pwd = args.password or os.environ.get("ADMIN_PASSWORD") or getpass.getpass("Senha: ")
    if len(pwd) < 10:
        raise SystemExit("Senha deve ter ao menos 10 caracteres.")
    u = User(org_id=org.id, email=args.email.lower(), name=args.name, password_hash=hash_password(pwd),
             role="admin", can_view_recipients=True)
    db.add(u)
    db.commit()
    print(f"Administrador criado: {u.email} (org {org.name})")


def build_network(args):
    from .services.routing.engines import InternalEngine

    eng = InternalEngine(get_settings())
    v = eng.refresh() if args.refresh else eng.network_version()
    print({"version": v, **eng.stats()})


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(required=True)
    a = sub.add_parser("create-admin")
    a.add_argument("--org", required=True)
    a.add_argument("--email", required=True)
    a.add_argument("--name", required=True)
    a.add_argument("--password")
    a.set_defaults(fn=create_admin)
    b = sub.add_parser("build-network")
    b.add_argument("--refresh", action="store_true")
    b.set_defaults(fn=build_network)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
