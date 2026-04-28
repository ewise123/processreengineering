"""Phase 2.5 endpoints: generate process maps from claims, read them back."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.enums import (
    ClaimLinkKind,
    ConflictStatus,
    NodeType,
    ProcessVersionStatus,
)
from app.models.identity import User
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
from app.models.claim import Claim, ClaimCitation, ClaimConflict
from app.models.input import Chunk, DocumentSection, Input
from app.schemas.process_map import (
    CitationDetail,
    ClaimSummary,
    ClaimWithCitations,
    LaneCreate,
    LaneUpdate,
    NodeCitationsRead,
    NodeCreate,
    NodeIssueDetail,
    NodeIssueRead,
    NodeIssuesDetailRead,
    NodeUpdate,
    ProcessEdgeRead,
    ProcessGraphRead,
    ProcessLaneRead,
    ProcessMapGenerateRequest,
    ProcessMapGenerateResult,
    ProcessModelRead,
    ProcessNodeRead,
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
) -> list[ProcessModelRead]:
    models = list(
        db.scalars(
            select(ProcessModel)
            .where(
                ProcessModel.project_id == project.id,
                ProcessModel.deleted_at.is_(None),
            )
            .order_by(ProcessModel.created_at.desc())
        ).all()
    )
    if not models:
        return []

    # One row per model: the highest version_number row, via DISTINCT ON.
    model_ids = [m.id for m in models]
    rows = db.execute(
        select(
            ProcessVersion.model_id,
            ProcessVersion.id,
            ProcessVersion.version_number,
        )
        .where(ProcessVersion.model_id.in_(model_ids))
        .order_by(
            ProcessVersion.model_id,
            ProcessVersion.version_number.desc(),
        )
        .distinct(ProcessVersion.model_id)
    ).all()
    latest_by_model: dict = {
        row[0]: (row[1], row[2]) for row in rows
    }

    return [
        ProcessModelRead.model_validate(m).model_copy(
            update={
                "latest_version_id": latest_by_model.get(m.id, (None, None))[0],
                "latest_version_number": latest_by_model.get(m.id, (None, None))[1],
            }
        )
        for m in models
    ]


def _check_node_in_project(
    node: ProcessNode, project_id: UUID, db: Session
) -> None:
    """Raise 404 unless the node ultimately belongs to the given project."""
    version = db.get(ProcessVersion, node.version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="Node not found")
    model = db.get(ProcessModel, version.model_id)
    if model is None or model.project_id != project_id:
        raise HTTPException(status_code=404, detail="Node not found")


def _check_lane_in_project(
    lane: ProcessLane, project_id: UUID, db: Session
) -> ProcessVersion:
    version = db.get(ProcessVersion, lane.version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="Lane not found")
    model = db.get(ProcessModel, version.model_id)
    if model is None or model.project_id != project_id:
        raise HTTPException(status_code=404, detail="Lane not found")
    return version


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/nodes",
    response_model=ProcessNodeRead,
    status_code=status.HTTP_201_CREATED,
)
def create_node(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: NodeCreate,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessNode:
    """Create a node from the shape palette. Lane must belong to this
    version; position is whatever the canvas calculated from the drop."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    lane = db.get(ProcessLane, payload.lane_id)
    if lane is None or lane.version_id != version.id:
        raise HTTPException(
            status_code=422,
            detail="lane_id must reference a lane in the same version",
        )

    node = ProcessNode(
        version_id=version.id,
        type=payload.type,
        name=payload.name,
        lane_id=payload.lane_id,
        position={"x": payload.x, "relative_y": payload.relative_y},
        properties={},
    )
    db.add(node)
    db.commit()
    db.refresh(node)
    return node


@router.patch("/nodes/{node_id}", response_model=ProcessNodeRead)
def update_node(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    payload: NodeUpdate,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessNode:
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)

    if payload.lane_id is not None:
        target_lane = db.get(ProcessLane, payload.lane_id)
        if target_lane is None or target_lane.version_id != node.version_id:
            raise HTTPException(
                status_code=422,
                detail="lane_id must reference a lane in the same version",
            )
        node.lane_id = payload.lane_id
    if payload.name is not None:
        node.name = payload.name
    if payload.x is not None or payload.relative_y is not None:
        new_position = dict(node.position or {})
        if payload.x is not None:
            new_position["x"] = payload.x
        if payload.relative_y is not None:
            new_position["relative_y"] = payload.relative_y
        node.position = new_position
        flag_modified(node, "position")
    db.commit()
    db.refresh(node)
    return node


