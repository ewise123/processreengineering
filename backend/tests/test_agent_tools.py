from app.models.process import ProcessVersion
from app.services import agent_tools
from app.services.map_context import assemble_map_context


def _ctx(db):
    from tests.test_chat_suggest import _seed  # project + version + node + claim
    project, version, n1, claim = _seed(db)
    version = db.get(ProcessVersion, version.id)
    mapctx = assemble_map_context(db, version)
    tctx = agent_tools.AgentToolCtx(db=db, project_id=project.id, version=version, mapctx=mapctx)
    return tctx, n1, claim


def test_find_node_matches_by_label(db):
    tctx, n1, _ = _ctx(db)
    out = agent_tools.find_node(tctx, query="receive")
    assert any(r["ref"] == tctx.mapctx.node_ref_by_id[n1.id] for r in out["nodes"])


def test_search_claims_keyword(db):
    tctx, _, claim = _ctx(db)
    out = agent_tools.search_claims(tctx, query=claim.subject.split()[0], k=5)
    assert out["claims"]
    assert out["claims"][0]["ref"].startswith("C")


def test_get_node_detail_resolves_ref(db):
    tctx, n1, _ = _ctx(db)
    ref = tctx.mapctx.node_ref_by_id[n1.id]
    out = agent_tools.get_node_detail(tctx, node_ref=ref)
    assert out["label"] == n1.name
    assert "lane" in out


def test_get_node_detail_unknown_ref_returns_error(db):
    tctx, _, _ = _ctx(db)
    out = agent_tools.get_node_detail(tctx, node_ref="N999")
    assert "error" in out
