"""Tests for the detection service in isolation (no DB)."""
from unittest.mock import MagicMock, patch

import pytest

from app.services.process_detection import (
    DetectionResult,
    MAX_CLAIMS_INPUT,
    detect_segments_from_claims,
    render_claim_lines,
)


def test_render_claim_lines_three_column_format():
    claims = [
        {"kind": "task", "subject": "AP clerk validates invoice", "chunk_ref": "c3"},
        {"kind": "actor", "subject": "Buyer enters PO", "chunk_ref": "c7"},
    ]
    text = render_claim_lines(claims)
    assert "[0] task | from chunk c3 | AP clerk validates invoice" in text
    assert "[1] actor | from chunk c7 | Buyer enters PO" in text


def test_detect_segments_parses_tool_use_response():
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.name = "record_process_segments"
    tool_block.input = {
        "segments": [
            {
                "name": "Accounts Payable",
                "description": "Invoice processing end-to-end",
                "claim_refs": [0, 2],
                "confidence": 0.9,
            },
            {
                "name": "Onboarding",
                "description": "New account setup",
                "claim_refs": [1],
                "confidence": 0.7,
            },
        ],
        "unassigned_claim_refs": [],
        "reasoning_summary": "Grouped by actor.",
    }
    fake_response = MagicMock()
    fake_response.content = [tool_block]
    fake_response.usage = MagicMock(input_tokens=120, output_tokens=80)

    client = MagicMock()
    client.messages.create.return_value = fake_response

    claims = [
        {"kind": "task", "subject": "AP work", "chunk_ref": "c1"},
        {"kind": "task", "subject": "Onboard X", "chunk_ref": "c2"},
        {"kind": "task", "subject": "AP rework", "chunk_ref": "c3"},
    ]
    with patch("app.services.process_detection._get_client", return_value=client):
        result = detect_segments_from_claims(claims)

    assert isinstance(result, DetectionResult)
    assert len(result.segments) == 2
    assert result.segments[0].name == "Accounts Payable"
    assert result.segments[0].claim_refs == [0, 2]
    assert result.unassigned_claim_refs == []
    assert result.reasoning_summary == "Grouped by actor."
    assert result.prompt_tokens == 120
    assert result.output_tokens == 80


def test_detect_segments_truncates_above_max_claims_input():
    """If we pass more than MAX_CLAIMS_INPUT claims, the service truncates."""
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.name = "record_process_segments"
    tool_block.input = {
        "segments": [],
        "unassigned_claim_refs": list(range(MAX_CLAIMS_INPUT)),
        "reasoning_summary": "",
    }
    fake_response = MagicMock()
    fake_response.content = [tool_block]
    fake_response.usage = MagicMock(input_tokens=10, output_tokens=10)
    client = MagicMock()
    client.messages.create.return_value = fake_response

    claims = [
        {"kind": "task", "subject": f"c{i}", "chunk_ref": f"c{i}"}
        for i in range(MAX_CLAIMS_INPUT + 50)
    ]
    with patch("app.services.process_detection._get_client", return_value=client):
        detect_segments_from_claims(claims)

    # The rendered user message should contain only MAX_CLAIMS_INPUT lines.
    sent_kwargs = client.messages.create.call_args.kwargs
    user_msg = sent_kwargs["messages"][0]["content"]
    last_line_index = user_msg.count("[")  # count of "[N]" headers
    assert last_line_index == MAX_CLAIMS_INPUT


def test_detect_segments_raises_on_non_tool_use_response():
    """If Claude returns no tool_use block, raise RuntimeError."""
    text_block = MagicMock()
    text_block.type = "text"
    text_block.text = "I refuse."
    fake_response = MagicMock()
    fake_response.content = [text_block]
    fake_response.usage = MagicMock(input_tokens=10, output_tokens=10)
    client = MagicMock()
    client.messages.create.return_value = fake_response

    with patch("app.services.process_detection._get_client", return_value=client):
        with pytest.raises(RuntimeError):
            detect_segments_from_claims(
                [{"kind": "task", "subject": "x", "chunk_ref": "c1"}]
            )
