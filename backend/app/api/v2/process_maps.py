"""Phase 2.5 endpoints: generate process maps from claims, read them back."""
import logging
import re
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, status
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.api.v2.deps import get_current_user, get_project_or_404
from app.api.v2.reviews import _recompute_version_status
from app.constants import LINEAGE_KEY
from app.db.session import get_db
from app.enums import (
    AgentRunStopReason,
    ChangeActorKind,
    ChangeKind,
    ChangeSource,
    ChangeTargetType,
    ClaimLinkKind,
    ConflictStatus,
    NodeType,
    ProcessVersionStatus,
    ReviewTargetType,
)
from app.services.change_log import NODE_SEMANTIC_FIELDS, model_id_for_version, pick_kind, record_change
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
from app.models.process_inventory import ProcessSuggestion
from app.models.project import Project
from app.models.workflow import Review
from app.models.claim import Claim, ClaimCitation, ClaimConflict
from app.models.input import Chunk, DocumentSection, Input
from app.schemas.process_map import (
    AiProposedStepResult,
    BlankMapRequest,
    BlankMapResult,
    ChatRequest,
    ChatResponse,
    CitationDetail,
    ClaimSummary,
    ClaimWithCitations,
    ConsistencyFinding,
    DeleteRequest,
    EdgeCreate,
    EdgeUpdate,
    LaneCreate,
    LaneUpdate,
    NodeClaimLinkRequest,
    NodeClaimLinkResult,
    NodeCitationsRead,
    NodeCreate,
    NodeIssueDetail,
    NodeIssueRead,
    NodeIssuesDetailRead,
    NodeUpdate,
    ProcessEdgeRead,
    ProcessGraphRead,
    ProcessLaneRead,
    ProcessMapAttachRequest,
    ProcessMapGenerateRequest,
    ProcessMapGenerateResult,
    ProcessModelRead,
    ProcessNodeRead,
    ProcessVersionRead,
)
from app.schemas.version_ai_edit import (
    AiEditAction,
    AiEditRequest,
    AiEditResponse,
    AiProposedStepRequest,
    AncestryCrumb,
    DecomposeProposal,
    DecomposeRequest,
    DecomposeResult,
    DescribeProposal,
    RelabelProposal,
    SubStep,
    SuggestNextProposal,
    SuggestedStep,
    ValidateGap,
    ValidateProposal,
)
from app.schemas.version_reconcile import (
    ReconcileBatchRead,
    ReconcileOp,
    ReconcileRequest,
    ReconcileSuggestionRead,
)
from app.services.legacy_bpmn import build_bpmn_xml, validate_xml
from app.services.map_ai_edit import (
    propose_relabel,
    propose_description,
    propose_decompose,
    report_gaps,
    propose_next_steps,
)
from app.services.map_chat import ChatTurn as MapChatTurn, chat as run_map_chat
from app.services.map_chat_agent import run_chat_agent, assess_grounded
from app.services.map_context import assemble_map_context
from app.services.map_reconcile import compute_claim_delta, propose_reconcile
from app.services import map_reconcile as _map_reconcile_mod
from app.services.process_generation import (
    generate_structure_from_best_practices,
    generate_structure_from_claims,
)
from app.schemas.version_chat_suggest import (
    ActivityStep,
    AgentOption,
    AgentQuestion,
    ChatSuggestRequest,
    ChatSuggestResponse,
    ChatTurn as SuggestChatTurn,
    GroupSummary,
    MentionSource,
    RefKind,
)
from app.services.map_consistency import scan_map
from app.services.suggestion_ops import (
    _resolve_mention_refs,
    _resolve_refs,
)
from app.models.agent_run import AgentRun
from app.services.agent_tools import AgentToolCtx

router = APIRouter(prefix="/projects/{project_id}", tags=["process_maps"])

logger = logging.getLogger(__name__)


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


def _create_model_and_version(
    db: Session,
    *,
    project: Project,
    name: str,
    level: str,
    created_by: UUID,
    bpmn_xml: str | None = None,
    notes: str | None = None,
    default_lane_name: str | None = "Process Team",
) -> tuple[ProcessModel, ProcessVersion, ProcessLane | None]:
    """Find-or-create the (project, level, name) ProcessModel, create the next
    ProcessVersion (lineage stamped from the prior top version), and one default
    lane. Shared by AI generation and blank-map creation.

    The caller is responsible for db.flush()/db.commit() and for adding nodes."""
    canonical_level = _normalize_level(level)
    model = db.scalars(
        select(ProcessModel)
        .where(
            ProcessModel.project_id == project.id,
            ProcessModel.level == canonical_level,
            ProcessModel.name == name,
            ProcessModel.deleted_at.is_(None),
        )
        .limit(1)
    ).first()
    if model is None:
        model = ProcessModel(
            project_id=project.id, name=name, level=canonical_level
        )
        db.add(model)
        db.flush()

    last_version_num = (
        db.scalar(
            select(func.coalesce(func.max(ProcessVersion.version_number), 0)).where(
                ProcessVersion.model_id == model.id
            )
        )
        or 0
    )
    parent_version = db.scalars(
        select(ProcessVersion)
        .where(
            ProcessVersion.model_id == model.id,
            ProcessVersion.version_number == last_version_num,
        )
        .limit(1)
    ).first()

    version = ProcessVersion(
        model_id=model.id,
        version_number=last_version_num + 1,
        parent_version_id=parent_version.id if parent_version else None,
        status=ProcessVersionStatus.DRAFT.value,
        bpmn_xml=bpmn_xml,
        notes=notes,
        created_by=created_by,
    )
    db.add(version)
    db.flush()

    lane: ProcessLane | None = None
    if default_lane_name is not None:
        lane = ProcessLane(version_id=version.id, name=default_lane_name, order_index=0)
        db.add(lane)
        db.flush()
    return model, version, lane


