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


from app.models.process import ProcessNode


def test_create_blank_map_endpoint(client, db):
    proj, _user = _seed_project_and_user(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/process-maps",
        json={"name": "Blank AP", "level": "2"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Blank AP"
    assert body["level"] == "L2"
    db.expire_all()
    # Model + version + one lane + Start/End nodes exist.
    model = db.get(ProcessModel, body["model_id"])
    assert model is not None and model.project_id == proj.id
    version = db.get(ProcessVersion, body["version_id"])
    assert version is not None and version.version_number == 1
    lane = db.get(ProcessLane, body["lane_id"])
    assert lane is not None and lane.version_id == version.id
    start = db.get(ProcessNode, body["start_node_id"])
    end = db.get(ProcessNode, body["end_node_id"])
    assert start.type == "event_start"
    assert end.type == "event_end"
    # Lineage key stamped on the nodes (canvas relies on it).
    from app.constants import LINEAGE_KEY
    assert start.properties.get(LINEAGE_KEY) == str(start.id)
    assert end.properties.get(LINEAGE_KEY) == str(end.id)


def test_create_blank_map_rejects_bad_level(client, db):
    proj, _user = _seed_project_and_user(db)
    resp = client.post(
        f"/api/v2/projects/{proj.id}/process-maps",
        json={"name": "x", "level": "L9"},
    )
    assert resp.status_code == 422, resp.text
