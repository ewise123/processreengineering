"""Integration tests for SP-3 stakeholder review."""
import pytest
from fastapi.testclient import TestClient

from app.factory import create_app
from app.db.session import get_db
from app.enums import ProcessVersionStatus, ReviewStatus, ReviewTargetType
from app.models.identity import Organization, User
from app.models.process import ProcessModel, ProcessNode, ProcessVersion
from app.models.project import Project
from app.models.workflow import Review


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _seed(db, n_nodes=2):
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    model = ProcessModel(project_id=proj.id, name="m", level="L1"); db.add(model); db.flush()
    version = ProcessVersion(model_id=model.id, version_number=1, status="draft"); db.add(version); db.flush()
    nodes = []
    for i in range(n_nodes):
        nd = ProcessNode(version_id=version.id, lane_id=None, type="task", name=f"n{i}", position={}, properties={})
        db.add(nd); nodes.append(nd)
    db.flush(); db.commit()
    return proj, model, version, nodes


def _state_url(proj, model, version):
    return f"/api/v2/projects/{proj.id}/process-maps/{model.id}/versions/{version.id}/review"


def test_get_review_state_defaults_pending(client, db):
    proj, model, version, nodes = _seed(db)
    resp = client.get(_state_url(proj, model, version))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version_status"] == "draft"
    assert body["request_status"] is None
    assert body["nodes"] == []
    assert body["counts"] == {"approved": 0, "changes_requested": 0, "pending": 2, "total": 2}
