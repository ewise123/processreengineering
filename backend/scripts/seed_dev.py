"""Seed minimal dev data: one organization and one user.

Run from the backend/ directory:
    python -m scripts.seed_dev
"""
from sqlalchemy import select

from app.db.session import session_scope
from app.models.identity import Organization, User

DEV_ORG_NAME = "Dev Org"
DEV_USER_EMAIL = "dev@local"


def seed() -> None:
    with session_scope() as session:
        org = session.scalars(
            select(Organization).where(Organization.name == DEV_ORG_NAME)
        ).first()
        if org is None:
            org = Organization(name=DEV_ORG_NAME, settings={})
            session.add(org)
            session.flush()
            print(f"Created organization {org.id}")
        else:
            print(f"Organization already exists: {org.id}")

        user = session.scalars(
            select(User).where(User.email == DEV_USER_EMAIL)
        ).first()
        if user is None:
            user = User(
                org_id=org.id,
                email=DEV_USER_EMAIL,
                name="Dev User",
                role="owner",
            )
            session.add(user)
            session.flush()
            print(f"Created user {user.id}")
        else:
            print(f"User already exists: {user.id}")


if __name__ == "__main__":
    seed()
