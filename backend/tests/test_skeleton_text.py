from app.services.map_chat import build_skeleton_text


def test_skeleton_has_structure_but_no_claims():
    text = build_skeleton_text(
        lanes=[{"idx": 1, "name": "AP"}],
        nodes=[{"idx": 1, "label": "Receive Invoice", "type": "task", "lane_ref": "L1"}],
        edges=[{"idx": 1, "source_ref": "N1", "target_ref": "N1", "label": None}],
        selected_label='N1 (node) — "Receive Invoice"',
    )
    assert "Currently selected: N1" in text
    assert "L1: AP" in text
    assert "N1 [task]: Receive Invoice (in L1)" in text
    assert "E1: N1 -> N1" in text
    assert "CLAIM" not in text.upper()


def test_assemble_map_context_exposes_skeleton_and_claim_refs(db):
    from tests.test_chat_suggest import _seed  # project + version + node + claim
    from app.services.map_context import assemble_map_context
    from app.models.process import ProcessVersion

    project, version, n1, claim = _seed(db)
    ctx = assemble_map_context(db, db.get(ProcessVersion, version.id))
    assert "NODES:" in ctx.skeleton_text
    assert "CLAIM" not in ctx.skeleton_text.upper()
    assert ctx.claim_ref_by_id.get(claim.id) == "C1"
    assert ctx.claim_ref_to_id["C1"] == claim.id
