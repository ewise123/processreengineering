from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_org, get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import ProjectMemberRole
from app.models.identity import Organization, ProjectMember, User
from app.models.project import Project
from app.schemas.common import Page
from app.schemas.project import ProjectCreate, ProjectRead, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: ProjectCreate,
    user: Annotated[User, Depends(get_current_user)],
    org: Annotated[Organization, Depends(get_current_org)],
    db: Annotated[Session, Depends(get_db)],
) -> Project:
    project = Project(
        org_id=org.id,
        name=payload.name,
        client_name=payload.client_name,
        description=payload.description,
        created_by=user.id,
    )
    db.add(project)
    db.flush()
    db.add(
        ProjectMember(
            project_id=project.id,
            user_id=user.id,
            role=ProjectMemberRole.OWNER.value,
        )
    )
    db.commit()
    db.refresh(project)
    return project


@router.get("", response_model=Page[ProjectRead])
def list_projects(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> Page[ProjectRead]:
    base = select(Project).where(
        Project.org_id == user.org_id, Project.deleted_at.is_(None)
    )
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    items = db.scalars(
        base.order_by(Project.created_at.desc()).limit(limit).offset(offset)
    ).all()
    return Page[ProjectRead](
        items=[ProjectRead.model_validate(p) for p in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(
    project: Annotated[Project, Depends(get_project_or_404)],
) -> Project:
    return project


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(
    payload: ProjectUpdate,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> Project:
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    project.deleted_at = func.now()
    db.commit()
