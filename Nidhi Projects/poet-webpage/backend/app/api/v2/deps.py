from uuid import UUID

from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.identity import Organization, User
from app.models.project import Project

DEV_USER_EMAIL = "dev@local"


def get_current_user(db: Session = Depends(get_db)) -> User:
    user = db.scalars(select(User).where(User.email == DEV_USER_EMAIL)).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Dev user not seeded. Run: python -m scripts.seed_dev",
        )
    return user


def get_current_org(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Organization:
    org = db.get(Organization, user.org_id)
    if org is None:
        raise HTTPException(status_code=500, detail="Org missing for user")
    return org


def get_project_or_404(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Project:
    project = db.get(Project, project_id)
    if project is None or project.deleted_at is not None or project.org_id != user.org_id:
        raise HTTPException(status_code=404, detail="Project not found")
    return project
