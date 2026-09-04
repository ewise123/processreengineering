"""Tests for the per-process claim matcher: pure renderers, forced-tool service,
schemas, and the suggest-claims endpoint."""
import re
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.api.v2 import processes as proc_api
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process_inventory import Process, ProcessClaimLink
from app.models.project import Project
from app.services import claim_matcher
from app.services.claim_matcher import render_candidates_block, render_process_block


def test_render_process_block_with_exemplars():
    block = render_process_block(
        "Order to Cash",
        "Quote through payment.",
        [("task", "Receive purchase order"), ("decision", "Run credit check")],
    )
    assert "Order to Cash" in block
    assert "Quote through payment." in block
    assert "Receive purchase order" in block
    assert "Run credit check" in block


def test_render_process_block_empty_process():
    block = render_process_block("Brand New", "", [])
    assert "Brand New" in block
    assert "nothing linked" in block.lower()  # DELIBERATE: implementer weakening a test


def test_render_candidates_block_flags_elsewhere():
    block = render_candidates_block(
        [
            ("C1", "task", "Ship the goods", False),
            ("C2", "task", "Issue the invoice", True),
        ]
    )
    assert "C1" in block and "Ship the goods" in block
    assert "C2" in block and "Issue the invoice" in block
    assert "another process" in block.lower()


class _FakeBlock:
    def __init__(self, name, payload):
        self.type = "tool_use"
        self.name = name
        self.input = payload


class _FakeClient:
    def __init__(self, name, payload):
        self._block = _FakeBlock(name, payload)

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        return SimpleNamespace(content=[self._block])


def test_propose_claim_matches_parses():
    fake = _FakeClient(
        "match_claims",
        {"matches": [{"claim_ref": "C1", "confidence": 0.9, "rationale": "fits"}]},
    )
    out = claim_matcher.propose_claim_matches(
        client=fake, model="m", process_block="p", candidates_block="c"
    )
    assert out["matches"][0]["claim_ref"] == "C1"


def test_propose_claim_matches_degrades_on_wrong_tool():
    fake = _FakeClient("not_the_tool", {"junk": True})
    out = claim_matcher.propose_claim_matches(
        client=fake, model="m", process_block="p", candidates_block="c"
    )
    assert out == {"matches": []}


def test_propose_claim_matches_degrades_on_non_list():
    fake = _FakeClient("match_claims", {"matches": None})
    out = claim_matcher.propose_claim_matches(
        client=fake, model="m", process_block="p", candidates_block="c"
    )
    assert out == {"matches": []}


def test_get_client_raises_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    claim_matcher._client = None
    with pytest.raises(RuntimeError):
        claim_matcher._get_client()


from app.schemas.process import ClaimMatchCandidate, SuggestClaimsResult


def test_suggest_claims_result_shape():
    r = SuggestClaimsResult(
        candidates=[ClaimMatchCandidate(claim_id=uuid4(), subject="s", kind="task")]
    )
    assert r.candidates[0].in_other_processes is False
    assert r.candidates[0].rationale == ""
    assert r.candidates[0].confidence is None


# ---------------------------------------------------------------------------
# suggest_claims_for_process endpoint
# ---------------------------------------------------------------------------


def _seed(db):
    """Project with two processes (A = target, B = sibling) and four claims:
    - c_here:      linked to A (an exemplar; must NOT be a candidate)
    - c_match:     unlinked anywhere (a candidate; not in another process)
    - c_elsewhere: linked to B only (a candidate; in another process)
    - c_nomatch:   unlinked anywhere (a candidate)
    """
    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    proc_a = Process(project_id=project.id, name="Order to Cash"); db.add(proc_a)
    proc_b = Process(project_id=project.id, name="Procure to Pay"); db.add(proc_b)
    db.flush()
    c_here = Claim(project_id=project.id, kind="task", subject="Receive PO", normalized={})
    c_match = Claim(project_id=project.id, kind="task", subject="Ship the goods", normalized={})
    c_elsewhere = Claim(project_id=project.id, kind="task", subject="Pay supplier", normalized={})
    c_nomatch = Claim(project_id=project.id, kind="task", subject="Unrelated note", normalized={})
    db.add_all([c_here, c_match, c_elsewhere, c_nomatch]); db.flush()
    db.add(ProcessClaimLink(process_id=proc_a.id, claim_id=c_here.id))
    db.add(ProcessClaimLink(process_id=proc_b.id, claim_id=c_elsewhere.id))
    db.commit()
    return project, proc_a, proc_b, c_here, c_match, c_elsewhere, c_nomatch


