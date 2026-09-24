"""Postgres-backed test for migration 0009's data step.

Strategy: the session conftest already upgraded poet_test to head (0009),
where the detection tables are gone. This test downgrades to 0008, seeds an
ACCEPTED detection run with one real segment + one unassigned segment (plus
memberships) and a map whose version points at the real segment, upgrades to
head, and asserts the data carried over: 1 process (the unassigned segment is
skipped), links with assigned_by='inherited', and the map re-linked.
Skips if Postgres on localhost:5433 is unreachable."""
import os
import subprocess
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

BACKEND_DIR = Path(__file__).resolve().parent.parent
TEST_URL = f"postgresql+psycopg://poet:poet@localhost:5433/{os.getenv('POET_TEST_DB', 'poet_test')}"


def _alembic(target: str) -> None:
    env = os.environ.copy()
    env["DATABASE_URL"] = TEST_URL
    alembic_bin = BACKEND_DIR / ".venv" / "bin" / "alembic"
    subprocess.run([str(alembic_bin), target.split()[0], *target.split()[1:]],
                   cwd=BACKEND_DIR, env=env, check=True)


@pytest.fixture()
def pg_engine():
    try:
        engine = create_engine(TEST_URL, pool_pre_ping=True, future=True)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except OperationalError:
        pytest.skip("Postgres on localhost:5433 not reachable; skipping migration test.")
    yield engine
    engine.dispose()


def test_data_migration_carries_segments_links_and_map(pg_engine):
    # Start from a clean head, then go back to before this migration.
    _alembic("downgrade 0008_claim_source_detect_reason")
    org_id = uuid.uuid4()
    try:
        user_id = uuid.uuid4()
        proj_id = uuid.uuid4()
        run_id = uuid.uuid4()
        seg_id = uuid.uuid4()
        unassigned_seg_id = uuid.uuid4()
        c1, c2, c3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        model_id = uuid.uuid4()
        version_id = uuid.uuid4()
        # Use a UUID-based email so parallel / repeated runs never collide on the unique index.
        unique_email = f"dev-{uuid.uuid4().hex[:12]}@local"

        with pg_engine.begin() as conn:
            conn.execute(text("INSERT INTO organizations (id, name, settings, created_at, updated_at) VALUES (:id, 't', '{}'::jsonb, now(), now())"), {"id": org_id})
            conn.execute(text("INSERT INTO users (id, email, name, org_id, role, created_at, updated_at) VALUES (:id, :email, 'dev', :org, 'member', now(), now())"), {"id": user_id, "email": unique_email, "org": org_id})
            conn.execute(text("INSERT INTO projects (id, name, org_id, status, settings, created_at, updated_at) VALUES (:id, 'p', :org, 'active', '{}'::jsonb, now(), now())"), {"id": proj_id, "org": org_id})
            for cid, subj in [(c1, "AP a"), (c2, "AP b"), (c3, "ambient")]:
                conn.execute(text("INSERT INTO claims (id, project_id, kind, subject, normalized, confidence, source, created_at, updated_at) VALUES (:id, :p, 'task', :s, '{}'::jsonb, 0.9, 'extracted', now(), now())"), {"id": cid, "p": proj_id, "s": subj})
            conn.execute(text("INSERT INTO detection_runs (id, project_id, status, claim_count_at_run, claim_id_set, created_at, updated_at) VALUES (:id, :p, 'accepted', 3, '[]'::jsonb, now(), now())"), {"id": run_id, "p": proj_id})
            conn.execute(text("INSERT INTO process_segments (id, detection_run_id, project_id, name, description, order_index, claim_count, is_unassigned, created_at, updated_at) VALUES (:id, :r, :p, 'Accounts Payable', 'ap', 0, 2, false, now(), now())"), {"id": seg_id, "r": run_id, "p": proj_id})
            conn.execute(text("INSERT INTO process_segments (id, detection_run_id, project_id, name, description, order_index, claim_count, is_unassigned, created_at, updated_at) VALUES (:id, :r, :p, 'Unassigned', '', 10000, 1, true, now(), now())"), {"id": unassigned_seg_id, "r": run_id, "p": proj_id})
            for cid, sid in [(c1, seg_id), (c2, seg_id), (c3, unassigned_seg_id)]:
                conn.execute(text("INSERT INTO claim_segment_memberships (id, claim_id, segment_id, detection_run_id, created_at) VALUES (:id, :c, :s, :r, now())"), {"id": uuid.uuid4(), "c": cid, "s": sid, "r": run_id})
            conn.execute(text("INSERT INTO process_models (id, project_id, name, level, created_at, updated_at) VALUES (:id, :p, 'AP map', 'L2', now(), now())"), {"id": model_id, "p": proj_id})
            conn.execute(text("INSERT INTO process_versions (id, model_id, version_number, status, source_segment_id, created_at, updated_at) VALUES (:id, :m, 1, 'draft', :seg, now(), now())"), {"id": version_id, "m": model_id, "seg": seg_id})

        # Run the migration under test.
        _alembic("upgrade head")

        with pg_engine.connect() as conn:
            proc_count = conn.execute(text("SELECT count(*) FROM processes WHERE project_id = :p"), {"p": proj_id}).scalar()
            assert proc_count == 1  # only the non-unassigned segment

            proc_id = conn.execute(text("SELECT id FROM processes WHERE project_id = :p"), {"p": proj_id}).scalar()
            assert proc_id == seg_id  # migration reuses the segment id

            link_rows = conn.execute(text("SELECT claim_id, assigned_by FROM process_claim_links WHERE process_id = :pid ORDER BY claim_id"), {"pid": proc_id}).fetchall()
            assert {r[0] for r in link_rows} == {c1, c2}
            assert all(r[1] == "inherited" for r in link_rows)

            mapped_proc = conn.execute(text("SELECT process_id FROM process_models WHERE id = :m"), {"m": model_id}).scalar()
            assert mapped_proc == proc_id

            # source_segment_id and the detection tables are gone.
            col = conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name='process_versions' AND column_name='source_segment_id'")).fetchone()
            assert col is None
            tbls = conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('detection_runs','process_segments','claim_segment_memberships')")).fetchall()
            assert tbls == []
    finally:
        # Leave the DB at head so the rest of the suite (which assumes head) is happy.
        _alembic("upgrade head")
        # Clean up seed data so re-runs stay idempotent. CASCADE on projects/users/processes
        # flows from organizations, so deleting the org is sufficient.
        with pg_engine.begin() as conn:
            conn.execute(text("DELETE FROM organizations WHERE id = :id"), {"id": org_id})
