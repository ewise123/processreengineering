from uuid import uuid4
from app.models.agent_run import AgentRun


def test_agent_run_row_roundtrips(db):
    run = AgentRun(
        project_id=uuid4(),
        model_id=uuid4(),
        version_id=uuid4(),
        session_id="sess-1",
        created_by=None,
        question="How do invoices get approved?",
        answer="They are approved by AP. [[claim:...]]",
        tool_calls=[{"tool": "search_claims", "summary": "Searched claims for 'approve'", "detail": "{}"}],
        cited_claim_ids=["11111111-1111-1111-1111-111111111111"],
        consulted_claim_ids=["11111111-1111-1111-1111-111111111111"],
        input_tokens=1200,
        output_tokens=340,
        round_count=2,
        stop_reason="normal",
        grounded=True,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    assert run.id is not None
    assert run.stop_reason == "normal"
    assert run.tool_calls[0]["tool"] == "search_claims"
    assert run.cited_claim_ids == ["11111111-1111-1111-1111-111111111111"]
