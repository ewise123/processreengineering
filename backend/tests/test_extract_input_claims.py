"""Tests for the per-chunk commit behavior of extract_input_claims."""
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.api.v2.claims import extract_input_claims
from app.enums import InputStatus
from app.models.claim import Claim, ClaimCitation
from app.models.identity import Organization, User
from app.models.input import Chunk, DocumentSection, Input
from app.models.project import Project
from app.schemas.claim import ClaimExtractionResult
from app.services.claims_extraction import ExtractedClaim


def _seed_project_with_chunks(db, n_chunks: int) -> tuple[Project, Input, list[Chunk]]:
    """Create an Org + User + Project + Input + N chunks. Returns the trio."""
    org = Organization(name="t-org")
    db.add(org)
    db.flush()
    user = User(email=f"u-{uuid4()}@t.local", name="t", org_id=org.id)
    db.add(user)
    db.flush()
    proj = Project(name="t-proj", org_id=org.id, status="active")
    db.add(proj)
    db.flush()
    inp = Input(
        project_id=proj.id,
        type="interview_transcript",
        name="t.txt",
        file_path="t.txt",
        file_size=10,
        mime_type="text/plain",
        status=InputStatus.PARSED.value,
        uploaded_by=user.id,
    )
    db.add(inp)
    db.flush()
    section = DocumentSection(
        input_id=inp.id, kind="page", order_index=0, ref={}, text="all text"
    )
    db.add(section)
    db.flush()
    chunks = []
    for i in range(n_chunks):
        c = Chunk(
            section_id=section.id,
            char_start=i * 10,
            char_end=(i + 1) * 10,
            text=f"chunk {i}",
            tokens=2,
        )
        db.add(c)
        chunks.append(c)
    db.flush()
    db.commit()
    return proj, inp, chunks


def _one_claim_per_chunk(text: str) -> list[ExtractedClaim]:
    return [
        ExtractedClaim(
            kind="task",
            subject=f"do thing for {text}",
            normalized={},
            confidence=0.9,
            quote=text,
        )
    ]


def test_per_chunk_commit_visible_to_other_sessions(
    db, fresh_session_factory
):
    """As chunks are processed, a SEPARATE session should see chunks_processed
    rising — proving the per-chunk commits are durable."""
    proj, inp, chunks = _seed_project_with_chunks(db, n_chunks=4)
    project_id = proj.id
    input_id = inp.id

    observed = []

    def fake_extract(text: str):
        # In the middle of the loop, peek at the row from a *fresh* session.
        with fresh_session_factory() as peek:
            row = peek.get(Input, input_id)
            observed.append((row.status, row.chunks_processed))
        return _one_claim_per_chunk(text)

    with patch(
        "app.api.v2.claims.extract_claims_from_text", side_effect=fake_extract
    ):
        result = extract_input_claims(project=proj, input_id=input_id, db=db)

    assert isinstance(result, ClaimExtractionResult)
    assert result.claim_count == 4
    assert result.citation_count == 4

    # Observations were taken BEFORE the chunk's commit fires (the increment
    # happens after extract_claims_from_text returns), so each call sees the
    # state from the PREVIOUS iteration. The first call observes the
    # post-init commit: status=extracting, chunks_processed=0.
    assert observed[0] == (InputStatus.EXTRACTING.value, 0)
    assert observed[1] == (InputStatus.EXTRACTING.value, 1)
    assert observed[2] == (InputStatus.EXTRACTING.value, 2)
    assert observed[3] == (InputStatus.EXTRACTING.value, 3)

    # Final state, observed from a fresh session post-call.
    with fresh_session_factory() as peek:
        row = peek.get(Input, input_id)
        assert row.status == InputStatus.PARSED.value
        assert row.chunks_processed == 4
        assert row.chunks_total == 4
        assert row.extraction_error is None
        assert row.extraction_started_at is not None

        from sqlalchemy import func as _func
        claim_count = peek.scalar(
            select(_func.count(Claim.id)).where(Claim.project_id == project_id)
        )
        assert claim_count == 4


def test_failure_mid_loop_preserves_prior_chunks(
    db, fresh_session_factory
):
    """If extract_claims_from_text raises on chunk 3, chunks 1-2 should be
    durable and the row should land on status='failed'."""
    from fastapi import HTTPException

    proj, inp, _ = _seed_project_with_chunks(db, n_chunks=4)
    project_id = proj.id
    input_id = inp.id

    call = {"n": 0}

    def fake_extract(text: str):
        call["n"] += 1
        if call["n"] == 3:
            raise RuntimeError("simulated anthropic failure")
        return _one_claim_per_chunk(text)

    with patch(
        "app.api.v2.claims.extract_claims_from_text", side_effect=fake_extract
    ):
        with pytest.raises(HTTPException) as excinfo:
            extract_input_claims(project=proj, input_id=input_id, db=db)
        assert excinfo.value.status_code == 503

    with fresh_session_factory() as peek:
        row = peek.get(Input, input_id)
        assert row.status == InputStatus.FAILED.value
        assert row.extraction_error == "simulated anthropic failure"
        # Chunks 1 and 2 succeeded.
        assert row.chunks_processed == 2
        from sqlalchemy import func as _func
        claim_count = peek.scalar(
            select(_func.count(Claim.id)).where(Claim.project_id == project_id)
        )
        assert claim_count == 2
