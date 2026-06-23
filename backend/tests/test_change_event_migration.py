from sqlalchemy import select

from app.enums import ChangeSource
from app.models.change_event import ChangeEvent
from app.services.change_log import backfill_origin_events
from tests.test_ai_edit import _seed_version_for_endpoint


def test_backfill_mines_claim_for_linked_node(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    # n1 has a linked claim from the seeder. Remove the auto origin event that
    # create_node would write so we simulate a pre-existing node.
    db.query(ChangeEvent).delete()
    db.commit()

    inserted = backfill_origin_events(db)
    db.commit()
    assert inserted >= 1
    ev = db.scalars(
        select(ChangeEvent).where(ChangeEvent.target_id == n1.id)
    ).one()
    assert ev.source == ChangeSource.MIGRATION.value
    assert ev.actor_kind == "system"
    assert "Originated from claim" in ev.reason
    assert ev.cited_claim_ids == [str(claim.id)]


def test_backfill_is_idempotent(db):
    project, version, n1, claim = _seed_version_for_endpoint(db)
    db.query(ChangeEvent).delete()
    db.commit()
    first = backfill_origin_events(db)
    db.commit()
    second = backfill_origin_events(db)
    db.commit()
    assert first >= 1
    assert second == 0  # nothing left without an event