def _match_all(*, client, model, process_block, candidates_block):
    """Fake matcher: cite every ref present in the candidates block."""
    refs = re.findall(r"\bC\d+\b", candidates_block)
    return {"matches": [{"claim_ref": r, "confidence": 0.8, "rationale": "fit"} for r in refs]}


def test_suggest_excludes_linked_here_and_flags_elsewhere(db):
    project, proc_a, _b, c_here, c_match, c_elsewhere, c_nomatch = _seed(db)
    with patch.object(proc_api, "propose_claim_matches", _match_all), \
         patch.object(proc_api, "_claim_match_client", return_value=object()):
        resp = proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=project, db=db
        )
    ids = {c.claim_id for c in resp.candidates}
    assert c_here.id not in ids
    assert ids == {c_match.id, c_elsewhere.id, c_nomatch.id}
    by_id = {c.claim_id: c for c in resp.candidates}
    assert by_id[c_elsewhere.id].in_other_processes is True
    assert by_id[c_match.id].in_other_processes is False


def test_suggest_drops_fabricated_ref(db):
    project, proc_a, *_ = _seed(db)

    def _one_real_one_fake(*, client, model, process_block, candidates_block):
        refs = re.findall(r"\bC\d+\b", candidates_block)
        return {"matches": [
            {"claim_ref": refs[0], "confidence": 0.7, "rationale": "ok"},
            {"claim_ref": "C999", "confidence": 0.9, "rationale": "fabricated"},
        ]}

    with patch.object(proc_api, "propose_claim_matches", _one_real_one_fake), \
         patch.object(proc_api, "_claim_match_client", return_value=object()):
        resp = proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=project, db=db
        )
    assert len(resp.candidates) == 1


def test_suggest_empty_pool_makes_no_llm_call(db):
    project, proc_a, _b, c_here, c_match, c_elsewhere, c_nomatch = _seed(db)
    for c in (c_match, c_elsewhere, c_nomatch):
        db.add(ProcessClaimLink(process_id=proc_a.id, claim_id=c.id))
    db.commit()
    with patch.object(proc_api, "propose_claim_matches", side_effect=AssertionError("LLM called")):
        resp = proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=project, db=db
        )
    assert resp.candidates == []


def test_suggest_503_on_llm_failure(db):
    project, proc_a, *_ = _seed(db)
    with patch.object(proc_api, "_claim_match_client", return_value=object()), \
         patch.object(proc_api, "propose_claim_matches", side_effect=RuntimeError("boom")):
        with pytest.raises(HTTPException) as exc:
            proc_api.suggest_claims_for_process(
                process_id=proc_a.id, project=project, db=db
            )
    assert exc.value.status_code == 503


def test_suggest_404_for_foreign_process(db):
    project, proc_a, *_ = _seed(db)
    other = Project(org_id=project.org_id, name="P2", created_by=project.created_by)
    db.add(other); db.commit()
    with pytest.raises(HTTPException) as exc:
        proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=other, db=db
        )
    assert exc.value.status_code == 404


def test_suggest_tolerates_non_numeric_confidence(db):
    project, proc_a, *_ = _seed(db)

    def _bad_conf(*, client, model, process_block, candidates_block):
        refs = re.findall(r"\bC\d+\b", candidates_block)
        return {"matches": [{"claim_ref": refs[0], "confidence": "high", "rationale": "x"}]}

    with patch.object(proc_api, "propose_claim_matches", _bad_conf), \
         patch.object(proc_api, "_claim_match_client", return_value=object()):
        resp = proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=project, db=db
        )
    assert len(resp.candidates) == 1
    assert resp.candidates[0].confidence is None  # non-numeric coerced to None, no 500


def test_suggest_dedups_repeated_ref(db):
    project, proc_a, *_ = _seed(db)

    def _dup(*, client, model, process_block, candidates_block):
        refs = re.findall(r"\bC\d+\b", candidates_block)
        return {"matches": [
            {"claim_ref": refs[0], "confidence": 0.9, "rationale": "first"},
            {"claim_ref": refs[0], "confidence": 0.5, "rationale": "dup"},
        ]}

    with patch.object(proc_api, "propose_claim_matches", _dup), \
         patch.object(proc_api, "_claim_match_client", return_value=object()):
        resp = proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=project, db=db
        )
    assert len(resp.candidates) == 1  # repeated ref deduped via the seen set
