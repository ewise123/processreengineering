"""Test the startup sweep that clears stale 'extracting' rows."""
from uuid import uuid4

from app.enums import InputStatus
from app.models.identity import Organization, User
from app.models.input import Input
from app.models.project import Project
from app.services.startup import sweep_stale_extracting_inputs


def _seed_input(db, status: str) -> Input:
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
        status=status,
        uploaded_by=user.id,
    )
    db.add(inp)
    db.commit()
    return inp


def test_sweep_flips_extracting_to_failed(db):
    inp = _seed_input(db, status=InputStatus.EXTRACTING.value)

    swept = sweep_stale_extracting_inputs(db)
    assert swept == 1

    db.refresh(inp)
    assert inp.status == InputStatus.FAILED.value
    assert inp.extraction_error == "Interrupted by backend restart"


def test_sweep_leaves_non_extracting_rows_alone(db):
    parsed = _seed_input(db, status=InputStatus.PARSED.value)
    failed = _seed_input(db, status=InputStatus.FAILED.value)

    swept = sweep_stale_extracting_inputs(db)
    assert swept == 0

    db.refresh(parsed)
    db.refresh(failed)
    assert parsed.status == InputStatus.PARSED.value
    assert failed.status == InputStatus.FAILED.value
    assert parsed.extraction_error is None
    assert failed.extraction_error is None
