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
