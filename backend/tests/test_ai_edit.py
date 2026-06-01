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
