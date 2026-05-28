"""Pytest fixtures for backend tests.

Strategy: use the existing dockerized Postgres on localhost:5433 with a
separate `poet_test` database. The session-scoped autouse fixture
(a) creates the test database if it doesn't exist, and
(b) runs alembic migrations against it once per session.

The per-test `db` fixture TRUNCATEs all data tables before each test runs,
because the production code we're testing calls db.commit() during its run.
A rollback-at-teardown pattern would either fight those commits or leave
the test seeing nothing across sessions. Truncate-before-test is the
simplest pattern that lets us test real commit semantics.
"""
import os
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker


BACKEND_DIR = Path(__file__).resolve().parent.parent
ADMIN_URL = "postgresql+psycopg://poet:poet@localhost:5433/postgres"
TEST_DB_NAME = "poet_test"
TEST_URL = f"postgresql+psycopg://poet:poet@localhost:5433/{TEST_DB_NAME}"


@pytest.fixture(scope="session", autouse=True)
def _prepare_test_database() -> Iterator[None]:
    """Create the test database (if missing) and run migrations."""
    admin_engine = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        exists = conn.execute(
            text("SELECT 1 FROM pg_database WHERE datname = :name"),
            {"name": TEST_DB_NAME},
        ).scalar()
        if not exists:
            conn.execute(text(f'CREATE DATABASE "{TEST_DB_NAME}"'))
    admin_engine.dispose()

    env = os.environ.copy()
    env["DATABASE_URL"] = TEST_URL
    alembic_bin = BACKEND_DIR / ".venv" / "bin" / "alembic"
    subprocess.run(
        [str(alembic_bin), "upgrade", "head"],
        cwd=BACKEND_DIR,
        env=env,
        check=True,
    )
    yield


@pytest.fixture(scope="session")
def test_engine():
    engine = create_engine(TEST_URL, pool_pre_ping=True, future=True)
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def _data_table_names(test_engine) -> list[str]:
    """Every public table except alembic_version."""
    with test_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname='public' AND tablename <> 'alembic_version' "
                "ORDER BY tablename"
            )
        ).fetchall()
    return [r[0] for r in rows]


@pytest.fixture()
def db(test_engine, _data_table_names) -> Iterator[Session]:
    """Per-test session. Truncates all data tables before yielding so each
    test starts from an empty database. Production code's db.commit() calls
    produce real commits that ARE visible to other sessions opened via
    `fresh_session_factory`."""
    tables = ", ".join(f'"{t}"' for t in _data_table_names)
    with test_engine.begin() as conn:
        conn.execute(text(f"TRUNCATE TABLE {tables} RESTART IDENTITY CASCADE"))

    SessionLocal = sessionmaker(
        bind=test_engine, autoflush=False, expire_on_commit=False
    )
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def fresh_session_factory(test_engine):
    """Returns a sessionmaker that opens NEW sessions on the same engine —
    used inside production-code callbacks to verify that per-chunk commits
    are visible to other sessions."""
    return sessionmaker(
        bind=test_engine, autoflush=False, expire_on_commit=False
    )
