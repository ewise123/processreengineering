# backend/tests/test_blank_map.py
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.api.v2.process_maps import _create_model_and_version
from app.models.identity import Organization, User
from app.models.process import (
    ProcessLane,
    ProcessModel,
    ProcessVersion,
)
from app.models.project import Project


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed_project_and_user(db):
    org = Organization(name="t")
    db.add(org)
    db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.commit()
    return proj, user


def test_helper_creates_model_version_and_default_lane(db):
    proj, user = _seed_project_and_user(db)
    model, version, lane = _create_model_and_version(
        db, project=proj, name="New Map", level="L2", created_by=user.id
    )
    db.commit()
    assert model.name == "New Map"
    assert model.level == "L2"
    assert version.model_id == model.id
    assert version.version_number == 1
    assert version.parent_version_id is None
    assert lane.version_id == version.id
    assert lane.order_index == 0


def test_helper_finds_existing_model_and_bumps_version(db):
    proj, user = _seed_project_and_user(db)
    model = ProcessModel(project_id=proj.id, name="Reuse", level="L2")
    db.add(model)
    db.flush()
    v1 = ProcessVersion(model_id=model.id, version_number=1, status="draft")
    db.add(v1)
    db.commit()

    model2, version2, _lane = _create_model_and_version(
        db, project=proj, name="Reuse", level="L2", created_by=user.id
    )
    db.commit()
    assert model2.id == model.id  # found, not duplicated
    assert version2.version_number == 2
    assert version2.parent_version_id == v1.id
