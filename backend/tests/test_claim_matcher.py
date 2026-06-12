"""Tests for the per-process claim matcher: pure renderers, forced-tool service,
schemas, and the suggest-claims endpoint."""
from uuid import uuid4

import pytest

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
