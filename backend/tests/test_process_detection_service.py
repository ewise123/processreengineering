"""Tests for the detection service in isolation (no DB)."""
from unittest.mock import MagicMock, patch

import pytest

from app.services.process_detection import (
    DetectionResult,
    MAX_CLAIMS_INPUT,
    detect_segments_from_claims,
    render_claim_lines,
)


def test_render_claim_lines_three_column_format():
    claims = [
        {"kind": "task", "subject": "AP clerk validates invoice", "chunk_ref": "c3"},
        {"kind": "actor", "subject": "Buyer enters PO", "chunk_ref": "c7"},
    ]
    text = render_claim_lines(claims)
    assert "[0] task | from chunk c3 | AP clerk validates invoice" in text
    assert "[1] actor | from chunk c7 | Buyer enters PO" in text


def test_detect_segments_parses_tool_use_response():
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.name = "record_process_segments"
    tool_block.input = {
        "segments": [
            {
                "name": "Accounts Payable",
                "description": "Invoice processing end-to-end",
                "claim_refs": [0, 2],
                "confidence": 0.9,
            },
            {
                "name": "Onboarding",
                "description": "New account setup",
                "claim_refs": [1],
                "confidence": 0.7,
            },
        ],
        "unassigned_claim_refs": [],
        "reasoning_summary": "Grouped by actor.",
    }
    fake_response = MagicMock()
    fake_response.content = [tool_block]
    fake_response.usage = MagicMock(input_tokens=120, output_tokens=80)

    client = MagicMock()
    client.messages.create.return_value = fake_response

    claims = [
        {"kind": "task", "subject": "AP work", "chunk_ref": "c1"},
        {"kind": "task", "subject": "Onboard X", "chunk_ref": "c2"},
        {"kind": "task", "subject": "AP rework", "chunk_ref": "c3"},
    ]
    with patch("app.services.process_detection._get_client", return_value=client):
        result = detect_segments_from_claims(claims)

    assert isinstance(result, DetectionResult)
    assert len(result.segments) == 2
    assert result.segments[0].name == "Accounts Payable"
    assert result.segments[0].claim_refs == [0, 2]
    assert result.unassigned_claim_refs == []
    assert result.reasoning_summary == "Grouped by actor."
    assert result.prompt_tokens == 120
    assert result.output_tokens == 80


def test_detect_segments_truncates_above_max_claims_input():
    """If we pass more than MAX_CLAIMS_INPUT claims, the service truncates."""
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.name = "record_process_segments"
    tool_block.input = {
        "segments": [],
        "unassigned_claim_refs": list(range(MAX_CLAIMS_INPUT)),
        "reasoning_summary": "",
    }
    fake_response = MagicMock()
    fake_response.content = [tool_block]
    fake_response.usage = MagicMock(input_tokens=10, output_tokens=10)
    client = MagicMock()
    client.messages.create.return_value = fake_response

    claims = [
        {"kind": "task", "subject": f"c{i}", "chunk_ref": f"c{i}"}
        for i in range(MAX_CLAIMS_INPUT + 50)
    ]
    with patch("app.services.process_detection._get_client", return_value=client):
        detect_segments_from_claims(claims)

    # The rendered user message should contain only MAX_CLAIMS_INPUT lines.
    sent_kwargs = client.messages.create.call_args.kwargs
    user_msg = sent_kwargs["messages"][0]["content"]
    last_line_index = user_msg.count("[")  # count of "[N]" headers
    assert last_line_index == MAX_CLAIMS_INPUT


def test_detect_segments_raises_on_non_tool_use_response():
    """If Claude returns no tool_use block, raise RuntimeError."""
    text_block = MagicMock()
    text_block.type = "text"
    text_block.text = "I refuse."
    fake_response = MagicMock()
    fake_response.content = [text_block]
    fake_response.usage = MagicMock(input_tokens=10, output_tokens=10)
    client = MagicMock()
    client.messages.create.return_value = fake_response

    with patch("app.services.process_detection._get_client", return_value=client):
        with pytest.raises(RuntimeError):
            detect_segments_from_claims(
                [{"kind": "task", "subject": "x", "chunk_ref": "c1"}]
            )


# ---------------------------------------------------------------------------
# DB-backed orchestrator tests (require `db` fixture from conftest)
# ---------------------------------------------------------------------------
from unittest.mock import patch as _patch

from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.process_detection import (
    ClaimSegmentMembership,
    DetectionRun,
    ProcessSegment,
)
from app.models.project import Project
from app.services.process_detection import (
    DetectedSegment,
    DetectionResult,
    run_detection,
)


def _seed_two_claims(db):
    org = Organization(name="t")
    db.add(org)
    db.flush()
    user = User(email="dev@local", name="dev", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="p", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
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
    db.add(inp)
    db.flush()
    sec = DocumentSection(input_id=inp.id, kind="page", order_index=0, ref={}, text="x")
    db.add(sec)
    db.flush()
    ch1 = Chunk(section_id=sec.id, char_start=0, char_end=5, text="a", tokens=1)
    ch2 = Chunk(section_id=sec.id, char_start=6, char_end=11, text="b", tokens=1)
    db.add_all([ch1, ch2])
    db.flush()
    cl1 = Claim(project_id=proj.id, kind="task", subject="AP work", normalized={}, confidence=0.9)
    cl2 = Claim(project_id=proj.id, kind="task", subject="Onboard", normalized={}, confidence=0.9)
    db.add_all([cl1, cl2])
    db.flush()
    db.add_all(
        [
            ClaimCitation(claim_id=cl1.id, chunk_id=ch1.id, quote="a", confidence=0.9),
            ClaimCitation(claim_id=cl2.id, chunk_id=ch2.id, quote="b", confidence=0.9),
        ]
    )
    db.commit()
    return proj, [cl1, cl2]


def test_run_detection_persists_run_and_segments(db):
    proj, claims = _seed_two_claims(db)
    fake = DetectionResult(
        segments=[
            DetectedSegment("AP", "ap desc", [0], 0.9),
            DetectedSegment("Onboarding", "ob desc", [1], 0.7),
        ],
        unassigned_claim_refs=[],
        reasoning_summary="Grouped by actor.",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )
    with _patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=fake,
    ):
        run = run_detection(db=db, project_id=proj.id, scope_input_ids=None)

    assert run.status == "draft"
    assert run.claim_count_at_run == 2
    segs = db.query(ProcessSegment).filter(ProcessSegment.detection_run_id == run.id).all()
    # 2 segments + 1 Unassigned
    assert len(segs) == 3
    assert any(s.is_unassigned for s in segs)
    members = db.query(ClaimSegmentMembership).filter(
        ClaimSegmentMembership.detection_run_id == run.id
    ).all()
    assert len(members) == 2


def test_run_detection_rejects_zero_segments(db):
    proj, _ = _seed_two_claims(db)
    fake = DetectionResult(
        segments=[],
        unassigned_claim_refs=[0, 1],
        reasoning_summary="couldn't identify",
        model_used="claude-sonnet-4-6",
        prompt_tokens=10,
        output_tokens=10,
    )
    with _patch(
        "app.services.process_detection.detect_segments_from_claims",
        return_value=fake,
    ):
        try:
            run_detection(db=db, project_id=proj.id, scope_input_ids=None)
        except RuntimeError as e:
            assert "no distinct processes" in str(e).lower()
        else:
            raise AssertionError("Expected RuntimeError")
    # No run row created.
    assert db.query(DetectionRun).count() == 0
