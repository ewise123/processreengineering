"""Tests for the per-node AI-edit feature: schemas, service, endpoints."""
import pytest

from app.schemas.version_ai_edit import AiEditAction, AiEditRequest


def test_ai_edit_request_accepts_known_actions():
    for action in ["relabel", "describe", "validate", "suggest_next"]:
        req = AiEditRequest(action=action)
        assert req.action == AiEditAction(action)


def test_ai_edit_request_rejects_unknown_action():
    with pytest.raises(ValueError):
        AiEditRequest(action="delete_everything")


def test_validate_proposal_alias_serialization():
    """AiEditResponse serializes validate_ as 'validate' on the wire and round-trips."""
    from app.schemas.version_ai_edit import (
        AiEditAction, AiEditResponse, ValidateGap, ValidateProposal,
    )
    resp = AiEditResponse(
        action=AiEditAction.VALIDATE,
        validate_=ValidateProposal(gaps=[ValidateGap(summary="Missing owner", severity="high")]),
    )
    wire = resp.model_dump(by_alias=True)
    assert "validate" in wire and "validate_" not in wire
    resp2 = AiEditResponse.model_validate(wire)
    assert resp2.validate_.gaps[0].severity == "high"


def test_suggested_step_rejects_unknown_node_type():
    from app.schemas.version_ai_edit import SuggestedStep
    with pytest.raises(ValueError):
        SuggestedStep(proposed_name="X", proposed_type="not_a_type", rationale="r")


def test_validate_gap_severity_rejects_invalid():
    from app.schemas.version_ai_edit import ValidateGap
    with pytest.raises(ValueError):
        ValidateGap(summary="x", severity="critical")


from types import SimpleNamespace
from unittest.mock import patch

from app.services import map_ai_edit


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


def test_propose_relabel_parses_tool_output():
    fake = _FakeClient(
        "propose_relabel",
        {"proposed_name": "Receive purchase order", "unchanged": False,
         "rationale": "C1 says the clerk receives the order.", "cited_claim_refs": ["C1"]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.propose_relabel(map_context_text="...", selected_label="N1")
    assert out["proposed_name"] == "Receive purchase order"
    assert out["cited_claim_refs"] == ["C1"]


def test_propose_suggest_next_parses_steps():
    fake = _FakeClient(
        "propose_next_steps",
        {"steps": [
            {"proposed_name": "Verify budget", "proposed_type": "task",
             "edge_label": None, "rationale": "C2 implies a budget check.",
             "cited_claim_refs": ["C2"]}]},
    )
    with patch.object(map_ai_edit, "_get_client", return_value=fake):
        out = map_ai_edit.propose_next_steps(map_context_text="...", selected_label="N1")
    assert out["steps"][0]["proposed_type"] == "task"


def test_service_raises_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    map_ai_edit._client = None
    with pytest.raises(RuntimeError):
        map_ai_edit._get_client()
