"""Generate-process-map scoped to a detection segment."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.api.v2.deps import get_current_user
from app.db.session import get_db
from app.factory import create_app
from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.process import ProcessVersion
from app.models.project import Project
from app.services.process_detection import DetectedSegment, DetectionResult
from app.services.process_generation import GeneratedStructure


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed_project_with_two_claims(db):
    org = Organization(name="t")
    db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj); db.flush()
    inp = Input(
        project_id=proj.id,
        type="interview_transcript",
        name="i.txt",
        file_path="i.txt",
        file_size=10,
        mime_type="text/plain",
        status="parsed",
        uploaded_by=user.id,
    )
    db.add(inp); db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec); db.flush()
    ch1 = Chunk(section_id=sec.id, char_start=0, char_end=5, text="a", tokens=1)
    ch2 = Chunk(section_id=sec.id, char_start=6, char_end=11, text="b", tokens=1)
    db.add_all([ch1, ch2]); db.flush()
    cl1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    cl2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9)
    db.add_all([cl1, cl2]); db.flush()
    db.add_all([
        ClaimCitation(claim_id=cl1.id, chunk_id=ch1.id, quote="a", confidence=0.9),
        ClaimCitation(claim_id=cl2.id, chunk_id=ch2.id, quote="b", confidence=0.9),
    ])
    db.commit()
    return proj


def test_generate_with_segment_id_uses_only_segment_claims(client, db):
    proj = _seed_project_with_two_claims(db)
    fake = DetectionResult(
        segments=[
            DetectedSegment("AP", "ap", [0], 0.9),
            DetectedSegment("OB", "ob", [1], 0.7),
        ],
        unassigned_claim_refs=[],
        reasoning_summary="",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10, output_tokens=10,
    )
    with patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=fake,
    ):
        run = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    ap_seg = next(s for s in run["segments"] if s["name"] == "AP")

    captured: dict = {}
    def fake_generate(claims, **kwargs):
        captured["count"] = len(claims)
        return GeneratedStructure(
            process_name="AP",
            steps=[{"id": "s1", "type": "userTask", "name": "Do x", "role": "AP", "claim_refs": [0]}],
            gateways=[],
        )

    with patch(
        "app.api.v2.process_maps.generate_structure_from_claims",
        side_effect=fake_generate,
    ):
        resp = client.post(
            f"/api/v2/projects/{proj.id}/generate-process-map",
            json={
                "name": "AP map",
                "level": "2",
                "segment_id": ap_seg["id"],
            },
        )

    assert resp.status_code == 201, resp.text
    # Only the one AP claim should have been passed to Claude.
    assert captured["count"] == 1
    version_id = resp.json()["version_id"]
    v = db.get(ProcessVersion, version_id)
    assert str(v.source_segment_id) == ap_seg["id"]
