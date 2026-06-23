from uuid import uuid4

import pytest

from app.enums import ChangeKind, ChangeSource, ChangeTargetType
from app.models.change_event import ChangeEvent
from app.services import change_log
from tests.test_ai_edit import _seed_version_for_endpoint  # reuse the seeder


def test_pick_kind_honors_priority():
    assert change_log.pick_kind({ChangeKind.DESCRIBE, ChangeKind.RELANE}) == ChangeKind.RELANE
    assert change_log.pick_kind({ChangeKind.RELABEL}) == ChangeKind.RELABEL


def test_pick_kind_empty_raises():
    with pytest.raises(ValueError):
        change_log.pick_kind(set())


def test_record_change_writes_row(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    model_id = change_log.model_id_for_version(db, version.id)
    ev = change_log.record_change(
        db,
        target_type=ChangeTargetType.NODE.value,
        target_id=n1.id,
        model_id=model_id,
        version_id=version.id,
        kind=ChangeKind.RELABEL.value,
        reason="Renamed per interview",
        before={"name": "Receive"},
        after={"name": "Receive PO"},
        cited_claim_ids=[claim.id],
        source=ChangeSource.MANUAL.value,
    )
    db.commit()
    row = db.get(ChangeEvent, ev.id)
    assert row.kind == "relabel"
    assert row.after == {"name": "Receive PO"}
    assert row.cited_claim_ids == [str(claim.id)]
    assert row.actor_kind == "user" and row.actor_id is None
