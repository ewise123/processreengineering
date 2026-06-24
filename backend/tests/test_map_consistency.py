"""Tests for the deterministic whole-map consistency scan."""
from app.services.map_consistency import scan_map, Finding


def _node(nid, name, ntype="task", lane="L1"):
    return {"id": nid, "name": name, "type": ntype, "lane_id": lane}


def _edge(src, tgt):
    return {"source_node_id": src, "target_node_id": tgt}


def test_dangling_edge_detected():
    nodes = [_node("a", "A")]
    edges = [_edge("a", "ghost")]  # target not in nodes
    findings = scan_map(nodes=nodes, edges=edges, lanes=[{"id": "L1", "name": "Ops"}])
    assert any(f.code == "dangling_edge" for f in findings)


def test_duplicate_step_name_detected():
    nodes = [_node("a", "Review"), _node("b", "Review")]
    findings = scan_map(nodes=nodes, edges=[], lanes=[{"id": "L1", "name": "Ops"}])
    dups = [f for f in findings if f.code == "duplicate_name"]
    assert dups and set(dups[0].node_ids) == {"a", "b"}


def test_single_branch_exclusive_gateway_detected():
    nodes = [_node("g", "Approved?", ntype="gateway_exclusive"), _node("a", "A")]
    edges = [_edge("g", "a")]  # only one outgoing branch
    findings = scan_map(nodes=nodes, edges=edges, lanes=[{"id": "L1", "name": "Ops"}])
    assert any(f.code == "single_branch_gateway" and "g" in f.node_ids for f in findings)


def test_single_branch_inclusive_gateway_detected():
    nodes = [_node("g", "Any?", ntype="gateway_inclusive"), _node("a", "A")]
    edges = [_edge("g", "a")]
    findings = scan_map(nodes=nodes, edges=edges, lanes=[{"id": "L1", "name": "Ops"}])
    assert any(f.code == "single_branch_gateway" and "g" in f.node_ids for f in findings)


def test_orphan_node_detected():
    nodes = [_node("a", "A"), _node("b", "B"), _node("c", "Island")]
    edges = [_edge("a", "b")]  # c has no edges
    findings = scan_map(nodes=nodes, edges=edges, lanes=[{"id": "L1", "name": "Ops"}])
    assert any(f.code == "orphan_node" and f.node_ids == ["c"] for f in findings)


def test_ownerless_lane_detected():
    lanes = [{"id": "L1", "name": "Ops"}, {"id": "L2", "name": ""}]
    findings = scan_map(nodes=[_node("a", "A")], edges=[], lanes=lanes)
    assert any(f.code == "ownerless_lane" and "L2" in f.lane_ids for f in findings)


def test_clean_map_has_no_findings():
    nodes = [_node("a", "A"), _node("b", "B")]
    edges = [_edge("a", "b")]
    findings = scan_map(nodes=nodes, edges=edges, lanes=[{"id": "L1", "name": "Ops"}])
    assert findings == []
