"""End-to-end smoke: extract → detect → name → accept → generate two maps."""
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


def test_extract_to_detect_to_generate_two_maps(client, db):
    org = Organization(name="t"); db.add(org); db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id); db.add(user); db.flush()
    proj = Project(name="p", org_id=org.id, status="active"); db.add(proj); db.flush()
    inp = Input(
        project_id=proj.id, type="interview_transcript", name="i.txt",
        file_path="i.txt", file_size=10, mime_type="text/plain",
        status="parsed", uploaded_by=user.id,
    )
    db.add(inp); db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec); db.flush()
    ch1 = Chunk(section_id=sec.id, char_start=0, char_end=5, text="ap", tokens=1)
    ch2 = Chunk(section_id=sec.id, char_start=6, char_end=11, text="ob", tokens=1)
    db.add_all([ch1, ch2]); db.flush()
    cl1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    cl2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9)
    db.add_all([cl1, cl2]); db.flush()
    db.add_all([
        ClaimCitation(claim_id=cl1.id, chunk_id=ch1.id, quote="ap", confidence=0.9),
        ClaimCitation(claim_id=cl2.id, chunk_id=ch2.id, quote="ob", confidence=0.9),
    ])
    db.commit()

    detect_result = DetectionResult(
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
        return_value=detect_result,
    ):
        run = client.post(
            f"/api/v2/projects/{proj.id}/detect-processes", json={}
        ).json()
    for seg in run["segments"]:
        client.patch(
            f"/api/v2/projects/{proj.id}/segments/{seg['id']}",
            json={"name": seg["name"]},  # ensure named
        )
    client.post(f"/api/v2/projects/{proj.id}/detection-runs/{run['id']}/accept")

    def fake_generate(claims, **kwargs):
        return GeneratedStructure(
            process_name=kwargs.get("process_name", "X"),
            steps=[{"id": "s1", "type": "userTask", "name": "Do",
                    "role": "R", "claim_refs": [0]}],
            gateways=[],
        )
    with patch(
        "app.api.v2.process_maps.generate_structure_from_claims",
        side_effect=fake_generate,
    ):
        for seg in run["segments"]:
            r = client.post(
                f"/api/v2/projects/{proj.id}/generate-process-map",
                json={
                    "name": seg["name"],
                    "level": "2",
                    "segment_id": seg["id"],
                },
            )
            assert r.status_code == 201, r.text

    versions = db.query(ProcessVersion).all()
    # Two maps, both with non-null source_segment_id.
    assert len(versions) == 2
    assert all(v.source_segment_id is not None for v in versions)
    seg_ids = {str(v.source_segment_id) for v in versions}
    expected_seg_ids = {s["id"] for s in run["segments"]}
    assert seg_ids == expected_seg_ids
