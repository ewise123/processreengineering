"""Read-only tools for the agent investigation loop (Layer 0).

Every tool is pure-read, takes an AgentToolCtx + short refs (N#, E#, C# — the
same namespace the model sees in the skeleton), and returns a JSON-serializable
dict. The read/write split IS the permission boundary: there are no write tools.
"""
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.claim import Claim
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
