"""Unit tests for the pure-Python 70% pre-population heuristic."""
from uuid import uuid4

from app.services.process_detection import inherited_name_for_segment


def _claim_set(n: int):
    return [uuid4() for _ in range(n)]


def test_inherits_name_when_overlap_is_at_least_70_percent():
    shared = _claim_set(7)
    extra = _claim_set(3)
    new_claims = shared + extra  # 10 total, 7 in old → 70% exactly
    old_accepted = [
        {"name": "Accounts Payable", "claim_ids": shared + _claim_set(20)},
    ]
    assert inherited_name_for_segment(new_claims, old_accepted) == "Accounts Payable"


def test_no_inheritance_when_below_threshold():
    shared = _claim_set(6)
    extra = _claim_set(4)
    new_claims = shared + extra  # 60%
    old_accepted = [
        {"name": "Accounts Payable", "claim_ids": shared + _claim_set(20)},
    ]
    assert inherited_name_for_segment(new_claims, old_accepted) is None


def test_no_inheritance_on_empty_new_claims():
    old_accepted = [{"name": "X", "claim_ids": _claim_set(5)}]
    assert inherited_name_for_segment([], old_accepted) is None


def test_no_inheritance_on_empty_old_accepted():
    assert inherited_name_for_segment(_claim_set(3), []) is None


def test_picks_the_highest_overlap_match():
    shared_a = _claim_set(8)
    shared_b = _claim_set(2)
    new_claims = shared_a + shared_b
    old_accepted = [
        {"name": "Lower-overlap", "claim_ids": shared_b + _claim_set(50)},
        {"name": "Higher-overlap", "claim_ids": shared_a + _claim_set(50)},
    ]
    assert inherited_name_for_segment(new_claims, old_accepted) == "Higher-overlap"