@router.delete("/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    """Delete a node. FK cascades drop the connected edges and node-claim
    links automatically."""
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)
    db.delete(node)
    db.commit()


@router.patch("/lanes/{lane_id}", response_model=ProcessLaneRead)
def update_lane(
    project: Annotated[Project, Depends(get_project_or_404)],
    lane_id: UUID,
    payload: LaneUpdate,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessLane:
    lane = db.get(ProcessLane, lane_id)
    if lane is None:
        raise HTTPException(status_code=404, detail="Lane not found")
    _check_lane_in_project(lane, project.id, db)

    if payload.name is not None:
        lane.name = payload.name
    if payload.order_index is not None:
        lane.order_index = payload.order_index
    if payload.height_px is not None:
        lane.height_px = payload.height_px
    db.commit()
    db.refresh(lane)
    return lane


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/lanes",
    response_model=ProcessLaneRead,
    status_code=status.HTTP_201_CREATED,
)
def add_lane(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: LaneCreate,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessLane:
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model_id:
        raise HTTPException(status_code=404, detail="Version not found")
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Model not found")

    # Atomically shift later lanes' order_index up by 1 so the inserted
    # row is unique at its target index (no duplicate or gap).
    db.execute(
        update(ProcessLane)
        .where(
            ProcessLane.version_id == version_id,
            ProcessLane.order_index >= payload.order_index,
        )
        .values(order_index=ProcessLane.order_index + 1)
    )
    lane = ProcessLane(
        version_id=version_id,
        name=payload.name,
        order_index=payload.order_index,
        height_px=payload.height_px or 150,
    )
    db.add(lane)
    db.commit()
    db.refresh(lane)
    return lane


@router.get("/nodes/{node_id}/citations", response_model=NodeCitationsRead)
def get_node_citations(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> NodeCitationsRead:
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)

    # Step 1: claims directly linked to this node, with their link_kind
    link_rows = list(
        db.execute(
            select(NodeClaimLink.claim_id, NodeClaimLink.link_kind).where(
                NodeClaimLink.node_id == node_id
            )
        ).all()
    )
    if not link_rows:
        return NodeCitationsRead(node_id=node_id, claims=[])

    claim_ids = [row[0] for row in link_rows]
    link_kind_by_claim = {row[0]: row[1] for row in link_rows}

    claims = list(
        db.scalars(
            select(Claim).where(Claim.id.in_(claim_ids)).order_by(Claim.kind, Claim.created_at)
        ).all()
    )

    # Step 2: citations + their input/section context, in one join
    citation_rows = list(
        db.execute(
            select(
                ClaimCitation.id,
                ClaimCitation.claim_id,
                ClaimCitation.chunk_id,
                ClaimCitation.quote,
                ClaimCitation.confidence,
                Input.id,
                Input.name,
                Input.type,
                DocumentSection.kind,
                DocumentSection.ref,
            )
            .join(Chunk, Chunk.id == ClaimCitation.chunk_id)
            .join(DocumentSection, DocumentSection.id == Chunk.section_id)
            .join(Input, Input.id == DocumentSection.input_id)
            .where(ClaimCitation.claim_id.in_(claim_ids))
            .order_by(ClaimCitation.claim_id, ClaimCitation.created_at)
        ).all()
    )

    citations_by_claim: dict = {}
    for row in citation_rows:
        citations_by_claim.setdefault(row[1], []).append(
            CitationDetail(
                citation_id=row[0],
                chunk_id=row[2],
                quote=row[3],
                confidence=row[4],
                input_id=row[5],
                input_name=row[6],
                input_type=row[7],
                section_kind=row[8],
                section_ref=row[9] or {},
            )
        )

    return NodeCitationsRead(
        node_id=node_id,
        claims=[
            ClaimWithCitations(
                id=c.id,
                kind=c.kind,
                subject=c.subject,
                normalized=c.normalized or {},
                confidence=c.confidence,
                link_kind=link_kind_by_claim.get(c.id, "supports"),
                citations=citations_by_claim.get(c.id, []),
            )
            for c in claims
        ],
    )


@router.get("/nodes/{node_id}/issues", response_model=NodeIssuesDetailRead)
def get_node_issues(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> NodeIssuesDetailRead:
    """Open conflicts touching any claim linked to this node, with both
    sides of each conflict resolved to claim summaries so the panel can
    show 'this claim says X — but other claim says Y'."""
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)

    linked_claim_ids = list(
        db.scalars(
            select(NodeClaimLink.claim_id).where(NodeClaimLink.node_id == node_id)
        ).all()
    )
    if not linked_claim_ids:
        return NodeIssuesDetailRead(node_id=node_id, issues=[])

    conflicts = list(
        db.scalars(
            select(ClaimConflict)
            .where(
                ClaimConflict.resolution_status == ConflictStatus.DETECTED.value,
                or_(
                    ClaimConflict.claim_a_id.in_(linked_claim_ids),
                    ClaimConflict.claim_b_id.in_(linked_claim_ids),
                ),
            )
            .order_by(ClaimConflict.created_at.desc())
        ).all()
    )
    if not conflicts:
        return NodeIssuesDetailRead(node_id=node_id, issues=[])

    # Bulk-load every claim referenced on either side of any conflict so we
    # don't N+1 the DB.
    referenced_ids: set[UUID] = set()
    for c in conflicts:
        referenced_ids.add(c.claim_a_id)
        referenced_ids.add(c.claim_b_id)
    claim_by_id: dict[UUID, Claim] = {
        cl.id: cl
        for cl in db.scalars(
            select(Claim).where(Claim.id.in_(referenced_ids))
        ).all()
    }

    linked_set = set(linked_claim_ids)

    def _summary(cl: Claim | None) -> ClaimSummary | None:
        if cl is None:
            return None
        return ClaimSummary(
            id=cl.id,
            kind=cl.kind,
            subject=cl.subject,
            normalized=cl.normalized or {},
            confidence=cl.confidence,
        )

    issues: list[NodeIssueDetail] = []
    for c in conflicts:
        # Pick which side belongs to *this* node so the UI can render
        # "this claim" vs "the other claim" consistently.
        if c.claim_a_id in linked_set:
            this_id, other_id = c.claim_a_id, c.claim_b_id
        else:
            this_id, other_id = c.claim_b_id, c.claim_a_id
        this_claim = _summary(claim_by_id.get(this_id))
        other_claim = _summary(claim_by_id.get(other_id))
        if this_claim is None or other_claim is None:
            continue
        issues.append(
            NodeIssueDetail(
                conflict_id=c.id,
                kind=c.kind,
                resolution_status=c.resolution_status,
                detected_by=c.detected_by,
                resolution_notes=c.resolution_notes,
                this_claim=this_claim,
                other_claim=other_claim,
            )
        )

    return NodeIssuesDetailRead(node_id=node_id, issues=issues)


@router.delete("/lanes/{lane_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_lane(
    project: Annotated[Project, Depends(get_project_or_404)],
    lane_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    lane = db.get(ProcessLane, lane_id)
    if lane is None:
        raise HTTPException(status_code=404, detail="Lane not found")
    version = _check_lane_in_project(lane, project.id, db)

    others = list(
        db.scalars(
            select(ProcessLane)
            .where(
                ProcessLane.version_id == version.id,
                ProcessLane.id != lane_id,
            )
            .order_by(ProcessLane.order_index)
        ).all()
    )
    if not others:
        raise HTTPException(
            status_code=422, detail="Cannot delete the last remaining lane"
        )

    fallback = others[0]
    # Reassign nodes to a remaining lane so they don't end up orphaned.
    db.execute(
        update(ProcessNode)
        .where(ProcessNode.lane_id == lane_id)
        .values(lane_id=fallback.id)
    )
    db.delete(lane)
    db.flush()
    # Compact remaining lanes' order_index so the persisted ordering stays
    # consecutive (0..N-1) without gaps after the delete.
    remaining = list(
        db.scalars(
            select(ProcessLane)
            .where(ProcessLane.version_id == version.id)
            .order_by(ProcessLane.order_index, ProcessLane.id)
        ).all()
    )
    for i, l in enumerate(remaining):
        if l.order_index != i:
            l.order_index = i
    db.commit()


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


@router.get(
    "/process-maps/{model_id}/versions/{version_id}/issues",
    response_model=list[NodeIssueRead],
)
def list_process_map_issues(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> list[NodeIssueRead]:
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    rows = db.execute(
        select(
            NodeClaimLink.node_id,
            func.count(func.distinct(ClaimConflict.id)).label("cnt"),
        )
        .join(ProcessNode, NodeClaimLink.node_id == ProcessNode.id)
        .join(
            ClaimConflict,
            or_(
                ClaimConflict.claim_a_id == NodeClaimLink.claim_id,
                ClaimConflict.claim_b_id == NodeClaimLink.claim_id,
            ),
        )
        .where(
            ProcessNode.version_id == version.id,
            ClaimConflict.resolution_status == ConflictStatus.DETECTED.value,
        )
        .group_by(NodeClaimLink.node_id)
    ).all()

    issues: list[NodeIssueRead] = []
    for node_id, cnt in rows:
        # 2+ open conflicts touching this node = high; 1 = medium.
        severity = "high" if cnt >= 2 else "medium"
        issues.append(
            NodeIssueRead(node_id=node_id, severity=severity, conflict_count=cnt)
        )
    return issues
