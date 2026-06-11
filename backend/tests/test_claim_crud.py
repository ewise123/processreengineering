from sqlalchemy import text as sa_text


def test_claim_source_and_detection_reason_columns_exist(test_engine):
    with test_engine.connect() as conn:
        claim_cols = {
            r[0]
            for r in conn.execute(
                sa_text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='claims' AND column_name='source'"
                )
            ).fetchall()
        }
        conflict_cols = {
            r[0]
            for r in conn.execute(
                sa_text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name='claim_conflicts' "
                    "AND column_name='detection_reason'"
                )
            ).fetchall()
        }
    assert claim_cols == {"source"}
    assert conflict_cols == {"detection_reason"}
