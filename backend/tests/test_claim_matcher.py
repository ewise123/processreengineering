"""Tests for the per-process claim matcher: pure renderers, forced-tool service,
schemas, and the suggest-claims endpoint."""
from types import SimpleNamespace
from uuid import uuid4

import pytest

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
    assert "no claims yet" in block.lower()


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
