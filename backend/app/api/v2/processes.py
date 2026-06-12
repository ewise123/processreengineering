"""SP-7b: durable Process Inventory, claim curation, and the AI suggestion
inbox. Replaces the deleted process_detection router."""
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v2.deps import get_current_user, get_project_or_404
from app.db.session import get_db
from app.api.v2.process_maps import _create_proposed_step
from app.enums import (
    AssignedBy,
    ClaimLinkKind,
    ProcessStatus,
    SuggestionKind,
    SuggestionOutcome,
    SuggestionStatus,
)
from app.models.claim import Claim
from app.models.identity import User
from app.models.process import (
    NodeClaimLink,
    ProcessLane,
    ProcessModel,
    ProcessNode,
    ProcessVersion,
)
from app.models.process_inventory import Process, ProcessClaimLink, ProcessSuggestion
from app.models.project import Project
from app.schemas.process import (
    AcceptSuggestionResult,
    BatchAcceptResult,
    BulkAssignResult,
    BulkUnassignResult,
    ClaimIdList,
    ClaimRef,
    ProcessCreate,
    ProcessRead,
    ProcessUpdate,
    SuggestBatchResult,
    SuggestionRead,
    SuggestProcessesRequest,
)
from app.services.process_detection import (
    detect_segments_from_claims,
    _chunk_ref_for_claim,
    _load_claims_for_detection,
)

router = APIRouter(prefix="/projects/{project_id}", tags=["processes"])


def _get_process_in_project(db: Session, project_id: UUID, process_id: UUID) -> Process:
    proc = db.get(Process, process_id)
    if proc is None or proc.project_id != project_id or proc.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Process not found")
    return proc


def _process_to_read(db: Session, proc: Process) -> ProcessRead:
    claim_count = db.scalar(
        select(func.count(ProcessClaimLink.id)).where(
            ProcessClaimLink.process_id == proc.id
        )
    ) or 0
    map_count = db.scalar(
        select(func.count(ProcessModel.id)).where(
            ProcessModel.process_id == proc.id,
            ProcessModel.deleted_at.is_(None),
        )
    ) or 0
    return ProcessRead(
        id=proc.id,
        project_id=proc.project_id,
        name=proc.name,
        description=proc.description,
        order_index=proc.order_index,
        status=proc.status,
        created_at=proc.created_at,
        updated_at=proc.updated_at,
        claim_count=int(claim_count),
        map_count=int(map_count),
    )


@router.get("/processes", response_model=list[ProcessRead])
def list_processes(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ProcessRead]:
    procs = list(
        db.scalars(
            select(Process)
            .where(Process.project_id == project.id, Process.deleted_at.is_(None))
            .order_by(Process.order_index, Process.created_at)
        ).all()
    )
    return [_process_to_read(db, p) for p in procs]


