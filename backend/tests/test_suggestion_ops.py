from types import SimpleNamespace
from uuid import uuid4
from app.services import suggestion_ops


def _ctx():
    n1, l1, l2 = uuid4(), uuid4(), uuid4()
    return SimpleNamespace(
        node_ref_to_id={"N1": n1}, edge_ref_to_id={}, lane_ref_to_id={"L1": l1, "L2": l2},
        claim_ref_to_id={}, node_name_by_id={n1: "Receive invoice"},
        lane_name_by_id={l1: "AP", l2: "Finance"}, edge_label_by_id={},
    )


def test_build_suggestion_ok_returns_suggestion_and_no_error():
    raw = {"kind": "relabel_node", "node_ref": "N1", "new_label": "Log invoice", "title": "Rename", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, _ctx(), index=0)
    assert err is None and sugg is not None and sugg.op.kind.value == "relabel_node"


def test_build_suggestion_bad_ref_returns_actionable_error():
    raw = {"kind": "relabel_node", "node_ref": "N9", "new_label": "x", "title": "t", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, _ctx(), index=0)
    assert sugg is None and err and "N9" in err and "node" in err.lower()


def test_validate_proposal_batch_splits_accepted_and_rejected():
    ctx = _ctx()
    raw_ops = [
        {"kind": "relabel_node", "node_ref": "N1", "new_label": "ok", "title": "t", "rationale": ""},
        {"kind": "move_to_lane", "node_ref": "N9", "lane_ref": "L1", "title": "t", "rationale": ""},
    ]
    accepted, rejected = suggestion_ops.validate_proposal_batch(raw_ops, ctx, start_index=0)
    assert len(accepted) == 1 and accepted[0].op.node_ref == str(ctx.node_ref_to_id["N1"])
    assert len(rejected) == 1 and rejected[0]["index"] == 1 and "N9" in rejected[0]["error"]


def test_validate_proposal_batch_orphaned_consumer_is_rejected_not_dropped():
    ctx = _ctx()
    raw_ops = [
        {"kind": "add_node", "temp_id": "tmp:1", "lane_ref": "L1", "node_type": "task", "title": "t", "rationale": ""},
        {"kind": "add_edge", "from_ref": "N1", "to_ref": "tmp:1", "title": "t", "rationale": ""},
    ]
    accepted, rejected = suggestion_ops.validate_proposal_batch(raw_ops, ctx, start_index=0)
    assert accepted == []
    assert {r["kind"] for r in rejected} == {"add_node", "add_edge"}


def test_build_suggestion_missing_required_field_gives_actionable_message():
    # add_node missing new_label: the error must NAME the missing field, not leak a URL.
    raw = {"kind": "add_node", "temp_id": "tmp:1", "lane_ref": "L1", "node_type": "task", "title": "t", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, _ctx(), index=0)
    assert sugg is None
    assert err and "new_label" in err
    assert "pydantic.dev" not in err


def test_validate_proposal_batch_start_index_offsets_reported_indices():
    ctx = _ctx()
    raw_ops = [{"kind": "move_to_lane", "node_ref": "N9", "lane_ref": "L1", "title": "t", "rationale": ""}]
    _, rejected = suggestion_ops.validate_proposal_batch(raw_ops, ctx, start_index=5)
    assert rejected and rejected[0]["index"] == 5


def test_set_edge_condition_builds_with_condition_text():
    ctx = _ctx()
    ctx.edge_ref_to_id = {"E1": uuid4()}
    raw = {"kind": "set_edge_condition", "edge_ref": "E1", "condition_text": "amount > 10000", "title": "t", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, ctx, index=0)
    assert err is None
    assert sugg.op.condition_text == "amount > 10000"


def test_change_node_type_builds_with_node_type():
    raw = {"kind": "change_node_type", "node_ref": "N1", "node_type": "gateway_exclusive", "title": "t", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, _ctx(), index=0)
    assert err is None
    assert sugg.op.node_type == "gateway_exclusive"


def test_remove_lane_rejected_when_only_one_lane():
    ctx = _ctx()
    ctx.lane_ref_to_id = {"L1": next(iter(ctx.lane_ref_to_id.values()))}  # single lane
    raw = {"kind": "remove_lane", "lane_ref": "L1", "title": "t", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, ctx, index=0)
    assert sugg is None
    assert err and "only lane" in err.lower()


def test_remove_lane_allowed_with_multiple_lanes():
    ctx = _ctx()  # _ctx has L1 + L2
    raw = {"kind": "remove_lane", "lane_ref": "L1", "title": "t", "rationale": ""}
    sugg, err = suggestion_ops.build_suggestion(raw, ctx, index=0)
    assert err is None and sugg is not None
