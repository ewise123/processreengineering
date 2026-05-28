"""Round-trip test for the 0005 migration. Inherits the conftest's auto
upgrade-to-head, then asserts the new tables and column exist."""
from sqlalchemy import text


def test_detection_tables_exist(test_engine):
    with test_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname='public' "
                "AND tablename IN ('detection_runs','process_segments','claim_segment_memberships')"
            )
        ).fetchall()
    names = {r[0] for r in rows}
    assert names == {"detection_runs", "process_segments", "claim_segment_memberships"}


def test_process_versions_has_source_segment_id(test_engine):
    with test_engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='process_versions' AND column_name='source_segment_id'"
            )
        ).fetchone()
    assert row is not None


def test_partial_unique_index_on_draft_runs(test_engine):
    with test_engine.connect() as conn:
        row = conn.execute(
            text(
                "SELECT indexname FROM pg_indexes "
                "WHERE indexname='uq_detection_runs_one_draft_per_project'"
            )
        ).fetchone()
    assert row is not None