@router.post("/processes", response_model=ProcessRead, status_code=status.HTTP_201_CREATED)
def create_process(
    payload: ProcessCreate,
    project: Annotated[Project, Depends(get_project_or_404)],
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessRead:
    max_index = db.scalar(
        select(func.coalesce(func.max(Process.order_index), -1)).where(
            Process.project_id == project.id, Process.deleted_at.is_(None)
        )
    )
    proc = Process(
        project_id=project.id,
        name=payload.name.strip(),
        description=payload.description,
        order_index=(max_index if max_index is not None else -1) + 1,
        status=ProcessStatus.ACTIVE.value,
        created_by=user.id,
    )
    db.add(proc)
    db.commit()
    db.refresh(proc)
    return _process_to_read(db, proc)


@router.patch("/processes/{process_id}", response_model=ProcessRead)
def update_process(
    process_id: UUID,
    payload: ProcessUpdate,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> ProcessRead:
    proc = _get_process_in_project(db, project.id, process_id)
    if payload.name is not None:
        proc.name = payload.name.strip()
    if payload.description is not None:
        proc.description = payload.description
    if payload.order_index is not None:
        proc.order_index = payload.order_index
    if payload.status is not None:
        proc.status = payload.status
    db.commit()
    db.refresh(proc)
    return _process_to_read(db, proc)


@router.delete("/processes/{process_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_process(
    process_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    proc = _get_process_in_project(db, project.id, process_id)
    proc.deleted_at = datetime.now(timezone.utc)
    db.commit()


@router.post("/processes/{process_id}/claims", response_model=BulkAssignResult)
def assign_claims(
    process_id: UUID,
    payload: ClaimIdList,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> BulkAssignResult:
    proc = _get_process_in_project(db, project.id, process_id)
    # Only assign claims that genuinely belong to this project.
    valid_ids = set(
        db.scalars(
            select(Claim.id).where(
                Claim.id.in_(payload.claim_ids), Claim.project_id == project.id
            )
        ).all()
    )
    existing = set(
        db.scalars(
            select(ProcessClaimLink.claim_id).where(
                ProcessClaimLink.process_id == proc.id,
                ProcessClaimLink.claim_id.in_(valid_ids),
            )
        ).all()
    )
    linked = 0
    for cid in valid_ids - existing:
        db.add(
            ProcessClaimLink(
                process_id=proc.id, claim_id=cid, assigned_by=AssignedBy.USER.value
            )
        )
        linked += 1
    db.commit()
    return BulkAssignResult(
        process_id=proc.id, linked=linked, already_linked=len(existing)
    )


@router.delete("/processes/{process_id}/claims", response_model=BulkUnassignResult)
def unassign_claims(
    process_id: UUID,
    payload: ClaimIdList,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> BulkUnassignResult:
    proc = _get_process_in_project(db, project.id, process_id)
    links = list(
        db.scalars(
            select(ProcessClaimLink).where(
                ProcessClaimLink.process_id == proc.id,
                ProcessClaimLink.claim_id.in_(payload.claim_ids),
            )
        ).all()
    )
    for link in links:
        db.delete(link)
    db.commit()
    return BulkUnassignResult(process_id=proc.id, removed=len(links))


@router.get("/claims/unassigned", response_model=list[ClaimRef])
def list_unassigned_claims(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> list[ClaimRef]:
    """Triage view: claims with zero process_claim_links. Left-join + IS NULL."""
    rows = db.execute(
        select(Claim.id, Claim.kind, Claim.subject, Claim.source)
        .outerjoin(ProcessClaimLink, ProcessClaimLink.claim_id == Claim.id)
        .where(
            Claim.project_id == project.id,
            ProcessClaimLink.id.is_(None),
        )
        .order_by(Claim.kind, Claim.created_at)
    ).all()
    return [ClaimRef(id=r[0], kind=r[1], subject=r[2], source=r[3]) for r in rows]


# ---------------------------------------------------------------------------
# Suggest processes — runs the pure clustering, writes process_discovery rows.
# ---------------------------------------------------------------------------


@router.post(
    "/suggest-processes",
    response_model=SuggestBatchResult,
    status_code=status.HTTP_201_CREATED,
)
def suggest_processes(
    payload: SuggestProcessesRequest,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> SuggestBatchResult:
    claims = _load_claims_for_detection(db, project.id, payload.scope_input_ids)
    if not claims:
        raise HTTPException(
            status_code=422,
            detail="No claims found for this project (scope). Run extract-claims first.",
        )

    chunk_ref_cache: dict = {}
    claim_dicts = [
        {
            "kind": c.kind,
            "subject": c.subject,
            "chunk_ref": _chunk_ref_for_claim(db, c.id, chunk_ref_cache),
        }
        for c in claims
    ]
    try:
        result = detect_segments_from_claims(claim_dicts)
    except RuntimeError as exc:
        # LLM failure: nothing written, surface as 503 (suggestions only persist
        # after a successful parse).
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if not result.segments:
        raise HTTPException(
            status_code=422,
            detail="The model could not identify any distinct processes in the supplied claims.",
        )

    by_index = dict(enumerate(claims))
    batch_id = uuid4()
    count = 0
    for det in result.segments:
        seg_claim_ids = [
            str(by_index[i].id) for i in det.claim_refs if i in by_index
        ]
        db.add(
            ProcessSuggestion(
                batch_id=batch_id,
                project_id=project.id,
                kind=SuggestionKind.PROCESS_DISCOVERY.value,
                process_id=None,
                op="create_process",
                payload={
                    "name": det.name,
                    "description": det.description,
                    "claim_ids": seg_claim_ids,
                },
                rationale=result.reasoning_summary,
                confidence=det.confidence,
                status=SuggestionStatus.PENDING.value,
                model_used=result.model_used,
                prompt_tokens=result.prompt_tokens,
                output_tokens=result.output_tokens,
            )
        )
        count += 1
    db.commit()
    return SuggestBatchResult(batch_id=batch_id, suggestion_count=count)


@router.get("/process-suggestions", response_model=list[SuggestionRead])
def list_suggestions(
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
    status_: Annotated[str | None, Query(alias="status")] = None,
    kind: Annotated[str | None, Query()] = None,
) -> list[ProcessSuggestion]:
    q = select(ProcessSuggestion).where(ProcessSuggestion.project_id == project.id)
    if status_ is not None:
        q = q.where(ProcessSuggestion.status == status_)
    if kind is not None:
        q = q.where(ProcessSuggestion.kind == kind)
    q = q.order_by(ProcessSuggestion.created_at)
    return list(db.scalars(q).all())


def _get_suggestion(db: Session, project_id: UUID, suggestion_id: UUID) -> ProcessSuggestion:
    sug = db.get(ProcessSuggestion, suggestion_id)
    if sug is None or sug.project_id != project_id:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    return sug


def _link_claims(
    db: Session, process: Process, claim_ids: list[str], project_id: UUID
) -> int:
    """Idempotently link the given claim ids (that belong to project) to the
    process. Returns the number of new links written."""
    if not claim_ids:
        return 0
    valid = set(
        db.scalars(
            select(Claim.id).where(
                Claim.id.in_(claim_ids), Claim.project_id == project_id
            )
        ).all()
    )
    existing = set(
        db.scalars(
            select(ProcessClaimLink.claim_id).where(
                ProcessClaimLink.process_id == process.id,
                ProcessClaimLink.claim_id.in_(valid),
            )
        ).all()
    )
    linked = 0
    for cid in valid - existing:
        db.add(
            ProcessClaimLink(
                process_id=process.id,
                claim_id=cid,
                assigned_by=AssignedBy.AI_ACCEPTED.value,
            )
        )
        linked += 1
    return linked


def apply_suggestion(
    db: Session, project: Project, sug: ProcessSuggestion
) -> AcceptSuggestionResult:
    """Dispatch one accepted suggestion to its mutation. Handles the discovery
    ops (create_process, assign_claims) plus the sp7c reconcile ops add_step and
    recite_node; the remaining reconcile ops (flag_stale_node, relabel_node) are
    added by a later sp7c task — they still raise 422 here.

    Returns the result; the caller is responsible for stamping status/outcome
    and committing. A deleted target → graceful TARGET_GONE no-op (no raise),
    mirroring apply_proposed_step silently dropping unknown claim ids.
    """
    op = sug.op
    payload = sug.payload or {}

    if op == "create_process":
        proc = Process(
            project_id=project.id,
            name=str(payload.get("name", "")).strip() or "Untitled process",
            description=str(payload.get("description", "")),
            status=ProcessStatus.ACTIVE.value,
        )
        max_index = db.scalar(
            select(func.coalesce(func.max(Process.order_index), -1)).where(
                Process.project_id == project.id, Process.deleted_at.is_(None)
            )
        )
        proc.order_index = (max_index if max_index is not None else -1) + 1
        db.add(proc)
        db.flush()
        linked = _link_claims(db, proc, payload.get("claim_ids", []), project.id)
        return AcceptSuggestionResult(
            suggestion_id=sug.id,
            status=SuggestionStatus.ACCEPTED.value,
            outcome=SuggestionOutcome.APPLIED.value,
            process_id=proc.id,
            linked=linked,
        )

    if op == "assign_claims":
        target_id = payload.get("process_id") or sug.process_id
        proc = db.get(Process, target_id) if target_id else None
        if proc is None or proc.project_id != project.id or proc.deleted_at is not None:
            # Target process vanished — graceful no-op.
            return AcceptSuggestionResult(
                suggestion_id=sug.id,
                status=SuggestionStatus.ACCEPTED.value,
                outcome=SuggestionOutcome.TARGET_GONE.value,
            )
        linked = _link_claims(db, proc, payload.get("claim_ids", []), project.id)
        return AcceptSuggestionResult(
            suggestion_id=sug.id,
            status=SuggestionStatus.ACCEPTED.value,
            outcome=SuggestionOutcome.APPLIED.value,
            process_id=proc.id,
            linked=linked,
        )

    if op == "add_step":
        version = db.get(ProcessVersion, sug.version_id)
        after_id = payload.get("after_node_id")
        source = db.get(ProcessNode, UUID(after_id)) if after_id else None
        if version is None or source is None or source.version_id != version.id:
            return AcceptSuggestionResult(
                suggestion_id=sug.id,
                status=SuggestionStatus.ACCEPTED.value,
                outcome=SuggestionOutcome.TARGET_GONE.value,
            )
        # Keep the new step in the source node's lane; fall back to the first lane.
        lane_id = source.lane_id
        if lane_id is None:
            lane = db.scalars(
                select(ProcessLane)
                .where(ProcessLane.version_id == version.id)
                .order_by(ProcessLane.order_index)
            ).first()
            if lane is None:
                return AcceptSuggestionResult(
                    suggestion_id=sug.id,
                    status=SuggestionStatus.ACCEPTED.value,
                    outcome=SuggestionOutcome.TARGET_GONE.value,
                )
            lane_id = lane.id
        cited = [UUID(c) for c in payload.get("cited_claim_ids", [])]
        new_x = float((source.position or {}).get("x", 0)) + 250.0
        _create_proposed_step(
            db,
            version_id=version.id,
            source=source,
            lane_id=lane_id,
            name=payload.get("name", ""),
            node_type=payload.get("type", "task"),
            x=new_x,
            relative_y=float((source.position or {}).get("relative_y", 0)),
            edge_label=payload.get("edge_label"),
            cited_claim_ids=cited,
            project_id=project.id,
        )
        return AcceptSuggestionResult(
            suggestion_id=sug.id,
            status=SuggestionStatus.ACCEPTED.value,
            outcome=SuggestionOutcome.APPLIED.value,
            process_id=sug.process_id,
        )

    if op == "recite_node":
        version = db.get(ProcessVersion, sug.version_id)
        node_id = payload.get("node_id")
        node = db.get(ProcessNode, UUID(node_id)) if node_id else None
        if node is None or version is None or node.version_id != version.id:
            return AcceptSuggestionResult(
                suggestion_id=sug.id,
                status=SuggestionStatus.ACCEPTED.value,
                outcome=SuggestionOutcome.TARGET_GONE.value,
            )
        for cid in payload.get("add_claim_ids", []):
            claim_uuid = UUID(cid)
            exists = db.scalars(
                select(NodeClaimLink).where(
                    NodeClaimLink.node_id == node.id,
                    NodeClaimLink.claim_id == claim_uuid,
                )
            ).first()
            if exists is None:
                claim = db.get(Claim, claim_uuid)
                if claim is not None and claim.project_id == project.id:
                    db.add(
                        NodeClaimLink(
                            node_id=node.id,
                            claim_id=claim_uuid,
                            link_kind=ClaimLinkKind.SUPPORTS.value,
                        )
                    )
        for cid in payload.get("remove_claim_ids", []):
            link = db.scalars(
                select(NodeClaimLink).where(
                    NodeClaimLink.node_id == node.id,
                    NodeClaimLink.claim_id == UUID(cid),
                )
            ).first()
            if link is not None:
                db.delete(link)
        return AcceptSuggestionResult(
            suggestion_id=sug.id,
            status=SuggestionStatus.ACCEPTED.value,
            outcome=SuggestionOutcome.APPLIED.value,
            process_id=sug.process_id,
        )

    # Reconcile ops are not implemented in Phase 2; sp7c extends this dispatcher.
    raise HTTPException(
        status_code=422,
        detail=f"Suggestion op '{op}' is not supported in this phase.",
    )


@router.post(
    "/process-suggestions/{suggestion_id}/accept",
    response_model=AcceptSuggestionResult,
)
def accept_suggestion(
    suggestion_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> AcceptSuggestionResult:
    sug = _get_suggestion(db, project.id, suggestion_id)
    if sug.status != SuggestionStatus.PENDING.value:
        raise HTTPException(status_code=409, detail="Suggestion is not pending.")
    # apply_suggestion raises 422 for unknown ops BEFORE we touch status, so a
    # bad op leaves the row pending (asserted in the test).
    result = apply_suggestion(db, project, sug)
    sug.status = result.status
    sug.outcome = result.outcome
    sug.resolved_at = datetime.now(timezone.utc)
    db.commit()
    return result


@router.post(
    "/process-suggestions/{suggestion_id}/reject",
    response_model=AcceptSuggestionResult,
)
def reject_suggestion(
    suggestion_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> AcceptSuggestionResult:
    sug = _get_suggestion(db, project.id, suggestion_id)
    if sug.status != SuggestionStatus.PENDING.value:
        raise HTTPException(status_code=409, detail="Suggestion is not pending.")
    sug.status = SuggestionStatus.REJECTED.value
    sug.resolved_at = datetime.now(timezone.utc)
    db.commit()
    return AcceptSuggestionResult(
        suggestion_id=sug.id, status=sug.status, outcome=""
    )


@router.post(
    "/process-suggestion-batches/{batch_id}/accept",
    response_model=BatchAcceptResult,
)
def accept_batch(
    batch_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> BatchAcceptResult:
    pending = list(
        db.scalars(
            select(ProcessSuggestion)
            .where(
                ProcessSuggestion.project_id == project.id,
                ProcessSuggestion.batch_id == batch_id,
                ProcessSuggestion.status == SuggestionStatus.PENDING.value,
            )
            .order_by(ProcessSuggestion.created_at)
        ).all()
    )
    accepted = 0
    skipped = 0
    for sug in pending:
        try:
            result = apply_suggestion(db, project, sug)
        except HTTPException:
            # Unsupported op in this phase — skip, leave pending.
            skipped += 1
            continue
        sug.status = result.status
        sug.outcome = result.outcome
        sug.resolved_at = datetime.now(timezone.utc)
        accepted += 1
    db.commit()
    return BatchAcceptResult(batch_id=batch_id, accepted=accepted, skipped=skipped)
