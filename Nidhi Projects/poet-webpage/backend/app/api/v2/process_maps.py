"""Phase 2.5 endpoints: generate process maps from claims, read them back."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import (
    ClaimLinkKind,
    NodeType,
    ProcessVersionStatus,
)
from app.models.claim import Claim
from app.models.identity import User
from app.models.input import Chunk, DocumentSection
from app.models.process import (
    EdgeClaimLink,
    NodeClaimLink,
    ProcessEdge,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.project import Project
from app.schemas.process_map import (
    ProcessGraphRead,
    ProcessLaneRead,
    ProcessMapGenerateRequest,
    ProcessMapGenerateResult,
    ProcessModelRead,
    ProcessNodeRead,
    ProcessEdgeRead,
    ProcessVersionRead,
)
from app.services.legacy_bpmn import build_bpmn_xml, validate_xml
from app.services.process_generation import generate_structure_from_claims

router = APIRouter(prefix="/projects/{project_id}", tags=["process_maps"])


# Map BPMN task types from the AI-emitted structure → our NodeType enum
def _node_type_for_step(bpmn_type: str) -> str:
    if bpmn_type and "Gateway" not in bpmn_type:
        return NodeType.TASK.value
    return NodeType.TASK.value


def _node_type_for_gateway(gateway_kind: str) -> str:
    return {
        "exclusive": NodeType.GATEWAY_EXCLUSIVE.value,
        "parallel": NodeType.GATEWAY_PARALLEL.value,
        "inclusive": NodeType.GATEWAY_INCLUSIVE.value,
    }.get((gateway_kind or "exclusive").strip(), NodeType.GATEWAY_EXCLUSIVE.value)


def _normalize_level(level: str) -> str:
    """Accept '1','2','3','4' or 'L1','L2','L3','L4' — return canonical 'L1'..'L4'."""
    raw = level.strip().upper()
    if raw.startswith("L"):
        return raw
    return f"L{raw}"


def _level_for_prompt(level: str) -> str:
    """Strip the 'L' prefix for the prompt LEVEL_INSTRUCTIONS lookup."""
    return level.lstrip("Ll") or "2"


@router.post(
    "/generate-process-map",
    response_model=ProcessMapGenerateResult,
    status_code=status.HTTP_201_CREATED,
)
def generate_process_map(
    payload: ProcessMapGenerateRequest,
    project: Annotated[Project, Depends(get_project_or_404)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessMapGenerateResult:
    # 1. Load claims (optionally scoped to specific input ids via citations)
    claim_query = select(Claim).where(Claim.project_id == project.id)
    if payload.scope_input_ids:
        from app.models.claim import ClaimCitation

        claim_query = (
            claim_query.join(ClaimCitation, ClaimCitation.claim_id == Claim.id)
            .join(Chunk, Chunk.id == ClaimCitation.chunk_id)
            .join(DocumentSection, DocumentSection.id == Chunk.section_id)
            .where(DocumentSection.input_id.in_(payload.scope_input_ids))
            .distinct()
        )
    claim_query = claim_query.order_by(Claim.kind, Claim.created_at)
    claims = list(db.scalars(claim_query).all())
    if not claims:
        raise HTTPException(
            status_code=422,
            detail="No claims found for this project (scope). Run extract-claims first.",
        )

    # 2. Call Claude
    claim_payload = [{"kind": c.kind, "subject": c.subject} for c in claims]
    try:
        structure = generate_structure_from_claims(
            claim_payload,
            level=_level_for_prompt(payload.level),
            process_name=payload.name,
            focus=payload.focus,
            map_type=payload.map_type,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # 3. Render BPMN XML for storage / canvas
    structure_dict = {
        "process_name": structure.process_name,
        "steps": structure.steps,
        "gateways": structure.gateways,
    }
    bpmn_xml = build_bpmn_xml(structure_dict)
    valid, err = validate_xml(bpmn_xml)
    if not valid:
        raise HTTPException(status_code=500, detail=f"Generated BPMN XML failed validation: {err}")

    # 4. Find-or-create ProcessModel for (project, level, name)
    canonical_level = _normalize_level(payload.level)
    model = db.scalars(
        select(ProcessModel)
        .where(
            ProcessModel.project_id == project.id,
            ProcessModel.level == canonical_level,
            ProcessModel.name == structure.process_name,
            ProcessModel.deleted_at.is_(None),
        )
        .limit(1)
    ).first()
    if model is None:
        model = ProcessModel(
            project_id=project.id,
            name=structure.process_name,
            level=canonical_level,
        )
        db.add(model)
        db.flush()

    # 5. Compute next version_number for this model
    last_version_num = db.scalar(
        select(func.coalesce(func.max(ProcessVersion.version_number), 0)).where(
            ProcessVersion.model_id == model.id
        )
    ) or 0

    parent_version = db.scalars(
        select(ProcessVersion)
        .where(ProcessVersion.model_id == model.id, ProcessVersion.version_number == last_version_num)
        .limit(1)
    ).first()

    version = ProcessVersion(
        model_id=model.id,
        version_number=last_version_num + 1,
        parent_version_id=parent_version.id if parent_version else None,
        status=ProcessVersionStatus.DRAFT.value,
        bpmn_xml=bpmn_xml,
        notes=f"Generated from {len(claims)} claim(s).",
        created_by=user.id,
    )
    db.add(version)
    db.flush()

    # 6. Persist lanes (one per unique role in document order)
    role_order: list[str] = []
    seen: set[str] = set()
    for step in structure.steps:
        r = (step.get("role") or "Process Team").strip()
        if r not in seen:
            role_order.append(r)
            seen.add(r)
    if not role_order:
        role_order = ["Process Team"]

    lane_by_role: dict[str, ProcessLane] = {}
    for idx, role in enumerate(role_order):
        lane = ProcessLane(version_id=version.id, name=role, order_index=idx)
        db.add(lane)
        lane_by_role[role] = lane
    db.flush()

    # 7. Build the ordered element list (Start, steps with gateways inserted, End)
    gateway_by_after_step = {gw["after_step"]: gw for gw in structure.gateways}
    elements: list[dict] = []
    first_role = (structure.steps[0].get("role") or "Process Team").strip() if structure.steps else "Process Team"
    last_role = (structure.steps[-1].get("role") or "Process Team").strip() if structure.steps else "Process Team"

    elements.append(
        {"id": "Start_1", "kind": "start", "name": "Start", "role": first_role, "claim_refs": []}
    )
    for step in structure.steps:
        elements.append(
            {
                "id": step["id"],
                "kind": "step",
                "name": step.get("name", ""),
                "role": (step.get("role") or "Process Team").strip(),
                "bpmn_type": (step.get("type") or "userTask").strip(),
                "claim_refs": step.get("claim_refs") or [],
            }
        )
        if step["id"] in gateway_by_after_step:
            gw = gateway_by_after_step[step["id"]]
            elements.append(
                {
                    "id": gw["id"],
                    "kind": "gateway",
                    "name": gw.get("name", "Decision?"),
                    "role": (step.get("role") or "Process Team").strip(),
                    "gateway_kind": (gw.get("type") or "exclusive").strip(),
                    "claim_refs": gw.get("claim_refs") or [],
                    "yes_to": gw.get("yes_to"),
                    "no_to": gw.get("no_to"),
                }
            )
    elements.append(
        {"id": "End_1", "kind": "end", "name": "End", "role": last_role, "claim_refs": []}
    )

    # 8. Persist nodes
    node_by_external_id: dict[str, ProcessNode] = {}
    for col, el in enumerate(elements):
        if el["kind"] == "start":
            ntype = NodeType.EVENT_START.value
        elif el["kind"] == "end":
            ntype = NodeType.EVENT_END.value
        elif el["kind"] == "gateway":
            ntype = _node_type_for_gateway(el["gateway_kind"])
        else:
            ntype = NodeType.TASK.value
        properties = {"col": col, "external_id": el["id"]}
        if el["kind"] == "step":
            properties["bpmn_task_type"] = el.get("bpmn_type")
        if el["kind"] == "gateway":
            properties["bpmn_gateway_kind"] = el.get("gateway_kind")
        node = ProcessNode(
            version_id=version.id,
            lane_id=lane_by_role[el["role"]].id,
            type=ntype,
            name=el["name"],
            position={"col": col},
            properties=properties,
        )
        db.add(node)
        node_by_external_id[el["id"]] = node
    db.flush()

    # 9. Derive sequence edges (mirror legacy add_flow logic, logical only — no geometry)
    el_by_id = {el["id"]: el for el in elements}

    def _add_edge(src_id: str, tgt_id: str, label: str | None) -> ProcessEdge | None:
        if src_id not in node_by_external_id or tgt_id not in node_by_external_id:
            return None
        edge = ProcessEdge(
            version_id=version.id,
            source_node_id=node_by_external_id[src_id].id,
            target_node_id=node_by_external_id[tgt_id].id,
            label=label or None,
        )
        db.add(edge)
        return edge

    edges_by_source: dict[str, list[ProcessEdge]] = {}
    for i in range(len(elements) - 1):
        src = elements[i]
        nxt = elements[i + 1]
        if src["kind"] == "gateway":
            is_parallel = src["gateway_kind"] == "parallel"
            yes_edge = _add_edge(src["id"], nxt["id"], "" if is_parallel else "Yes")
            if yes_edge:
                edges_by_source.setdefault(src["id"], []).append(yes_edge)
            no_tgt = src.get("no_to") or "End_1"
            if no_tgt not in el_by_id or no_tgt == nxt["id"]:
                no_tgt = "End_1"
            if no_tgt != nxt["id"]:
                no_edge = _add_edge(src["id"], no_tgt, "" if is_parallel else "No")
                if no_edge:
                    edges_by_source.setdefault(src["id"], []).append(no_edge)
        else:
            edge = _add_edge(src["id"], nxt["id"], None)
            if edge:
                edges_by_source.setdefault(src["id"], []).append(edge)
    db.flush()

    # 10. Resolve claim_refs → node_claim_links + edge_claim_links
    node_link_count = 0
    for el in elements:
        node = node_by_external_id.get(el["id"])
        if node is None:
            continue
        for ref in el.get("claim_refs", []):
            if not isinstance(ref, int) or ref < 0 or ref >= len(claims):
                continue
            db.add(
                NodeClaimLink(
                    node_id=node.id,
                    claim_id=claims[ref].id,
                    link_kind=ClaimLinkKind.SUPPORTS.value,
                )
            )
            node_link_count += 1
        # Gateway claim_refs also propagate to its outgoing edges (decision logic)
        if el["kind"] == "gateway":
            for edge in edges_by_source.get(el["id"], []):
                for ref in el.get("claim_refs", []):
                    if not isinstance(ref, int) or ref < 0 or ref >= len(claims):
                        continue
                    db.add(
                        EdgeClaimLink(
                            edge_id=edge.id,
                            claim_id=claims[ref].id,
                            link_kind=ClaimLinkKind.INFERRED.value,
                        )
                    )

    db.commit()

    return ProcessMapGenerateResult(
        model_id=model.id,
        version_id=version.id,
        process_name=structure.process_name,
        level=canonical_level,
        lane_count=len(role_order),
        node_count=len(elements),
        edge_count=sum(len(v) for v in edges_by_source.values()),
        node_link_count=node_link_count,
        bpmn_xml_size=len(bpmn_xml),
    )


@router.get("/process-maps", response_model=list[ProcessModelRead])
def list_process_maps(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ProcessModel]:
    items = db.scalars(
        select(ProcessModel)
        .where(ProcessModel.project_id == project.id, ProcessModel.deleted_at.is_(None))
        .order_by(ProcessModel.created_at.desc())
    ).all()
    return list(items)


@router.get(
    "/process-maps/{model_id}/versions/{version_id}", response_model=ProcessGraphRead
)
def get_process_graph(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessGraphRead:
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    lanes = list(
        db.scalars(
            select(ProcessLane)
            .where(ProcessLane.version_id == version.id)
            .order_by(ProcessLane.order_index)
        ).all()
    )
    nodes = list(
        db.scalars(
            select(ProcessNode).where(ProcessNode.version_id == version.id)
        ).all()
    )
    edges = list(
        db.scalars(
            select(ProcessEdge).where(ProcessEdge.version_id == version.id)
        ).all()
    )

    return ProcessGraphRead(
        version=ProcessVersionRead.model_validate(version),
        lanes=[ProcessLaneRead.model_validate(l) for l in lanes],
        nodes=[ProcessNodeRead.model_validate(n) for n in nodes],
        edges=[ProcessEdgeRead.model_validate(e) for e in edges],
    )