def _persist_structure_graph(
    db: Session,
    *,
    version: ProcessVersion,
    structure,
    claims: list[Claim],
    create_claim_links: bool,
    origin_reason: str,
) -> tuple[list[str], list[dict], dict[str, list[ProcessEdge]], int]:
    """Persist lanes/nodes/edges from an AI structure, then write the origin
    change events. Shared by claim-based generation and best-practice seeding.

    When `create_claim_links` is True, each element's claim_refs are resolved
    against `claims` into NodeClaimLinks/EdgeClaimLinks and the origin events
    cite them. When False (best-practice seeding, no claims), no links are
    created and every origin event carries empty cited_claim_ids. `origin_reason`
    is stamped as the reason on every node/edge create event.

    Returns (role_order, elements, edges_by_source, node_link_count)."""
    # Lanes: one per unique role in document order.
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

    # Build the ordered element list (Start, steps with gateways inserted, End).
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

    # Persist nodes.
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
    for node in node_by_external_id.values():
        node.properties = {**(node.properties or {}), LINEAGE_KEY: str(node.id)}
    db.flush()

    # Derive sequence edges (mirror legacy add_flow logic, logical only).
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

    # Resolve claim_refs → node_claim_links + edge_claim_links.
    # Build claim-id lists per element id so origin events can cite them.
    # Resolved here (after nodes/edges have ids) so cited_claim_ids is populated
    # on the same create event rather than requiring a subsequent link_claim event.
    # For best-practice seeding there are no claims, so this whole pass is skipped
    # and every event carries empty cited_claim_ids.
    node_link_count = 0
    cited_ids_by_el: dict[str, list] = {}
    if create_claim_links:
        for el in elements:
            node = node_by_external_id.get(el["id"])
            if node is None:
                continue
            valid_refs = [
                ref for ref in el.get("claim_refs", [])
                if isinstance(ref, int) and 0 <= ref < len(claims)
            ]
            el_claim_ids = [claims[ref].id for ref in valid_refs]
            cited_ids_by_el[el["id"]] = el_claim_ids
            for cid in el_claim_ids:
                db.add(
                    NodeClaimLink(
                        node_id=node.id,
                        claim_id=cid,
                        link_kind=ClaimLinkKind.SUPPORTS.value,
                    )
                )
                node_link_count += 1
            # Gateway claim_refs also propagate to its outgoing edges (decision logic)
            if el["kind"] == "gateway":
                for edge in edges_by_source.get(el["id"], []):
                    for cid in el_claim_ids:
                        db.add(
                            EdgeClaimLink(
                                edge_id=edge.id,
                                claim_id=cid,
                                link_kind=ClaimLinkKind.INFERRED.value,
                            )
                        )

    # Write origin change events (generation trail). Edges carry no direct
    # claim_refs in the AI structure (only gateways propagate to
    # edge_claim_links), so edge events are emitted without cited_claim_ids.
    for el in elements:
        node = node_by_external_id.get(el["id"])
        if node is None:
            continue
        record_change(
            db,
            target_type=ChangeTargetType.NODE.value,
            target_id=node.id,
            model_id=version.model_id,
            version_id=version.id,
            kind=ChangeKind.CREATE.value,
            reason=origin_reason,
            actor_kind=ChangeActorKind.AI.value,
            source=ChangeSource.GENERATION.value,
            after={"name": node.name, "type": node.type},
            cited_claim_ids=cited_ids_by_el.get(el["id"]) or None,
        )

    all_edges = [edge for edge_list in edges_by_source.values() for edge in edge_list]
    for edge in all_edges:
        record_change(
            db,
            target_type=ChangeTargetType.EDGE.value,
            target_id=edge.id,
            model_id=version.model_id,
            version_id=version.id,
            kind=ChangeKind.CREATE.value,
            reason=origin_reason,
            actor_kind=ChangeActorKind.AI.value,
            source=ChangeSource.GENERATION.value,
            after={
                "source_node_id": str(edge.source_node_id),
                "target_node_id": str(edge.target_node_id),
            },
        )

    return role_order, elements, edges_by_source, node_link_count


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
    # 1. Load claims (optionally scoped to a detection segment or input ids)
    claim_query = select(Claim).where(Claim.project_id == project.id)
    if payload.process_id is not None:
        from app.models.process_inventory import Process, ProcessClaimLink

        process = db.get(Process, payload.process_id)
        if (
            process is None
            or process.project_id != project.id
            or process.deleted_at is not None
        ):
            raise HTTPException(status_code=404, detail="Process not found")
        claim_query = claim_query.join(
            ProcessClaimLink, ProcessClaimLink.claim_id == Claim.id
        ).where(ProcessClaimLink.process_id == payload.process_id)
    elif payload.scope_input_ids:
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

    # 4-5. Find-or-create ProcessModel + next ProcessVersion (shared helper).
    canonical_level = _normalize_level(payload.level)
    model, version, _ = _create_model_and_version(
        db,
        project=project,
        name=structure.process_name,
        level=canonical_level,
        created_by=user.id,
        bpmn_xml=bpmn_xml,
        notes=f"Generated from {len(claims)} claim(s).",
        default_lane_name=None,  # AI path builds one lane per role
    )
    if payload.process_id is not None:
        model.process_id = payload.process_id

    # 6-11. Persist lanes/nodes/edges + claim links + origin events (shared).
    role_order, elements, edges_by_source, node_link_count = _persist_structure_graph(
        db,
        version=version,
        structure=structure,
        claims=claims,
        create_claim_links=True,
        origin_reason="Generated from source claims",
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


@router.post(
    "/generate-best-practices",
    response_model=ProcessMapGenerateResult,
    status_code=status.HTTP_201_CREATED,
)
def generate_best_practices_map(
    payload: ProcessMapGenerateRequest,
    project: Annotated[Project, Depends(get_project_or_404)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessMapGenerateResult:
    """Seed a starter map from the LLM's GENERIC best-practice knowledge for a
    named process — no client documents or claims required. Each node/edge gets
    an origin change_event with source=generation, actor_kind=ai, EMPTY
    cited_claim_ids, and reason="Best-practice assumption (no source document)".
    No NodeClaimLinks are created (there are no claims). The existing claim-based
    generate-process-map path is unaffected."""
    # 1. Call Claude with the best-practice framing (name/level/focus only —
    #    scope_input_ids/process_id are ignored here).
    try:
        structure = generate_structure_from_best_practices(
            level=_level_for_prompt(payload.level),
            process_name=payload.name,
            focus=payload.focus,
            map_type=payload.map_type,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    # 2. Render BPMN XML for storage / canvas.
    structure_dict = {
        "process_name": structure.process_name,
        "steps": structure.steps,
        "gateways": structure.gateways,
    }
    bpmn_xml = build_bpmn_xml(structure_dict)
    valid, err = validate_xml(bpmn_xml)
    if not valid:
        raise HTTPException(status_code=500, detail=f"Generated BPMN XML failed validation: {err}")

    # 3. Find-or-create ProcessModel + next ProcessVersion (shared helper).
    canonical_level = _normalize_level(payload.level)
    model, version, _ = _create_model_and_version(
        db,
        project=project,
        name=structure.process_name,
        level=canonical_level,
        created_by=user.id,
        bpmn_xml=bpmn_xml,
        notes="Seeded from best-practice knowledge (no source document).",
        default_lane_name=None,  # AI path builds one lane per role
    )

    # 4. Persist lanes/nodes/edges + origin events. No claims, no claim links;
    #    every origin event carries the best-practice reason + empty cited ids.
    role_order, elements, edges_by_source, node_link_count = _persist_structure_graph(
        db,
        version=version,
        structure=structure,
        claims=[],
        create_claim_links=False,
        origin_reason="Best-practice assumption (no source document)",
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


@router.post(
    "/process-maps",
    response_model=BlankMapResult,
    status_code=status.HTTP_201_CREATED,
)
def create_blank_map(
    payload: BlankMapRequest,
    project: Annotated[Project, Depends(get_project_or_404)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> BlankMapResult:
    """Create an empty, fully editable map: model + version + one default lane +
    Start and End nodes. No AI, no claims required."""
    model, version, lane = _create_model_and_version(
        db,
        project=project,
        name=payload.name,
        level=payload.level,
        created_by=user.id,
        notes="Created as a blank map.",
    )
    start = ProcessNode(
        version_id=version.id,
        lane_id=lane.id,
        type=NodeType.EVENT_START.value,
        name="Start",
        position={"col": 0},
        properties={"col": 0, "external_id": "Start_1"},
    )
    end = ProcessNode(
        version_id=version.id,
        lane_id=lane.id,
        type=NodeType.EVENT_END.value,
        name="End",
        position={"col": 1},
        properties={"col": 1, "external_id": "End_1"},
    )
    db.add(start)
    db.add(end)
    db.flush()
    for node in (start, end):
        node.properties = {**(node.properties or {}), LINEAGE_KEY: str(node.id)}
    db.flush()
    db.commit()
    return BlankMapResult(
        model_id=model.id,
        version_id=version.id,
        name=model.name,
        level=model.level,
        lane_id=lane.id,
        start_node_id=start.id,
        end_node_id=end.id,
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

    from app.models.process_inventory import Process, ProcessClaimLink

    model_ids = [m.id for m in models]

    # Latest version per model (highest version_number) via DISTINCT ON.
    latest_rows = db.execute(
        select(ProcessVersion.model_id, ProcessVersion.id, ProcessVersion.version_number)
        .where(ProcessVersion.model_id.in_(model_ids))
        .order_by(ProcessVersion.model_id, ProcessVersion.version_number.desc())
        .distinct(ProcessVersion.model_id)
    ).all()
    latest_by_model: dict = {row[0]: (row[1], row[2]) for row in latest_rows}

    # Process name per model (process_id may be NULL for unlinked maps).
    proc_ids = [m.process_id for m in models if m.process_id is not None]
    proc_name_by_id: dict = {}
    if proc_ids:
        proc_name_by_id = {
            r[0]: r[1]
            for r in db.execute(
                select(Process.id, Process.name).where(Process.id.in_(proc_ids))
            ).all()
        }

    # Unreconciled claim count per model: claims linked to the model's process
    # but NOT cited by any node in the model's LATEST version. Computed per
    # model because the "latest version" differs per model.
    def _unreconciled(model: ProcessModel) -> int:
        if model.process_id is None:
            return 0
        latest = latest_by_model.get(model.id)
        if latest is None:
            # Process has links but no version yet — all linked claims are unreconciled.
            return db.scalar(
                select(func.count(ProcessClaimLink.id)).where(
                    ProcessClaimLink.process_id == model.process_id
                )
            ) or 0
        version_id = latest[0]
        cited_subq = (
            select(NodeClaimLink.claim_id)
            .join(ProcessNode, ProcessNode.id == NodeClaimLink.node_id)
            .where(ProcessNode.version_id == version_id)
        )
        return db.scalar(
            select(func.count(ProcessClaimLink.id))
            .where(
                ProcessClaimLink.process_id == model.process_id,
                ProcessClaimLink.claim_id.notin_(cited_subq),
            )
        ) or 0

    return [
        ProcessModelRead.model_validate(m).model_copy(
            update={
                "latest_version_id": latest_by_model.get(m.id, (None, None))[0],
                "latest_version_number": latest_by_model.get(m.id, (None, None))[1],
                "process_id": m.process_id,
                "process_name": proc_name_by_id.get(m.process_id),
                "unreconciled_claim_count": int(_unreconciled(m)),
            }
        )
        for m in models
    ]


@router.patch("/process-maps/{model_id}", response_model=ProcessModelRead)
def attach_process_to_map(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    payload: ProcessMapAttachRequest,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessModelRead:
    """Attach (or detach, with process_id=null) a process to an existing map.
    Used to re-home migrated 'unlinked maps' onto a process."""
    from app.models.process_inventory import Process

    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id or model.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Process map not found")
    if payload.process_id is not None:
        proc = db.get(Process, payload.process_id)
        if proc is None or proc.project_id != project.id or proc.deleted_at is not None:
            raise HTTPException(status_code=404, detail="Process not found")
    model.process_id = payload.process_id
    db.commit()
    db.refresh(model)
    proc_name = None
    if model.process_id is not None:
        proc = db.get(Process, model.process_id)
        proc_name = proc.name if proc else None
    return ProcessModelRead.model_validate(model).model_copy(
        update={"process_id": model.process_id, "process_name": proc_name}
    )


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
    db.flush()
    node.properties = {**node.properties, LINEAGE_KEY: str(node.id)}
    db.flush()
    record_change(
        db,
        target_type=ChangeTargetType.NODE.value,
        target_id=node.id,
        model_id=version.model_id,
        version_id=version.id,
        kind=ChangeKind.CREATE.value,
        reason=(payload.reason.strip() if payload.reason and payload.reason.strip() else "Added from the shape palette"),
        after={"name": node.name, "type": node.type,
               "lane_id": str(node.lane_id) if node.lane_id else None},
        source=ChangeSource.CHAT.value if payload.ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if payload.ai_applied else ChangeActorKind.USER.value,
    )
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

    def _semantic_snapshot() -> dict:
        return {
            "name": node.name,
            "type": node.type,
            "lane_id": str(node.lane_id) if node.lane_id else None,
            "description": (node.properties or {}).get("description"),
        }

    old = _semantic_snapshot()

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
    if payload.type is not None:
        node.type = payload.type
    if payload.description is not None:
        new_props = dict(node.properties or {})
        new_props["description"] = payload.description
        node.properties = new_props
        flag_modified(node, "properties")
    if payload.x is not None or payload.relative_y is not None:
        new_position = dict(node.position or {})
        if payload.x is not None:
            new_position["x"] = payload.x
        if payload.relative_y is not None:
            new_position["relative_y"] = payload.relative_y
        node.position = new_position
        flag_modified(node, "position")

    new = _semantic_snapshot()
    changed = {f: (old[f], new[f]) for f in NODE_SEMANTIC_FIELDS if old[f] != new[f]}
    if changed:
        if not (payload.reason and payload.reason.strip()):
            db.rollback()
            raise HTTPException(
                status_code=422,
                detail="A reason is required when changing a step's name, description, type, or lane.",
            )
        kind = pick_kind({NODE_SEMANTIC_FIELDS[f] for f in changed})
        record_change(
            db,
            target_type=ChangeTargetType.NODE.value,
            target_id=node.id,
            model_id=model_id_for_version(db, node.version_id),
            version_id=node.version_id,
            kind=kind.value,
            reason=payload.reason.strip(),
            before={f: changed[f][0] for f in changed},
            after={f: changed[f][1] for f in changed},
            source=ChangeSource.CHAT.value if payload.ai_applied else ChangeSource.MANUAL.value,
            actor_kind=ChangeActorKind.AI.value if payload.ai_applied else ChangeActorKind.USER.value,
        )
    db.commit()
    db.refresh(node)
    return node


def _check_edge_in_project(
    edge: ProcessEdge, project_id: UUID, db: Session
) -> None:
    version = db.get(ProcessVersion, edge.version_id)
    if version is None:
        raise HTTPException(status_code=404, detail="Edge not found")
    model = db.get(ProcessModel, version.model_id)
    if model is None or model.project_id != project_id:
        raise HTTPException(status_code=404, detail="Edge not found")


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/edges",
    response_model=ProcessEdgeRead,
    status_code=status.HTTP_201_CREATED,
)
def create_edge(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: EdgeCreate,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessEdge:
    """Create an edge between two existing nodes in the same version."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    if payload.source_node_id == payload.target_node_id:
        raise HTTPException(
            status_code=422, detail="source_node_id and target_node_id must differ"
        )

    source = db.get(ProcessNode, payload.source_node_id)
    target = db.get(ProcessNode, payload.target_node_id)
    if (
        source is None
        or target is None
        or source.version_id != version.id
        or target.version_id != version.id
    ):
        raise HTTPException(
            status_code=422,
            detail="source and target must reference nodes in the same version",
        )

    # Server-side dedupe so retries / parallel requests can't persist
    # duplicate edges for the same (version, source, target) tuple.
    existing = db.scalars(
        select(ProcessEdge)
        .where(
            ProcessEdge.version_id == version.id,
            ProcessEdge.source_node_id == payload.source_node_id,
            ProcessEdge.target_node_id == payload.target_node_id,
        )
        .limit(1)
    ).first()
    if existing is not None:
        raise HTTPException(
            status_code=409, detail="Edge already exists between these nodes"
        )

    edge = ProcessEdge(
        version_id=version.id,
        source_node_id=payload.source_node_id,
        target_node_id=payload.target_node_id,
        label=payload.label,
    )
    db.add(edge)
    db.flush()
    record_change(
        db,
        target_type=ChangeTargetType.EDGE.value,
        target_id=edge.id,
        model_id=version.model_id,
        version_id=version.id,
        kind=ChangeKind.CONNECT.value,
        reason=(payload.reason.strip() if payload.reason and payload.reason.strip() else "Connected two nodes"),
        after={"source_node_id": str(edge.source_node_id),
               "target_node_id": str(edge.target_node_id)},
        source=ChangeSource.CHAT.value if payload.ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if payload.ai_applied else ChangeActorKind.USER.value,
    )
    db.commit()
    db.refresh(edge)
    return edge


@router.patch("/edges/{edge_id}", response_model=ProcessEdgeRead)
def update_edge(
    project: Annotated[Project, Depends(get_project_or_404)],
    edge_id: UUID,
    payload: EdgeUpdate,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessEdge:
    edge = db.get(ProcessEdge, edge_id)
    if edge is None:
        raise HTTPException(status_code=404, detail="Edge not found")
    _check_edge_in_project(edge, project.id, db)

    old_label = edge.label
    if "label" in payload.model_fields_set:
        edge.label = payload.label or None
    old_condition = edge.condition_text
    if "condition_text" in payload.model_fields_set:
        edge.condition_text = payload.condition_text or None
    if "bend_x" in payload.model_fields_set:
        edge.bend_x = payload.bend_x
    if "bend_y" in payload.model_fields_set:
        edge.bend_y = payload.bend_y

    label_changed = "label" in payload.model_fields_set and (payload.label or None) != old_label
    if label_changed:
        if not (payload.reason and payload.reason.strip()):
            db.rollback()
            raise HTTPException(status_code=422, detail="A reason is required to change an edge label.")
        record_change(
            db,
            target_type=ChangeTargetType.EDGE.value,
            target_id=edge.id,
            model_id=model_id_for_version(db, edge.version_id),
            version_id=edge.version_id,
            kind=ChangeKind.RELABEL.value,
            reason=payload.reason.strip(),
            before={"label": old_label},
            after={"label": edge.label},
            source=ChangeSource.CHAT.value if payload.ai_applied else ChangeSource.MANUAL.value,
            actor_kind=ChangeActorKind.AI.value if payload.ai_applied else ChangeActorKind.USER.value,
        )

    condition_changed = (
        "condition_text" in payload.model_fields_set
        and (payload.condition_text or None) != old_condition
    )
    if condition_changed:
        if not (payload.reason and payload.reason.strip()):
            db.rollback()
            raise HTTPException(status_code=422, detail="A reason is required to change an edge condition.")
        record_change(
            db,
            target_type=ChangeTargetType.EDGE.value,
            target_id=edge.id,
            model_id=model_id_for_version(db, edge.version_id),
            version_id=edge.version_id,
            kind=ChangeKind.SET_CONDITION.value,
            reason=payload.reason.strip(),
            before={"condition_text": old_condition},
            after={"condition_text": edge.condition_text},
            source=ChangeSource.CHAT.value if payload.ai_applied else ChangeSource.MANUAL.value,
            actor_kind=ChangeActorKind.AI.value if payload.ai_applied else ChangeActorKind.USER.value,
        )
    db.commit()
    db.refresh(edge)
    return edge


def _require_delete_reason(
    payload: DeleteRequest | None, message: str
) -> tuple[str, bool]:
    """Return the trimmed delete reason and the payload's `ai_applied` flag,
    raising 422 with `message` if the reason is missing or blank.

    Call this before any session mutation — it does not roll back.
    """
    reason = (payload.reason or "").strip() if payload else ""
    if not reason:
        raise HTTPException(status_code=422, detail=message)
    return reason, payload.ai_applied


@router.delete("/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_edge(
    project: Annotated[Project, Depends(get_project_or_404)],
    edge_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    payload: Annotated[DeleteRequest | None, Body()] = None,
) -> None:
    edge = db.get(ProcessEdge, edge_id)
    if edge is None:
        raise HTTPException(status_code=404, detail="Edge not found")
    _check_edge_in_project(edge, project.id, db)
    reason, ai_applied = _require_delete_reason(
        payload, "A reason is required to delete a connection."
    )
    record_change(
        db,
        target_type=ChangeTargetType.EDGE.value,
        target_id=edge.id,
        model_id=model_id_for_version(db, edge.version_id),
        version_id=edge.version_id,
        kind=ChangeKind.DELETE.value,
        reason=reason,
        before={
            "source_node_id": str(edge.source_node_id),
            "target_node_id": str(edge.target_node_id),
            "label": edge.label,
        },
        source=ChangeSource.CHAT.value if ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if ai_applied else ChangeActorKind.USER.value,
    )
    db.delete(edge)
    db.commit()


@router.delete("/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_node(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    payload: Annotated[DeleteRequest | None, Body()] = None,
) -> None:
    """Delete a node. FK cascades drop the connected edges and node-claim
    links automatically."""
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)
    reason, ai_applied = _require_delete_reason(
        payload, "A reason is required to delete a step."
    )
    version_id = node.version_id
    record_change(
        db,
        target_type=ChangeTargetType.NODE.value,
        target_id=node.id,
        model_id=model_id_for_version(db, node.version_id),
        version_id=node.version_id,
        kind=ChangeKind.DELETE.value,
        reason=reason,
        before={"name": node.name, "type": node.type},
        source=ChangeSource.CHAT.value if ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if ai_applied else ChangeActorKind.USER.value,
    )
    db.execute(
        delete(Review).where(
            Review.target_type == ReviewTargetType.PROCESS_NODE.value,
            Review.target_id == node_id,
        )
    )
    db.delete(node)
    db.flush()
    # Removing a node changes the approved/total ratio, so re-evaluate whether
    # the version's review lifecycle should advance (e.g. deleting the last
    # pending node of a requested version completes the sign-off).
    version = db.get(ProcessVersion, version_id)
    if version is not None:
        _recompute_version_status(db, version)
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

    old_name = lane.name

    if payload.name is not None:
        lane.name = payload.name
    if payload.order_index is not None:
        lane.order_index = payload.order_index
    if payload.height_px is not None:
        lane.height_px = payload.height_px
    if payload.color is not None:
        lane.color = payload.color
    if payload.collapsed is not None:
        lane.collapsed = payload.collapsed

    name_changed = payload.name is not None and lane.name != old_name
    if name_changed:
        if not (payload.reason and payload.reason.strip()):
            db.rollback()
            raise HTTPException(
                status_code=422,
                detail="A reason is required when renaming a lane.",
            )
        record_change(
            db,
            target_type=ChangeTargetType.LANE.value,
            target_id=lane.id,
            model_id=model_id_for_version(db, lane.version_id),
            version_id=lane.version_id,
            kind=ChangeKind.RELABEL.value,
            reason=payload.reason.strip(),
            before={"name": old_name},
            after={"name": lane.name},
            source=ChangeSource.CHAT.value if payload.ai_applied else ChangeSource.MANUAL.value,
            actor_kind=ChangeActorKind.AI.value if payload.ai_applied else ChangeActorKind.USER.value,
        )
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
        color=payload.color,
    )
    db.add(lane)
    db.flush()
    record_change(
        db,
        target_type=ChangeTargetType.LANE.value,
        target_id=lane.id,
        model_id=version.model_id,
        version_id=version.id,
        kind=ChangeKind.CREATE.value,
        reason=(payload.reason.strip() if payload.reason and payload.reason.strip() else "Added a new swim lane"),
        after={"name": lane.name},
        source=ChangeSource.CHAT.value if payload.ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if payload.ai_applied else ChangeActorKind.USER.value,
    )
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


@router.post(
    "/nodes/{node_id}/claims",
    response_model=NodeClaimLinkResult,
    status_code=status.HTTP_201_CREATED,
)
def attach_node_claims(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    payload: NodeClaimLinkRequest,
    db: Annotated[Session, Depends(get_db)],
) -> NodeClaimLinkResult:
    """Attach a batch of claims to a node as evidence. Idempotent on the
    (node_id, claim_id) unique constraint — re-attaching an existing link is a
    no-op counted in already_linked_count."""
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)

    # Every claim id must belong to this project.
    requested_ids = list(dict.fromkeys(payload.claim_ids))  # de-dup, keep order
    found = {
        c.id
        for c in db.scalars(
            select(Claim).where(
                Claim.id.in_(requested_ids), Claim.project_id == project.id
            )
        ).all()
    }
    missing = [cid for cid in requested_ids if cid not in found]
    if missing:
        raise HTTPException(
            status_code=422,
            detail="One or more claim_ids do not belong to this project",
        )

    existing = set(
        db.scalars(
            select(NodeClaimLink.claim_id).where(
                NodeClaimLink.node_id == node_id,
                NodeClaimLink.claim_id.in_(requested_ids),
            )
        ).all()
    )
    added = 0
    newly_added_ids: list[UUID] = []
    for cid in requested_ids:
        if cid in existing:
            continue
        db.add(
            NodeClaimLink(node_id=node_id, claim_id=cid, link_kind=payload.link_kind)
        )
        newly_added_ids.append(cid)
        added += 1
    if added > 0:
        record_change(
            db,
            target_type=ChangeTargetType.NODE.value,
            target_id=node.id,
            model_id=model_id_for_version(db, node.version_id),
            version_id=node.version_id,
            kind=ChangeKind.LINK_CLAIM.value,
            reason="Linked claim(s) as evidence",
            source=ChangeSource.MANUAL.value,
            after={"claim_ids": [str(cid) for cid in newly_added_ids]},
            cited_claim_ids=newly_added_ids,
        )
    db.commit()
    return NodeClaimLinkResult(
        node_id=node_id,
        linked_claim_ids=requested_ids,
        added_count=added,
        already_linked_count=len(requested_ids) - added,
    )


@router.delete(
    "/nodes/{node_id}/claims/{claim_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def detach_node_claim(
    project: Annotated[Project, Depends(get_project_or_404)],
    node_id: UUID,
    claim_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    node = db.get(ProcessNode, node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")
    _check_node_in_project(node, project.id, db)
    result = db.execute(
        delete(NodeClaimLink).where(
            NodeClaimLink.node_id == node_id,
            NodeClaimLink.claim_id == claim_id,
        )
    )
    if result.rowcount > 0:
        record_change(
            db,
            target_type=ChangeTargetType.NODE.value,
            target_id=node.id,
            model_id=model_id_for_version(db, node.version_id),
            version_id=node.version_id,
            kind=ChangeKind.UNLINK_CLAIM.value,
            reason="Removed claim",
            source=ChangeSource.MANUAL.value,
            before={"claim_id": str(claim_id)},
            cited_claim_ids=[claim_id],
        )
    db.commit()


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
                detection_reason=c.detection_reason,
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
    payload: Annotated[DeleteRequest | None, Body()] = None,
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

    # Structural impossibility first, provenance second: there's no point
    # demanding a justification for a delete that can never succeed. The gate
    # also has to precede the bulk reassignment below, which it won't roll back.
    reason, ai_applied = _require_delete_reason(
        payload, "A reason is required to delete a lane."
    )

    fallback = others[0]
    # Reassign nodes to a remaining lane so they don't end up orphaned.
    db.execute(
        update(ProcessNode)
        .where(ProcessNode.lane_id == lane_id)
        .values(lane_id=fallback.id)
    )
    record_change(
        db,
        target_type=ChangeTargetType.LANE.value,
        target_id=lane.id,
        model_id=model_id_for_version(db, lane.version_id),
        version_id=lane.version_id,
        kind=ChangeKind.DELETE.value,
        reason=reason,
        before={"name": lane.name},
        source=ChangeSource.CHAT.value if ai_applied else ChangeSource.MANUAL.value,
        actor_kind=ChangeActorKind.AI.value if ai_applied else ChangeActorKind.USER.value,
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


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/chat",
    response_model=ChatResponse,
)
def chat_with_map(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: ChatRequest,
    db: Annotated[Session, Depends(get_db)],
) -> ChatResponse:
    """Conversational AI bound to a specific process map version. Each turn
    re-sends the full client-held history plus the new user message; the
    backend renders a compact map context (lanes/nodes/edges/claims) and
    asks Claude to respond grounded in those sources."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    selected_id = payload.selected_node_id
    ctx = assemble_map_context(db, version, selected_node_id=selected_id)
    # The chat also lets an edge be the selection; preserve that label.
    if selected_id is None and payload.selected_edge_id:
        edge = db.get(ProcessEdge, payload.selected_edge_id)
        if edge is not None and edge.version_id == version.id:
            src = ctx.node_ref_by_id.get(edge.source_node_id, "?")
            tgt = ctx.node_ref_by_id.get(edge.target_node_id, "?")
            label = f" '{edge.label}'" if edge.label else ""
            # Re-render with the edge selection label prepended.
            map_context_text = f"Currently selected: edge {src}->{tgt}{label}\n\n{ctx.text}"
        else:
            map_context_text = ctx.text
    else:
        map_context_text = ctx.text

    history = [
        MapChatTurn(role=t.role, content=t.content) for t in payload.history
    ]
    try:
        content = run_map_chat(
            history=history,
            user_message=payload.user_message,
            map_context_text=map_context_text,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return ChatResponse(content=content)


def _resolve_node_ref(ref, node_id_by_ref):
    """Map one node short ref (N1) to its UUID; None if absent/fabricated."""
    if ref is None:
        return None
    return node_id_by_ref.get(str(ref).strip().upper())


def _reconcile_client():
    """Thin wrapper so the endpoint resolves the Anthropic client lazily and
    tests can patch it without a real key."""
    return _map_reconcile_mod._get_client()


def _render_delta(delta, ctx) -> str:
    """Compact, ref-anchored rendering of the delta for the prompt."""
    lines: list[str] = []
    ref_by_claim = {cid: ref for ref, cid in ctx.claim_ref_to_id.items()}
    if delta.new_evidence:
        lines.append("New evidence (claims in the process, cited by no step):")
        for c in delta.new_evidence:
            ref = ref_by_claim.get(c.id, "?")
            lines.append(f"  {ref}: [{c.kind}] {c.subject}")
    if any(delta.vanished_evidence.values()):
        lines.append("Vanished evidence (claims a step cites but that left the process):")
        for node_id, claim_ids in delta.vanished_evidence.items():
            node_ref = ctx.node_ref_by_id.get(node_id, "?")
            for cid in claim_ids:
                lines.append(f"  {node_ref} still cites {ref_by_claim.get(cid, '?')}")
    return "\n".join(lines) if lines else "(no drift)"


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/ai-edit",
    response_model=AiEditResponse,
)
def ai_edit_node(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    node_id: UUID,
    payload: AiEditRequest,
    db: Annotated[Session, Depends(get_db)],
) -> AiEditResponse:
    """Propose an AI edit for one node. Never mutates: returns structured
    proposals the user accepts or rejects. Model claim citations are resolved
    to UUIDs and fabricated refs dropped."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    node = db.get(ProcessNode, node_id)
    if node is None or node.version_id != version.id:
        raise HTTPException(status_code=404, detail="Node not found in this version")

    ctx = assemble_map_context(db, version, selected_node_id=node.id)

    try:
        if payload.action == AiEditAction.RELABEL:
            raw = propose_relabel(map_context_text=ctx.text, selected_label=ctx.selected_label)
            return AiEditResponse(
                action=payload.action,
                relabel=RelabelProposal(
                    proposed_name=raw.get("proposed_name", node.name),
                    unchanged=bool(raw.get("unchanged", False)),
                    rationale=raw.get("rationale", ""),
                    cited_claim_ids=_resolve_refs(raw.get("cited_claim_refs"), ctx.claim_ref_to_id),
                ),
            )
        if payload.action == AiEditAction.DESCRIBE:
            raw = propose_description(map_context_text=ctx.text, selected_label=ctx.selected_label)
            return AiEditResponse(
                action=payload.action,
                describe=DescribeProposal(
                    proposed_description=raw.get("proposed_description", ""),
                    rationale=raw.get("rationale", ""),
                    cited_claim_ids=_resolve_refs(raw.get("cited_claim_refs"), ctx.claim_ref_to_id),
                ),
            )
        if payload.action == AiEditAction.VALIDATE:
            raw = report_gaps(map_context_text=ctx.text, selected_label=ctx.selected_label)
            gaps = [
                ValidateGap(
                    summary=g.get("summary", ""),
                    severity=g.get("severity", "low"),
                    cited_claim_ids=_resolve_refs(g.get("cited_claim_refs"), ctx.claim_ref_to_id),
                )
                for g in raw.get("gaps", [])
            ]
            return AiEditResponse(action=payload.action, validate_=ValidateProposal(gaps=gaps))
        if payload.action == AiEditAction.SUGGEST_NEXT:
            raw = propose_next_steps(map_context_text=ctx.text, selected_label=ctx.selected_label)
            steps = [
                SuggestedStep(
                    proposed_name=s.get("proposed_name", ""),
                    proposed_type=s.get("proposed_type", "task"),
                    edge_label=s.get("edge_label"),
                    rationale=s.get("rationale", ""),
                    cited_claim_ids=_resolve_refs(s.get("cited_claim_refs"), ctx.claim_ref_to_id),
                )
                for s in raw.get("steps", [])
                if s.get("proposed_name")
            ]
            return AiEditResponse(action=payload.action, suggest_next=SuggestNextProposal(steps=steps))
        if payload.action == AiEditAction.DECOMPOSE:
            if _next_level(model.level) is None:
                raise HTTPException(
                    status_code=422,
                    detail="Cannot decompose: already at the most detailed level (L4).",
                )
            scope = _neighbor_claim_ids(db, version.id, node.id)
            raw = propose_decompose(map_context_text=ctx.text, selected_label=ctx.selected_label)
            steps = [
                SubStep(
                    proposed_name=s.get("proposed_name", ""),
                    proposed_type=s.get("proposed_type", "task"),
                    role=s.get("role", "Process Team"),
                    edge_label=s.get("edge_label"),
                    rationale=s.get("rationale", ""),
                    cited_claim_ids=_resolve_refs_scoped(
                        s.get("cited_claim_refs"), ctx.claim_ref_to_id, scope
                    ),
                )
                for s in raw.get("sub_steps", [])
                if s.get("proposed_name")
            ]
            return AiEditResponse(action=payload.action, decompose=DecomposeProposal(sub_steps=steps))
        raise HTTPException(status_code=422, detail=f"Unsupported action: {payload.action}")
    except (RuntimeError, ValueError) as exc:  # missing API key, bad proposal, etc.
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _create_proposed_step(
    db: Session,
    *,
    version_id: UUID,
    source: ProcessNode,
    lane_id: UUID,
    name: str,
    node_type: str,
    x: float,
    relative_y: float,
    edge_label: str | None,
    cited_claim_ids: list[UUID],
    project_id: UUID,
) -> tuple[ProcessNode, ProcessEdge]:
    """Create one ai_proposed node downstream of ``source`` plus the connecting
    edge and AI_PROPOSED NodeClaimLinks for cited claims that genuinely belong to
    ``project_id``. Caller owns the transaction (no commit here). Shared by the
    ai-proposed-step endpoint and the SP-7c reconcile ``add_step`` accept."""
    node = ProcessNode(
        version_id=version_id,
        type=node_type,
        name=name,
        lane_id=lane_id,
        position={"x": x, "relative_y": relative_y},
        properties={},
    )
    db.add(node)
    db.flush()
    node.properties = {**node.properties, LINEAGE_KEY: str(node.id), "ai_proposed": True}
    flag_modified(node, "properties")

    edge = ProcessEdge(
        version_id=version_id,
        source_node_id=source.id,
        target_node_id=node.id,
        label=edge_label or None,
    )
    db.add(edge)

    if cited_claim_ids:
        real_claims = list(
            db.scalars(
                select(Claim).where(
                    Claim.id.in_(cited_claim_ids),
                    Claim.project_id == project_id,
                )
            ).all()
        )
        for claim in real_claims:
            db.add(
                NodeClaimLink(
                    node_id=node.id,
                    claim_id=claim.id,
                    link_kind=ClaimLinkKind.AI_PROPOSED.value,
                )
            )
    return node, edge


def _mention_sources_from_texts(texts: list[str], ctx) -> list[MentionSource]:
    """Build mention sources from [[claim:uuid]] tokens in resolved text — the
    same dedupe/skip-malformed logic the suggest path uses."""
    out: list[MentionSource] = []
    seen: set[UUID] = set()
    for text in texts:
        for cid_str in re.findall(r"\[\[claim:([0-9a-fA-F-]+)\]\]", text):
            try:
                cid = UUID(cid_str)
            except ValueError:
                continue
            if cid in seen:
                continue
            seen.add(cid)
            tgt = ctx.source_target_by_claim.get(cid)
            if tgt:
                out.append(MentionSource(claim_id=cid, **tgt))
    return out


def _clamp_resolved(text: str, limit: int) -> str:
    """Truncate resolved mention text to a schema limit without leaving a dangling,
    unclosed `[[kind:uuid` fragment from a mid-mention cut (which would render as
    raw markup in the UI)."""
    t = (text or "")[:limit]
    open_at = t.rfind("[[")
    if open_at != -1 and "]]" not in t[open_at:]:
        t = t[:open_at].rstrip()
    return t


def _run_chat_agent(db, project, model_id, version, ctx, focus_refs, payload) -> ChatSuggestResponse:
    tool_ctx = AgentToolCtx(db=db, project_id=project.id, version=version, mapctx=ctx)
    history = [SuggestChatTurn(role=t.role, content=t.content) for t in payload.history]
    # Resolve each focused ref to its label so the loop can name the selected
    # steps inline in the user's turn (reliable deictic resolution).
    focus_items = [
        {"ref": r, "label": ctx.node_name_by_id.get(ctx.node_ref_to_id.get(r), "")}
        for r in focus_refs
    ]

    def _persist(answer, trace, consulted, cited, in_tok, out_tok, rounds, stop, grounded) -> AgentRun:
        run = AgentRun(
            project_id=project.id, model_id=model_id, version_id=version.id,
            session_id=payload.session_id, created_by=None,
            question=payload.user_message, answer=answer,
            tool_calls=trace or [], cited_claim_ids=cited, consulted_claim_ids=consulted,
            input_tokens=in_tok, output_tokens=out_tok, round_count=rounds,
            stop_reason=stop, grounded=grounded,
        )
        db.add(run)
        db.commit()
        db.refresh(run)
        return run

    try:
        result = run_chat_agent(
            tool_ctx=tool_ctx, skeleton_text=ctx.skeleton_text,
            focus_items=focus_items,
            history=history, user_message=payload.user_message,
        )
    except Exception as exc:  # infra failure: graceful message, still record the run
        logger.exception("ask-agent run failed (project=%s version=%s)", project.id, version.id)
        run = _persist(
            answer=None, trace=[{"tool": "error", "summary": str(exc), "detail": None}],
            consulted=[], cited=[], in_tok=0, out_tok=0, rounds=0,
            stop=AgentRunStopReason.ERROR.value, grounded=True,
        )
        return ChatSuggestResponse(
            message="I hit an error looking that up. Please try again.",
            suggestions=[], mention_sources=[], group_summaries=[],
            activity_trace=[], run_id=run.id, grounded=True,
        )

    resolved = _resolve_mention_refs(result.answer, ctx)
    suggestions = result.proposals  # validated ChatSuggestions (resolved refs) from the loop
    questions = []
    for rq in (result.questions or []):
        # Resolve THEN clamp: _resolve_mention_refs expands short refs ([[N3]]) into
        # much longer [[node:uuid]] mentions, so a prompt/label/description near the
        # normalize caps can overflow AgentQuestion/AgentOption's max_length and raise
        # here (outside the try/except) — a 500 that drops the whole ask turn. Clamp
        # the RESOLVED text to the schema limits (mirrors suggestion_ops).
        prompt = _clamp_resolved(_resolve_mention_refs(rq.get("prompt") or "", ctx), 2000)
        if not prompt:
            continue
        opts = []
        for o in rq.get("options", []):
            if not o.get("label"):
                continue
            label = _clamp_resolved(_resolve_mention_refs(o["label"], ctx), 120)
            if not label:
                continue
            desc = _clamp_resolved(_resolve_mention_refs(o["description"], ctx), 300) if o.get("description") else None
            opts.append(AgentOption(label=label, description=desc or None))
        questions.append(AgentQuestion(prompt=prompt, options=opts))
    # Cards alone ARE the response; but when the agent asked, its prose explains why — show it.
    message = resolved if (questions or not suggestions) else ""
    # Mention sources come from the answer prose AND the cards' titles/rationales.
    claim_texts = [resolved] + [s.title for s in suggestions] + [s.rationale for s in suggestions]
    mention_sources = _mention_sources_from_texts(claim_texts, ctx)
    cited = [str(s.claim_id) for s in mention_sources]
    grounded = assess_grounded(resolved, cited)
    # Group summaries: only for groups actually present on an emitted suggestion.
    used_groups = {s.group for s in suggestions if s.group}
    group_summaries: list[GroupSummary] = []
    seen_groups: set[str] = set()
    for g in result.group_summaries:
        if not isinstance(g, dict):
            continue
        gid = str(g.get("id") or "").strip()
        summary = str(g.get("summary") or "").strip()
        if not gid or not summary or gid not in used_groups or gid in seen_groups:
            continue
        seen_groups.add(gid)
        try:
            group_summaries.append(GroupSummary(id=gid, summary=summary[:500]))
        except ValueError:
            continue
    run = _persist(
        answer=resolved, trace=result.trace,
        consulted=[str(x) for x in result.consulted_claim_ids],
        cited=cited, in_tok=result.input_tokens, out_tok=result.output_tokens,
        rounds=result.round_count, stop=result.stop_reason, grounded=grounded,
    )
    return ChatSuggestResponse(
        message=message, suggestions=suggestions, mention_sources=mention_sources,
        group_summaries=group_summaries,
        activity_trace=[ActivityStep(**t) for t in result.trace],
        run_id=run.id, grounded=grounded, questions=questions,
    )


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/chat-suggest",
    response_model=ChatSuggestResponse,
)
def chat_suggest(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: ChatSuggestRequest,
    db: Annotated[Session, Depends(get_db)],
) -> ChatSuggestResponse:
    """Word-style chat. Every request runs the agent tool loop (`_run_chat_agent`),
    which can answer in prose and/or accumulate `propose_changes` calls into
    applyable suggestion cards. Never mutates the map. Model claim refs are
    resolved to UUIDs and fabricated ones dropped; malformed ops are discarded
    before they become proposals."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    # If a single node is attached as context, label it as the selection.
    selected_node_id = next(
        (r.id for r in payload.context_refs if r.kind == RefKind.NODE), None
    )
    ctx = assemble_map_context(db, version, selected_node_id=selected_node_id)

    # Ground the model on EVERY attached node (not just the first). Reference
    # them by the same short refs the map context uses.
    focus_refs = [
        ctx.node_ref_by_id[r.id]
        for r in payload.context_refs
        if r.kind == RefKind.NODE and r.id in ctx.node_ref_by_id
    ]

    return _run_chat_agent(db, project, model_id, version, ctx, focus_refs, payload)


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/ai-proposed-step",
    response_model=AiProposedStepResult,
    status_code=status.HTTP_201_CREATED,
)
def apply_proposed_step(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: AiProposedStepRequest,
    db: Annotated[Session, Depends(get_db)],
) -> AiProposedStepResult:
    """Accept a suggested next step: create one ai_proposed node downstream of
    the source node, plus the connecting edge and NodeClaimLinks for any cited
    claims that actually exist in this project. Everything happens in one
    transaction; bogus/foreign claim ids are silently dropped."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    source = db.get(ProcessNode, payload.source_node_id)
    if source is None or source.version_id != version.id:
        raise HTTPException(
            status_code=422, detail="source_node_id must reference a node in this version"
        )

    lane = db.get(ProcessLane, payload.lane_id)
    if lane is None or lane.version_id != version.id:
        raise HTTPException(
            status_code=422, detail="lane_id must reference a lane in this version"
        )

    node, edge = _create_proposed_step(
        db,
        version_id=version.id,
        source=source,
        lane_id=payload.lane_id,
        name=payload.name,
        node_type=payload.type,
        x=payload.x,
        relative_y=payload.relative_y,
        edge_label=payload.edge_label,
        cited_claim_ids=payload.cited_claim_ids,
        project_id=project.id,
    )

    db.flush()  # ensure edge.id is assigned before logging
    record_change(
        db,
        target_type=ChangeTargetType.NODE.value,
        target_id=node.id,
        model_id=version.model_id,
        version_id=version.id,
        kind=ChangeKind.CREATE.value,
        actor_kind=ChangeActorKind.AI.value,
        source=ChangeSource.RECONCILE.value,
        cited_claim_ids=payload.cited_claim_ids,
        reason="AI-proposed step accepted",
        reasoning_trace=None,
    )
    record_change(
        db,
        target_type=ChangeTargetType.EDGE.value,
        target_id=edge.id,
        model_id=version.model_id,
        version_id=version.id,
        kind=ChangeKind.CONNECT.value,
        actor_kind=ChangeActorKind.AI.value,
        source=ChangeSource.RECONCILE.value,
        reason="AI-proposed step accepted",
        after={"source_node_id": str(edge.source_node_id), "target_node_id": str(edge.target_node_id)},
    )

    db.commit()
    db.refresh(node)
    db.refresh(edge)
    return AiProposedStepResult(
        node=ProcessNodeRead.model_validate(node),
        edge=ProcessEdgeRead.model_validate(edge),
    )


@router.get(
    "/process-maps/{model_id}/versions/{version_id}/consistency",
    response_model=list[ConsistencyFinding],
)
def map_consistency(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> list[ConsistencyFinding]:
    """Deterministic structural problems in the current map version."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")

    nodes = list(db.scalars(select(ProcessNode).where(ProcessNode.version_id == version.id)).all())
    edges = list(db.scalars(select(ProcessEdge).where(ProcessEdge.version_id == version.id)).all())
    lanes = list(db.scalars(select(ProcessLane).where(ProcessLane.version_id == version.id)).all())

    findings = scan_map(
        nodes=[{"id": str(n.id), "name": n.name, "type": n.type,
                "lane_id": str(n.lane_id) if n.lane_id else None} for n in nodes],
        edges=[{"source_node_id": str(e.source_node_id),
                "target_node_id": str(e.target_node_id)} for e in edges],
        lanes=[{"id": str(l.id), "name": l.name} for l in lanes],
    )
    return [
        ConsistencyFinding(
            code=f.code, severity=f.severity, summary=f.summary,
            node_ids=[UUID(x) for x in f.node_ids],
            lane_ids=[UUID(x) for x in f.lane_ids],
        )
        for f in findings
    ]


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/reconcile",
    response_model=ReconcileBatchRead,
)
def reconcile_map(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    payload: ReconcileRequest,
    db: Annotated[Session, Depends(get_db)],
) -> ReconcileBatchRead:
    """Refresh a map from its process's claims. Computes the claim delta in
    plain code; if it is empty, returns an empty batch with NO LLM call. Else
    asks Claude for reconcile ops, resolves their refs to real UUIDs (dropping
    fabrications), and persists one map_reconcile suggestion batch. LLM failure
    -> 503 with nothing persisted."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    if model.process_id is None:
        raise HTTPException(
            status_code=409,
            detail="This map is not linked to a process; attach it before reconciling.",
        )

    delta = compute_claim_delta(db, version, model.process_id)
    if delta.is_empty():
        return ReconcileBatchRead(
            batch_id=None, version_id=version.id, empty=True, suggestions=[]
        )

    ctx = assemble_map_context(db, version, selected_node_id=None)
    node_id_by_ref = {ref: nid for nid, ref in ctx.node_ref_by_id.items()}
    delta_block = _render_delta(delta, ctx)

    try:
        client = _reconcile_client()  # raises RuntimeError if no key
        raw = propose_reconcile(
            client=client,
            model=_map_reconcile_mod.RECONCILE_MODEL,
            context_block=ctx.text,
            delta_block=delta_block,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    batch_id = uuid4()
    rows: list[ProcessSuggestion] = []
    for op in raw.get("ops", []):
        kind = op.get("op")
        payload_out: dict | None = None
        if kind == ReconcileOp.ADD_STEP.value:
            after_id = _resolve_node_ref(op.get("after_node_ref"), node_id_by_ref)
            if after_id is None:
                continue  # fabricated anchor -> drop
            payload_out = {
                "name": (op.get("name") or "").strip(),
                "type": op.get("type") or "task",
                "after_node_id": str(after_id),
                "lane_ref": op.get("lane_ref"),
                "lane_name": op.get("lane_name"),
                "edge_label": op.get("edge_label"),
                "cited_claim_ids": [str(c) for c in _resolve_refs(op.get("cited_claim_refs"), ctx.claim_ref_to_id)],
            }
            if not payload_out["name"]:
                continue
        elif kind == ReconcileOp.RECITE_NODE.value:
            node_id = _resolve_node_ref(op.get("node_ref"), node_id_by_ref)
            if node_id is None:
                continue
            payload_out = {
                "node_id": str(node_id),
                "add_claim_ids": [str(c) for c in _resolve_refs(op.get("add_claim_refs"), ctx.claim_ref_to_id)],
                "remove_claim_ids": [str(c) for c in _resolve_refs(op.get("remove_claim_refs"), ctx.claim_ref_to_id)],
            }
        elif kind == ReconcileOp.FLAG_STALE_NODE.value:
            node_id = _resolve_node_ref(op.get("node_ref"), node_id_by_ref)
            if node_id is None:
                continue
            payload_out = {
                "node_id": str(node_id),
                "vanished_claim_ids": [str(c) for c in _resolve_refs(op.get("vanished_claim_refs"), ctx.claim_ref_to_id)],
            }
        elif kind == ReconcileOp.RELABEL_NODE.value:
            node_id = _resolve_node_ref(op.get("node_ref"), node_id_by_ref)
            proposed = (op.get("proposed_name") or "").strip()
            if node_id is None or not proposed:
                continue
            payload_out = {"node_id": str(node_id), "proposed_name": proposed}
        else:
            continue  # unknown op -> drop

        rows.append(
            ProcessSuggestion(
                batch_id=batch_id,
                project_id=project.id,
                kind="map_reconcile",
                process_id=model.process_id,
                version_id=version.id,
                op=kind,
                payload=payload_out,
                rationale=op.get("rationale", ""),
                status="pending",
            )
        )

    for r in rows:
        db.add(r)
    db.commit()
    for r in rows:
        db.refresh(r)

    return ReconcileBatchRead(
        batch_id=batch_id,
        version_id=version.id,
        empty=False,
        suggestions=[
            ReconcileSuggestionRead(
                id=r.id,
                batch_id=r.batch_id,
                op=ReconcileOp(r.op),
                payload=r.payload,
                rationale=r.rationale or "",
                confidence=r.confidence,
                status=r.status,
            )
            for r in rows
        ],
    )


# ─── SP-5b: decompose-to-next-level ─────────────────────────────────


def _next_level(level: str) -> str | None:
    """L1->L2 ... L3->L4. Returns None at the deepest level (L4) or when
    unparseable — the caller uses None to disable/422 decompose."""
    canon = _normalize_level(level)  # "L3"
    try:
        n = int(canon[1:])
    except (ValueError, IndexError):
        return None
    if n < 1 or n >= 4:
        return None
    return f"L{n + 1}"


def _latest_version_row(db: Session, model_id: UUID):
    """(version_id, version_number) of a model's highest version, or (None, None)."""
    row = db.execute(
        select(ProcessVersion.id, ProcessVersion.version_number)
        .where(ProcessVersion.model_id == model_id)
        .order_by(ProcessVersion.version_number.desc())
        .limit(1)
    ).first()
    return (row[0], row[1]) if row else (None, None)


@router.get("/process-maps/{model_id}", response_model=ProcessModelRead)
def get_process_map(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> ProcessModelRead:
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id or model.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Process model not found")
    lv_id, lv_num = _latest_version_row(db, model.id)
    return ProcessModelRead.model_validate(model).model_copy(
        update={"latest_version_id": lv_id, "latest_version_number": lv_num}
    )


@router.get("/process-maps/{model_id}/ancestry", response_model=list[AncestryCrumb])
def get_map_ancestry(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> list[AncestryCrumb]:
    """Root-to-leaf chain of maps for the breadcrumb. Each crumb's label is the
    parent step it was decomposed from (resolved live via the reverse lookup),
    falling back to the model's own name; deep-link = that map's latest version."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")

    # Walk up to the root (guard against cycles).
    chain: list[ProcessModel] = []
    cur: ProcessModel | None = model
    guard = 0
    while cur is not None and guard < 16:
        chain.append(cur)
        guard += 1
        cur = db.get(ProcessModel, cur.parent_model_id) if cur.parent_model_id else None
    chain.reverse()  # root first

    crumbs: list[AncestryCrumb] = []
    for i, m in enumerate(chain):
        lv_id, _ = _latest_version_row(db, m.id)
        label = m.name
        # For non-root maps, prefer the live name of the parent step that points here.
        if i > 0:
            parent = chain[i - 1]
            p_lv_id, _ = _latest_version_row(db, parent.id)
            if p_lv_id is not None:
                p_nodes = db.scalars(
                    select(ProcessNode).where(ProcessNode.version_id == p_lv_id)
                ).all()
                for n in p_nodes:
                    if (n.properties or {}).get("child_model_id") == str(m.id):
                        label = n.name
                        break
        crumbs.append(AncestryCrumb(model_id=m.id, version_id=lv_id, level=m.level, label=label))
    return crumbs


def _neighbor_claim_ids(db: Session, version_id: UUID, node_id: UUID) -> set[UUID]:
    """Claim ids attached to the node plus every node one edge hop away — the
    grounding scope for decompose (tighter than project-wide)."""
    edge_rows = db.execute(
        select(ProcessEdge.source_node_id, ProcessEdge.target_node_id).where(
            ProcessEdge.version_id == version_id
        )
    ).all()
    node_ids: set[UUID] = {node_id}
    for src, tgt in edge_rows:
        if src == node_id:
            node_ids.add(tgt)
        if tgt == node_id:
            node_ids.add(src)
    claim_ids = db.scalars(
        select(NodeClaimLink.claim_id).where(NodeClaimLink.node_id.in_(node_ids))
    ).all()
    return set(claim_ids)


def _resolve_refs_scoped(refs, claim_ref_to_id, scope: set[UUID]):
    """Like _resolve_refs but additionally drops any resolved id not in `scope`."""
    return [cid for cid in _resolve_refs(refs, claim_ref_to_id) if cid in scope]


@router.post(
    "/process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/decompose",
    response_model=DecomposeResult,
    status_code=status.HTTP_201_CREATED,
)
def apply_decompose(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    node_id: UUID,
    payload: DecomposeRequest,
    db: Annotated[Session, Depends(get_db)],
) -> DecomposeResult:
    """Accept a decompose proposal: create-or-reuse a child ProcessModel one
    level deeper, append a ProcessVersion, persist the sub-step graph marked
    ai_proposed, and link the parent node via properties.child_model_id. One
    transaction; foreign claim ids are silently dropped."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    node = db.get(ProcessNode, node_id)
    if node is None or node.version_id != version.id:
        raise HTTPException(status_code=404, detail="Node not found in this version")

    child_level = _next_level(model.level)
    if child_level is None:
        raise HTTPException(
            status_code=422,
            detail="Cannot decompose: already at the most detailed level (L4).",
        )

    # Find-or-create the child model via the parent node's stored link.
    existing_id = (node.properties or {}).get("child_model_id")
    child: ProcessModel | None = None
    if existing_id:
        try:
            candidate = db.get(ProcessModel, UUID(str(existing_id)))
        except (ValueError, TypeError):
            candidate = None
        if candidate is not None and candidate.deleted_at is None and candidate.project_id == project.id:
            child = candidate
    if child is None:
        child = ProcessModel(
            project_id=project.id,
            name=node.name[:300],
            level=child_level,
            parent_model_id=model.id,
        )
        db.add(child)
        db.flush()

    # Append a new version (re-decompose chains onto the prior latest).
    last_num = db.scalar(
        select(func.coalesce(func.max(ProcessVersion.version_number), 0)).where(
            ProcessVersion.model_id == child.id
        )
    ) or 0
    parent_version = db.scalars(
        select(ProcessVersion)
        .where(ProcessVersion.model_id == child.id, ProcessVersion.version_number == last_num)
        .limit(1)
    ).first()
    child_version = ProcessVersion(
        model_id=child.id,
        version_number=last_num + 1,
        parent_version_id=parent_version.id if parent_version else None,
        status=ProcessVersionStatus.DRAFT.value,
        notes=f"AI-decomposed from '{node.name}'.",
    )
    db.add(child_version)
    db.flush()

    # Lanes: one per distinct role, document order.
    role_order: list[str] = []
    seen: set[str] = set()
    for s in payload.sub_steps:
        r = (s.role or "Process Team").strip() or "Process Team"
        if r not in seen:
            role_order.append(r)
            seen.add(r)
    lane_by_role: dict[str, ProcessLane] = {}
    for idx, role in enumerate(role_order):
        lane = ProcessLane(version_id=child_version.id, name=role, order_index=idx)
        db.add(lane)
        lane_by_role[role] = lane
    db.flush()

    # Resolve real cited claims once (project-scoped guard).
    all_cited = [cid for s in payload.sub_steps for cid in s.cited_claim_ids]
    real_claim_ids: set[UUID] = set()
    if all_cited:
        real_claim_ids = set(
            db.scalars(
                select(Claim.id).where(Claim.id.in_(all_cited), Claim.project_id == project.id)
            ).all()
        )

    # Nodes + linear edge chain. Leave position empty -> the canvas lays it out
    # with Dagre on first open.
    prev: ProcessNode | None = None
    for s in payload.sub_steps:
        role = (s.role or "Process Team").strip() or "Process Team"
        new_node = ProcessNode(
            version_id=child_version.id,
            type=s.proposed_type,
            name=s.proposed_name,
            lane_id=lane_by_role[role].id,
            position={},
            properties={},
        )
        db.add(new_node)
        db.flush()
        new_node.properties = {LINEAGE_KEY: str(new_node.id), "ai_proposed": True}
        flag_modified(new_node, "properties")
        seen_link: set[UUID] = set()
        for cid in s.cited_claim_ids:
            if cid in real_claim_ids and cid not in seen_link:
                db.add(NodeClaimLink(node_id=new_node.id, claim_id=cid,
                                     link_kind=ClaimLinkKind.AI_PROPOSED.value))
                seen_link.add(cid)
        if prev is not None:
            db.add(ProcessEdge(
                version_id=child_version.id,
                source_node_id=prev.id,
                target_node_id=new_node.id,
                label=s.edge_label or None,
            ))
        prev = new_node

    # Link the parent node to the child model.
    node.properties = {**(node.properties or {}), "child_model_id": str(child.id)}
    flag_modified(node, "properties")

    db.commit()
    return DecomposeResult(child_model_id=child.id, child_version_id=child_version.id)


@router.delete(
    "/process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/decompose",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_sub_process(
    project: Annotated[Project, Depends(get_project_or_404)],
    model_id: UUID,
    version_id: UUID,
    node_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    """Reverse a decompose: soft-delete the child model (it leaves the maps
    list) and clear the parent node's child_model_id link."""
    model = db.get(ProcessModel, model_id)
    if model is None or model.project_id != project.id:
        raise HTTPException(status_code=404, detail="Process model not found")
    version = db.get(ProcessVersion, version_id)
    if version is None or version.model_id != model.id:
        raise HTTPException(status_code=404, detail="Process version not found")
    node = db.get(ProcessNode, node_id)
    if node is None or node.version_id != version.id:
        raise HTTPException(status_code=404, detail="Node not found in this version")

    child_id = (node.properties or {}).get("child_model_id")
    if not child_id:
        raise HTTPException(status_code=404, detail="Step has no sub-process to remove")

    try:
        child = db.get(ProcessModel, UUID(str(child_id)))
    except (ValueError, TypeError):
        child = None
    if child is not None and child.deleted_at is None and child.project_id == project.id:
        child.deleted_at = func.now()

    props = {**(node.properties or {})}
    props.pop("child_model_id", None)
    node.properties = props
    flag_modified(node, "properties")
    db.commit()
