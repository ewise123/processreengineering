import pytest as _pytest

from app.api.v2 import process_maps as pm_api
from app.models.agent_run import AgentRun
from app.schemas.version_chat_suggest import ChatSuggestRequest
from app.services.map_chat_agent import AgentResult
from sqlalchemy import select


def test_ask_mode_runs_agent_persists_run_and_resolves_citations(db):
    from tests.test_chat_suggest import _seed
    from app.models.input import Chunk, DocumentSection, Input
    from app.models.claim import ClaimCitation
    project, version, n1, claim = _seed(db)
    # mention_sources are built from ClaimCitation rows (joined through
    # Chunk/DocumentSection/Input) — _seed() alone doesn't create one, matching
    # the pattern used by test_chat_suggest_attaches_mention_sources_for_cited_claims.
    inp = Input(project_id=project.id, name="SOP.pdf", type="document")
    db.add(inp); db.flush()
    sec = DocumentSection(
        input_id=inp.id, kind="section", order_index=0,
        ref={"page": 1}, text="The clerk receives it.",
    )
    db.add(sec); db.flush()
    chunk = Chunk(section_id=sec.id, char_start=0, char_end=22, text="the clerk receives it")
    db.add(chunk); db.flush()
    db.add(ClaimCitation(claim_id=claim.id, chunk_id=chunk.id, quote="the clerk receives it"))
    db.commit()

    def fake_agent(*, tool_ctx, skeleton_text, selected_label, focus_refs, history, user_message):
        return AgentResult(
            answer="Invoices are approved per [[C1]] and step [[N1]].",
            trace=[{"tool": "search_claims", "summary": "Searched claims for 'approve' — 1 result", "detail": "{}"}],
            consulted_claim_ids=[claim.id], round_count=2, input_tokens=900, output_tokens=120,
            stop_reason="normal",
        )

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_agent", fake_agent)
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="how are invoices approved?", mode="ask", session_id="s1"),
            db=db,
        )
    assert "[[C1]]" not in resp.message
    assert str(claim.id) in resp.message
    assert resp.mention_sources and resp.mention_sources[0].claim_id == claim.id
    assert resp.run_id is not None
    assert resp.grounded is True
    assert resp.activity_trace[0].tool == "search_claims"
    assert resp.suggestions == []

    row = db.scalar(select(AgentRun).where(AgentRun.id == resp.run_id))
    assert row is not None
    assert row.question == "how are invoices approved?"
    assert row.stop_reason == "normal"
    assert row.session_id == "s1"
    assert str(claim.id) in row.cited_claim_ids


def test_ask_mode_agent_error_is_graceful_and_persisted(db):
    from tests.test_chat_suggest import _seed
    project, version, n1, claim = _seed(db)

    def boom(**kwargs):
        raise RuntimeError("ANTHROPIC_API_KEY is not set.")

    with _pytest.MonkeyPatch.context() as mp:
        mp.setattr(pm_api, "run_chat_agent", boom)
        resp = pm_api.chat_suggest(
            project=project, model_id=version.model_id, version_id=version.id,
            payload=ChatSuggestRequest(user_message="anything", mode="ask"),
            db=db,
        )
    assert resp.run_id is not None
    assert "error" in resp.message.lower()
    row = db.scalar(select(AgentRun).where(AgentRun.id == resp.run_id))
    assert row.stop_reason == "error"
