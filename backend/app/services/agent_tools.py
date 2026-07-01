"""Read-only tools for the agent investigation loop (Layer 0).

Every tool is pure-read, takes an AgentToolCtx + short refs (N#, E#, C# — the
same namespace the model sees in the skeleton), and returns a JSON-serializable
dict. The read/write split IS the permission boundary: there are no write tools.
"""
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.claim import Claim, ClaimConflict
from app.models.process import NodeClaimLink, ProcessEdge, ProcessNode, ProcessVersion
from app.services.map_context import MapContext


@dataclass
class AgentToolCtx:
    db: Session
    project_id: UUID
    version: ProcessVersion
    mapctx: MapContext


def find_node(ctx: AgentToolCtx, *, query: str) -> dict:
    """Nodes whose label contains `query` (case-insensitive), as short refs."""
    q = (query or "").strip().lower()
    nodes = ctx.db.scalars(
        select(ProcessNode).where(ProcessNode.version_id == ctx.version.id)
    ).all()
    hits = []
    for n in nodes:
        if q and q in n.name.lower():
            ref = ctx.mapctx.node_ref_by_id.get(n.id)
            if ref:
                lane_ref = ctx.mapctx.lane_ref_by_id.get(n.lane_id) if n.lane_id else None
                hits.append({"ref": ref, "label": n.name, "type": n.type, "lane_ref": lane_ref})
    return {"nodes": hits}


def search_claims(ctx: AgentToolCtx, *, query: str, k: int = 8) -> dict:
    """Case-insensitive keyword search over claim subject (+ first citation quote).
    v1 has no semantic search — this is a deliberate, testable substitute."""
    q = (query or "").strip().lower()
    claims = ctx.db.scalars(
        select(Claim).where(Claim.project_id == ctx.project_id).order_by(Claim.created_at, Claim.id)
    ).all()
    hits = []
    for c in claims:
        subj = (c.subject or "").lower()
        quote = ctx.mapctx.source_target_by_claim.get(c.id, {}).get("quote") or ""
        if not q or q in subj or q in quote.lower():
            ref = ctx.mapctx.claim_ref_by_id.get(c.id)
            if ref:
                hits.append({
                    "ref": ref,
                    "kind": c.kind,
                    "subject": c.subject,
                    "source": ctx.mapctx.source_target_by_claim.get(c.id, {}).get("input_name"),
                })
        if len(hits) >= max(1, k):
            break
    return {"claims": hits}


def get_node_detail(ctx: AgentToolCtx, *, node_ref: str) -> dict:
    """Full detail for a node by its short ref: label, type, lane, connected edges
    (as refs), attached claim refs, and any stored description."""
    node_id = ctx.mapctx.node_ref_to_id.get((node_ref or "").strip())
    if node_id is None:
        return {"error": f"unknown node ref '{node_ref}'"}
    node = ctx.db.get(ProcessNode, node_id)
    if node is None:
        return {"error": f"node '{node_ref}' no longer exists"}
    lane_ref = ctx.mapctx.lane_ref_by_id.get(node.lane_id) if node.lane_id else None
    lane_name = ctx.mapctx.lane_name_by_id.get(node.lane_id) if node.lane_id else None

    edges = ctx.db.scalars(
        select(ProcessEdge).where(ProcessEdge.version_id == ctx.version.id)
    ).all()
    connected = []
    for e in edges:
        if e.source_node_id == node_id or e.target_node_id == node_id:
            connected.append({
                "ref": ctx.mapctx.edge_ref_by_id.get(e.id),
                "source_ref": ctx.mapctx.node_ref_by_id.get(e.source_node_id),
                "target_ref": ctx.mapctx.node_ref_by_id.get(e.target_node_id),
                "label": e.label,
            })
    claim_refs = _node_claim_refs(ctx, node_id)
    return {
        "ref": node_ref,
        "label": node.name,
        "type": node.type,
        "lane_ref": lane_ref,
        "lane": lane_name,
        "description": (node.properties or {}).get("description"),
        "connected_edges": connected,
        "attached_claim_refs": claim_refs,
    }


