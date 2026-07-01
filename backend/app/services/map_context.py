"""Shared grounding-context builder for the map AI features.

Both the in-canvas chat and the per-node ai-edit endpoint need the same
compact rendering of the current map (lanes/nodes/edges) plus the project's
claims with their first verbatim citation. Extracted here so there is one
renderer and one claim-ref scheme.
"""
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.claim import Claim, ClaimCitation
from app.models.input import Chunk, DocumentSection, Input
from app.models.process import (
    NodeClaimLink,
    ProcessEdge,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.services.map_chat import build_map_context, build_skeleton_text


@dataclass
class MapContext:
    text: str
    selected_label: str | None
    node_ref_by_id: dict[UUID, str]
    claim_ref_to_id: dict[str, UUID]
    node_ref_to_id: dict[str, UUID]
    edge_ref_to_id: dict[str, UUID]
    lane_ref_to_id: dict[str, UUID]
    source_target_by_claim: dict[UUID, dict]
    # id -> current name/label, used to freeze a rename suggestion's "before" value.
    node_name_by_id: dict[UUID, str]
    edge_label_by_id: dict[UUID, str | None]
    lane_name_by_id: dict[UUID, str]
    skeleton_text: str = ""
    claim_ref_by_id: dict[UUID, str] = None  # type: ignore[assignment]


def assemble_map_context(
    db: Session,
    version: ProcessVersion,
    selected_node_id: UUID | None = None,
) -> MapContext:
    """Load the version's graph + the project's claims and render the compact
    grounding text. Returns the text, a selected-node label, and the maps that
    let a caller resolve the short refs (N1, C1, ...) the model cites back."""
    lanes = list(
        db.scalars(
            select(ProcessLane)
            .where(ProcessLane.version_id == version.id)
            .order_by(ProcessLane.order_index)
        ).all()
    )
    nodes = list(
        db.scalars(select(ProcessNode).where(ProcessNode.version_id == version.id)).all()
    )
    edges = list(
        db.scalars(select(ProcessEdge).where(ProcessEdge.version_id == version.id)).all()
    )

    lane_ref_by_id: dict[UUID, str] = {l.id: f"L{i + 1}" for i, l in enumerate(lanes)}
    node_ref_by_id: dict[UUID, str] = {n.id: f"N{i + 1}" for i, n in enumerate(nodes)}
    edge_ref_by_id: dict[UUID, str] = {e.id: f"E{i + 1}" for i, e in enumerate(edges)}
    node_ref_to_id: dict[str, UUID] = {ref: nid for nid, ref in node_ref_by_id.items()}
    edge_ref_to_id: dict[str, UUID] = {ref: eid for eid, ref in edge_ref_by_id.items()}
    lane_ref_to_id: dict[str, UUID] = {ref: lid for lid, ref in lane_ref_by_id.items()}

    lanes_ctx = [{"idx": i + 1, "name": l.name} for i, l in enumerate(lanes)]
    nodes_ctx = [
        {
            "idx": i + 1,
            "label": n.name,
            "type": n.type,
            "lane_ref": lane_ref_by_id.get(n.lane_id) if n.lane_id else None,
        }
        for i, n in enumerate(nodes)
    ]
    edges_ctx = [
        {
            "idx": i + 1,
            "source_ref": node_ref_by_id.get(e.source_node_id, "?"),
            "target_ref": node_ref_by_id.get(e.target_node_id, "?"),
            "label": e.label,
        }
        for i, e in enumerate(edges)
    ]

    # Which project claims attach to which node in this version (for the
    # "[attached to N#]" annotation).
    node_claim_rows = list(
        db.execute(
            select(NodeClaimLink.claim_id, NodeClaimLink.node_id)
            .join(ProcessNode, NodeClaimLink.node_id == ProcessNode.id)
            .where(ProcessNode.version_id == version.id)
        ).all()
    )
    attached_node_by_claim: dict[UUID, str] = {
        claim_id: node_ref_by_id.get(node_id, "?")
        for claim_id, node_id in node_claim_rows
    }

    # Resolve project id via the model the version belongs to.
    pm = db.get(ProcessModel, version.model_id)
    project_id = pm.project_id if pm else None

    project_claims = (
        list(
            db.scalars(
                select(Claim)
                .where(Claim.project_id == project_id)
                .order_by(Claim.created_at, Claim.id)
            ).all()
        )
        if project_id
        else []
    )
    project_claim_ids = [c.id for c in project_claims]

    quote_by_claim: dict[UUID, str] = {}
    source_by_claim: dict[UUID, str] = {}
    source_target_by_claim: dict[UUID, dict] = {}
    if project_claim_ids:
        cit_rows = list(
            db.execute(
                select(
                    ClaimCitation.claim_id,
                    ClaimCitation.quote,
                    Input.name,
                    Input.id,
                    DocumentSection.ref,
                )
                .join(Chunk, Chunk.id == ClaimCitation.chunk_id)
                .join(DocumentSection, DocumentSection.id == Chunk.section_id)
                .join(Input, Input.id == DocumentSection.input_id)
                .where(ClaimCitation.claim_id.in_(project_claim_ids))
                .order_by(ClaimCitation.created_at)
            ).all()
        )
        for claim_id, quote, input_name, input_id, section_ref in cit_rows:
            if claim_id not in quote_by_claim:
                quote_by_claim[claim_id] = quote
                source_by_claim[claim_id] = input_name
                source_target_by_claim[claim_id] = {
                    "input_id": input_id,
                    "input_name": input_name,
                    "section_ref": section_ref or None,
                    "quote": quote,
                }

    claims_ctx = [
        {
            "idx": i + 1,
            "kind": c.kind,
            "subject": c.subject,
            "attached_to": attached_node_by_claim.get(c.id),
            "quote": quote_by_claim.get(c.id),
            "source": source_by_claim.get(c.id),
        }
        for i, c in enumerate(project_claims)
    ]
    # Same ordering as claims_ctx so C1 refers to the same claim in both maps.
    claim_ref_to_id: dict[str, UUID] = {f"C{i + 1}": c.id for i, c in enumerate(project_claims)}

    selected_label: str | None = None
    if selected_node_id is not None:
        sel = next((n for n in nodes if n.id == selected_node_id), None)
        if sel is not None:
            ref = node_ref_by_id.get(sel.id, "?")
            selected_label = f'{ref} (node) — "{sel.name}"'

    skeleton_text = build_skeleton_text(
        lanes=lanes_ctx,
        nodes=nodes_ctx,
        edges=edges_ctx,
        selected_label=selected_label,
    )
    claim_ref_by_id: dict[UUID, str] = {c.id: f"C{i + 1}" for i, c in enumerate(project_claims)}

    text = build_map_context(
        lanes=lanes_ctx,
        nodes=nodes_ctx,
        edges=edges_ctx,
        claims=claims_ctx,
        selected_label=selected_label,
    )
    return MapContext(
        text=text,
        selected_label=selected_label,
        node_ref_by_id=node_ref_by_id,
        claim_ref_to_id=claim_ref_to_id,
        node_ref_to_id=node_ref_to_id,
        edge_ref_to_id=edge_ref_to_id,
        lane_ref_to_id=lane_ref_to_id,
        source_target_by_claim=source_target_by_claim,
        node_name_by_id={n.id: n.name for n in nodes},
        edge_label_by_id={e.id: e.label for e in edges},
        lane_name_by_id={l.id: l.name for l in lanes},
        skeleton_text=skeleton_text,
        claim_ref_by_id=claim_ref_by_id,
    )
