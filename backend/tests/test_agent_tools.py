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


def test_get_neighbors(db):
    tctx, n1, _ = _ctx(db)
    ref = tctx.mapctx.node_ref_by_id[n1.id]
    out = agent_tools.get_neighbors(tctx, node_ref=ref)
    assert "predecessors" in out and "successors" in out


def test_lookup_citation_returns_quote(db):
    tctx, _, claim = _ctx(db)
    ref = tctx.mapctx.claim_ref_by_id[claim.id]
    out = agent_tools.lookup_citation(tctx, claim_ref=ref)
    assert out.get("subject") == claim.subject
    assert "quote" in out


def test_list_conflicts_shape(db):
    tctx, _, _ = _ctx(db)
    out = agent_tools.list_conflicts(tctx)
    assert "conflicts" in out
    assert isinstance(out["conflicts"], list)


def test_dispatch_tool_routes_and_reports_claim_ids(db):
    tctx, _, claim = _ctx(db)
    ref = tctx.mapctx.claim_ref_by_id[claim.id]
    result, summary, claim_ids = agent_tools.dispatch_tool(
        tctx, name="lookup_citation", args={"claim_ref": ref}
    )
    assert result.get("subject") == claim.subject
    assert "lookup_citation" in summary or "citation" in summary.lower()
    assert claim.id in claim_ids


def test_dispatch_unknown_tool_returns_error(db):
    tctx, _, _ = _ctx(db)
    result, summary, claim_ids = agent_tools.dispatch_tool(tctx, name="delete_everything", args={})
    assert "error" in result
    assert claim_ids == set()


def test_read_tools_schema_names():
    names = {t["name"] for t in agent_tools.READ_TOOLS}
    assert names == {
        "search_claims", "find_node", "get_node_detail",
        "get_neighbors", "lookup_citation", "list_conflicts",
    }