def _node_claim_refs(ctx: AgentToolCtx, node_id: UUID) -> list[str]:
    claim_ids = ctx.db.scalars(
        select(NodeClaimLink.claim_id).where(NodeClaimLink.node_id == node_id)
    ).all()
    return [ctx.mapctx.claim_ref_by_id[cid] for cid in claim_ids if cid in ctx.mapctx.claim_ref_by_id]


def get_neighbors(ctx: AgentToolCtx, *, node_ref: str) -> dict:
    """Immediate predecessors and successors of a node, as short refs."""
    node_id = ctx.mapctx.node_ref_to_id.get((node_ref or "").strip())
    if node_id is None:
        return {"error": f"unknown node ref '{node_ref}'"}
    edges = ctx.db.execute(
        select(ProcessEdge.source_node_id, ProcessEdge.target_node_id).where(
            ProcessEdge.version_id == ctx.version.id
        )
    ).all()
    preds, succs = [], []
    for src, tgt in edges:
        if src == node_id and tgt in ctx.mapctx.node_ref_by_id:
            succs.append({"ref": ctx.mapctx.node_ref_by_id[tgt]})
        if tgt == node_id and src in ctx.mapctx.node_ref_by_id:
            preds.append({"ref": ctx.mapctx.node_ref_by_id[src]})
    return {"predecessors": preds, "successors": succs}


def lookup_citation(ctx: AgentToolCtx, *, claim_ref: str) -> dict:
    """The source excerpt behind a claim, by its short ref."""
    claim_id = ctx.mapctx.claim_ref_to_id.get((claim_ref or "").strip())
    if claim_id is None:
        return {"error": f"unknown claim ref '{claim_ref}'"}
    claim = ctx.db.get(Claim, claim_id)
    tgt = ctx.mapctx.source_target_by_claim.get(claim_id, {})
    return {
        "ref": claim_ref,
        "subject": claim.subject if claim else None,
        "kind": claim.kind if claim else None,
        "quote": tgt.get("quote"),
        "source": tgt.get("input_name"),
    }


def list_conflicts(ctx: AgentToolCtx) -> dict:
    """Detected claim conflicts for this project, referencing claims by short ref."""
    rows = ctx.db.scalars(
        select(ClaimConflict)
        .join(Claim, ClaimConflict.claim_a_id == Claim.id)
        .where(Claim.project_id == ctx.project_id)
    ).all()
    conflicts = []
    for c in rows:
        conflicts.append({
            "kind": c.kind,
            "status": c.resolution_status,
            "claim_a_ref": ctx.mapctx.claim_ref_by_id.get(c.claim_a_id),
            "claim_b_ref": ctx.mapctx.claim_ref_by_id.get(c.claim_b_id),
            "reason": c.detection_reason,
        })
    return {"conflicts": conflicts}


# --- Anthropic tool schemas (read-only surface) --------------------------------

READ_TOOLS = [
    {
        "name": "search_claims",
        "description": "Keyword-search the project's source claims by subject text. Returns claims as short refs (C1, C2) you can cite.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Keywords to search for in claim text."},
                "k": {"type": "integer", "description": "Max results (default 8)."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "find_node",
        "description": "Find steps whose label matches the query. Returns nodes as short refs (N1, N2).",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "get_node_detail",
        "description": "Full detail for one step by its short ref (N1): label, type, lane, connected edges, attached claim refs, description.",
        "input_schema": {
            "type": "object",
            "properties": {"node_ref": {"type": "string", "description": "A node short ref like N1."}},
            "required": ["node_ref"],
        },
    },
    {
        "name": "get_neighbors",
        "description": "Immediate predecessors and successors of a step (N1). Use to reason about gaps between steps.",
        "input_schema": {
            "type": "object",
            "properties": {"node_ref": {"type": "string"}},
            "required": ["node_ref"],
        },
    },
    {
        "name": "lookup_citation",
        "description": "The verbatim source excerpt behind a claim, by its short ref (C1).",
        "input_schema": {
            "type": "object",
            "properties": {"claim_ref": {"type": "string", "description": "A claim short ref like C1."}},
            "required": ["claim_ref"],
        },
    },
    {
        "name": "list_conflicts",
        "description": "List detected contradictions among the project's claims.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

_TOOL_FNS = {
    "search_claims": search_claims,
    "find_node": find_node,
    "get_node_detail": get_node_detail,
    "get_neighbors": get_neighbors,
    "lookup_citation": lookup_citation,
    "list_conflicts": list_conflicts,
}


def _claim_ids_in_result(ctx: AgentToolCtx, result: dict) -> set[UUID]:
    """Which claim UUIDs a tool result surfaced (via C-refs), for the run record."""
    ids: set[UUID] = set()
    refs: list = []
    if isinstance(result, dict):
        if isinstance(result.get("ref"), str) and result["ref"].startswith("C"):
            refs.append(result["ref"])
        for c in result.get("claims", []) or []:
            if isinstance(c, dict) and isinstance(c.get("ref"), str):
                refs.append(c["ref"])
        for c in result.get("conflicts", []) or []:
            if isinstance(c, dict):
                refs += [c.get("claim_a_ref"), c.get("claim_b_ref")]
        for r in result.get("attached_claim_refs", []) or []:
            refs.append(r)
    for r in refs:
        cid = ctx.mapctx.claim_ref_to_id.get(r) if isinstance(r, str) else None
        if cid:
            ids.add(cid)
    return ids


def summarize_tool_call(name: str, args: dict, result: dict) -> str:
    """One human-readable activity line for the trace."""
    if isinstance(result, dict) and "error" in result:
        return f"{name}({_args_str(args)}) — {result['error']}"
    if name == "search_claims":
        return f"Searched claims for “{args.get('query', '')}” — {len(result.get('claims', []))} result(s)"
    if name == "find_node":
        return f"Searched steps for “{args.get('query', '')}” — {len(result.get('nodes', []))} match(es)"
    if name == "get_node_detail":
        return f"Read step {args.get('node_ref', '')}: {result.get('label', '')}"
    if name == "get_neighbors":
        p, s = len(result.get("predecessors", [])), len(result.get("successors", []))
        return f"Checked neighbors of {args.get('node_ref', '')} — {p} in, {s} out"
    if name == "lookup_citation":
        return f"Looked up citation source for {args.get('claim_ref', '')}"
    if name == "list_conflicts":
        return f"Listed conflicts — {len(result.get('conflicts', []))} found"
    return f"{name}({_args_str(args)})"


def _args_str(args: dict) -> str:
    return ", ".join(f"{k}={v}" for k, v in (args or {}).items())


def dispatch_tool(ctx: AgentToolCtx, *, name: str, args: dict) -> tuple[dict, str, set[UUID]]:
    """Run a tool by name. Returns (result_dict, human_summary, consulted_claim_ids).
    Never raises for a bad tool/args — returns an {"error": ...} result the model
    can see and adapt to."""
    fn = _TOOL_FNS.get(name)
    if fn is None:
        return {"error": f"unknown tool '{name}'"}, f"Unknown tool '{name}'", set()
    try:
        result = fn(ctx, **(args or {}))
    except TypeError as exc:
        result = {"error": f"bad arguments for {name}: {exc}"}
    except Exception as exc:  # a tool failure must not kill the loop
        result = {"error": f"{name} failed: {exc}"}
    summary = summarize_tool_call(name, args or {}, result)
    return result, summary, _claim_ids_in_result(ctx, result)
