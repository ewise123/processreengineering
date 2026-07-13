"""Suggestion build/validate/resolve helpers, shared by the (soon-to-retire)
chat-suggest endpoint path and the agent tool loop's propose_changes tool.

This module is intentionally dependency-light: it imports only stdlib and
`app.schemas.*` so it can be imported from both `app.api.v2.process_maps`
(endpoint path) and `app.services.agent_tools` (agent loop) without a
circular import.
"""
import re
from uuid import UUID, uuid4

from app.schemas.version_chat_suggest import (
    ChatSuggestion,
    ObjectRef,
    OpKind,
    RefKind,
    SuggestionOp,
)


def _resolve_refs(refs, claim_ref_to_id):
    """Map the model's short claim refs to real UUIDs; drop any not present in
    the grounding context (defeats fabricated citations)."""
    out = []
    for r in refs or []:
        cid = claim_ref_to_id.get(str(r).strip().upper())
        if cid is not None and cid not in out:
            out.append(cid)
    return out


# Op field -> (resolution map attname, RefKind). Fields not listed are literals.
_OP_REF_FIELDS: dict[str, tuple[str, RefKind]] = {
    "node_ref": ("node_ref_to_id", RefKind.NODE),
    "near_node_ref": ("node_ref_to_id", RefKind.NODE),
    "edge_ref": ("edge_ref_to_id", RefKind.EDGE),
    "lane_ref": ("lane_ref_to_id", RefKind.LANE),
    "from_ref": ("node_ref_to_id", RefKind.NODE),
    "to_ref": ("node_ref_to_id", RefKind.NODE),
    "temp_id": (None, None),  # never resolved; identifies a new object
}


def _resolve_one_ref(value, map_attr, ctx):
    """Short ref (N1) -> UUID string. tmp:N and unknown refs pass through unchanged."""
    if value is None or str(value).startswith("tmp:"):
        return value, None
    real = getattr(ctx, map_attr).get(str(value).strip().upper())
    if real is None:
        return value, None  # leave unresolved; affected_refs will skip it
    return str(real), real


_MENTION_RE = re.compile(r"\[\[([NELC])(\d+)\]\]")
_MENTION_KIND = {"N": ("node", "node_ref_to_id"), "E": ("edge", "edge_ref_to_id"),
                 "L": ("lane", "lane_ref_to_id"), "C": ("claim", "claim_ref_to_id")}


def _resolve_mention_refs(message: str, ctx) -> str:
    """Rewrite short refs the model emitted ([[N3]]/[[E2]]/[[C1]]/[[L1]]) into
    stable [[kind:uuid]] mentions the frontend can link. Unknown refs are
    flattened to plain text so prose stays readable."""
    def _sub(m):
        letter, num = m.group(1), m.group(2)
        short = f"{letter}{num}"
        kind, attr = _MENTION_KIND[letter]
        real = getattr(ctx, attr).get(short)
        return f"[[{kind}:{real}]]" if real is not None else short
    return _MENTION_RE.sub(_sub, message)


def _build_suggestion_op(raw: dict, ctx, index: int):
    """Resolve a raw model suggestion into a validated ChatSuggestion, or None
    if the op is malformed. Mirrors _resolve_refs' fabricated-ref hygiene."""
    op_kwargs = {"kind": raw.get("kind")}
    affected: list[ObjectRef] = []
    real_id_by_field: dict[str, UUID] = {}
    for field, (map_attr, ref_kind) in _OP_REF_FIELDS.items():
        if field not in raw or raw[field] is None:
            continue
        if field == "temp_id":
            op_kwargs[field] = raw[field]
            continue
        resolved_str, real_id = _resolve_one_ref(raw[field], map_attr, ctx)
        op_kwargs[field] = resolved_str
        if real_id is not None:
            affected.append(ObjectRef(kind=ref_kind, id=real_id))
            real_id_by_field[field] = real_id
    # literal (non-ref) fields pass straight through
    for field in ("new_label", "description", "name", "node_type", "edge_label", "sub_steps", "condition_text"):
        if raw.get(field) is not None:
            op_kwargs[field] = raw[field]

    # add_node requires `new_label`, but the model commonly fills the generic
    # `name` field for a new node's label instead. Coalesce so the op validates
    # rather than being dropped (a dropped add_node orphans the add_edge ops that
    # point at its temp_id, which then sinks the whole bundle on the client).
    if (
        op_kwargs.get("kind") == OpKind.ADD_NODE.value
        and not op_kwargs.get("new_label")
        and op_kwargs.get("name")
    ):
        op_kwargs["new_label"] = op_kwargs["name"]

    try:
        op = SuggestionOp(**op_kwargs)
    except (ValueError, TypeError, KeyError):
        return None  # malformed op -> dropped, never reaches the client

    # Normalize the group to a trimmed string (or None): the model can emit a
    # non-string or whitespace-padded value, which would otherwise miss the
    # later group_summaries match.
    raw_group = raw.get("group")
    group = raw_group.strip() if isinstance(raw_group, str) and raw_group.strip() else None

    # Resolve [[N3]]/[[C1]] mentions in title + rationale into [[kind:uuid]] the
    # same way prose is resolved, so the UI renders named, clickable links there.
    raw_origin = raw.get("origin")
    origin = raw_origin if raw_origin in ("user_directed", "ai_volunteered") else None

    return ChatSuggestion(
        id=f"sg-{index}-{uuid4().hex[:8]}",
        group=group,
        title=_resolve_mention_refs(str(raw.get("title") or op.kind.value), ctx)[:300],
        op=op,
        affected_refs=affected,
        rationale=_resolve_mention_refs(str(raw.get("rationale") or ""), ctx)[:2000],
        cited_claim_ids=_resolve_refs(raw.get("cited_claim_refs"), ctx.claim_ref_to_id),
        before_label=_rename_before_label(op.kind, real_id_by_field, ctx),
        origin=origin,
    )


def _rename_before_label(kind, real_id_by_field: dict, ctx) -> str | None:
    """For a rename-family op, the target's current name/label — frozen so the
    card shows a stable "old -> new" instead of collapsing once applied."""
    field, attr = {
        OpKind.RELABEL_NODE: ("node_ref", "node_name_by_id"),
        OpKind.RENAME_LANE: ("lane_ref", "lane_name_by_id"),
        OpKind.RELABEL_EDGE: ("edge_ref", "edge_label_by_id"),
    }.get(kind, (None, None))
    if field is None or field not in real_id_by_field:
        return None
    return getattr(ctx, attr, {}).get(real_id_by_field[field])


def _repair_new_lane_temp_ids(raw_suggestions) -> None:
    """In-place: recover the producer/consumer link for a "create a lane and move
    a step into it" bundle.

    The model frequently emits `add_lane` (with a `name` but NO `temp_id`) plus a
    `move_to_lane`/`add_node` that references the new lane via a `tmp:` `lane_ref`.
    Without a `temp_id` the add_lane fails validation and is dropped in build,
    which in turn orphans its consumer (pruned by `_drop_orphaned_consumers`), so
    the whole change silently vanishes. The model taught only the add_node/add_edge
    temp_id convention; this is the lane analogue of the add_node `new_label`
    coalesce. Give each temp_id-less add_lane the tmp lane ref its siblings already
    point at — matched by the shared `group` when present, or the single
    unambiguous ref across the bundle otherwise. Only acts when unambiguous."""
    if not isinstance(raw_suggestions, list):
        return

    def _is_tmp(v) -> bool:
        return isinstance(v, str) and v.startswith("tmp:")

    add_lane = OpKind.ADD_LANE.value
    # tmp lane refs consumed by non-add_lane ops, overall and keyed by group.
    consumed_all: set[str] = set()
    consumed_by_group: dict[str, set[str]] = {}
    for s in raw_suggestions:
        if not isinstance(s, dict) or s.get("kind") == add_lane:
            continue
        ref = s.get("lane_ref")
        if _is_tmp(ref):
            consumed_all.add(ref)
            group = s.get("group")
            if isinstance(group, str):
                consumed_by_group.setdefault(group, set()).add(ref)

    needy = [
        s for s in raw_suggestions
        if isinstance(s, dict) and s.get("kind") == add_lane and not _is_tmp(s.get("temp_id"))
    ]
    for s in needy:
        group = s.get("group")
        by_group = consumed_by_group.get(group) if isinstance(group, str) else None
        if by_group and len(by_group) == 1:
            s["temp_id"] = next(iter(by_group))
        elif len(needy) == 1 and len(consumed_all) == 1:
            s["temp_id"] = next(iter(consumed_all))


def _drop_orphaned_consumers(suggestions: list[ChatSuggestion]) -> list[ChatSuggestion]:
    """Remove suggestions that consume a `tmp:` ref with no surviving producer.

    A producer is an op that actually creates a referenceable object — add_node
    (a node) or add_lane (a lane). If the model's producing op is dropped during
    build, its `tmp:` id is left dangling on the consumers (the add_edge ops that
    point at it). The frontend rejects an entire bundle the moment one ref is
    unresolvable, so we prune the orphans server-side and ship only the
    internally-consistent ops. Only genuine producers count, so a malformed op
    that carries a stray `temp_id` can't keep a consumer alive. Runs to a fixpoint
    in case a pruned consumer was itself a producer."""
    producer_kinds = {OpKind.ADD_NODE, OpKind.ADD_LANE}
    kept = list(suggestions)
    while True:
        produced = {s.op.temp_id for s in kept if s.op.kind in producer_kinds and s.op.temp_id}
        survivors = []
        for s in kept:
            consumed = (
                s.op.node_ref, s.op.edge_ref, s.op.lane_ref,
                s.op.from_ref, s.op.to_ref, s.op.near_node_ref,
            )
            dangling = any(
                r and str(r).startswith("tmp:") and r not in produced
                for r in consumed
            )
            if not dangling:
                survivors.append(s)
        if len(survivors) == len(kept):
            return survivors
        kept = survivors


# Human-readable object noun per ref field, for actionable rejection messages.
_REF_FIELD_NOUN = {
    "node_ref": "node", "near_node_ref": "node", "from_ref": "node", "to_ref": "node",
    "edge_ref": "edge", "lane_ref": "lane",
}


def build_suggestion(raw: dict, ctx, index: int) -> tuple[ChatSuggestion | None, str | None]:
    """Resolve one raw model op into a validated ChatSuggestion.
    Returns (suggestion, None) on success, or (None, actionable_error). Replaces
    silent-drop for in-loop use."""
    kind = raw.get("kind")
    # Referential check FIRST so the error can name the bad ref. tmp: refs are
    # produced within the batch and checked by the orphan pass, not here.
    for field, (map_attr, _rk) in _OP_REF_FIELDS.items():
        if field == "temp_id" or field not in raw or raw[field] is None:
            continue
        val = str(raw[field]).strip()
        if val.startswith("tmp:"):
            continue
        if getattr(ctx, map_attr).get(val.upper()) is None:
            noun = _REF_FIELD_NOUN.get(field, "object")
            return None, (
                f"{kind}: {field} '{raw[field]}' is not a {noun} on the current map. "
                f"Use find_node/search_claims to get a valid ref, then re-propose."
            )
    if kind == OpKind.REMOVE_LANE.value and len(getattr(ctx, "lane_ref_to_id", {})) <= 1:
        return None, "remove_lane: this is the only lane on the map — a process map must keep at least one lane. Do not propose removing it."
    sugg = _build_suggestion_op(raw, ctx, index)
    if sugg is None:
        try:
            SuggestionOp(**{k: raw.get(k) for k in raw if k not in ("title", "rationale", "group", "cited_claim_refs")})
        except Exception as exc:
            errs = exc.errors() if hasattr(exc, "errors") else None
            msg = errs[0]["msg"] if errs else str(exc).splitlines()[0]
            return None, f"{kind}: {msg[:160]}"
        return None, f"{kind}: malformed op."
    return sugg, None


def validate_proposal_batch(raw_ops, ctx, *, start_index: int) -> tuple[list[ChatSuggestion], list[dict]]:
    """Validate one propose_changes call's ops against the live map.
    Returns (accepted, rejected); rejected = [{index, kind, error}]. Temp ids
    produced WITHIN this batch are satisfiable; a consumer whose producer was
    rejected is itself reported rejected (never silently dropped)."""
    if not isinstance(raw_ops, list):
        return [], []
    _repair_new_lane_temp_ids(raw_ops)
    accepted: list[ChatSuggestion] = []
    rejected: list[dict] = []
    for i, raw in enumerate(raw_ops):
        idx = start_index + i
        if not isinstance(raw, dict):
            rejected.append({"index": idx, "kind": None, "error": "op is not an object"})
            continue
        sugg, err = build_suggestion(raw, ctx, idx)
        if sugg is None:
            rejected.append({"index": idx, "kind": raw.get("kind"), "error": err})
        else:
            accepted.append(sugg)
    survivors = _drop_orphaned_consumers(accepted)
    survivor_ids = {s.id for s in survivors}
    for s in accepted:
        if s.id not in survivor_ids:
            rejected.append({
                "index": None, "kind": s.op.kind.value,
                "error": (f"{s.op.kind.value}: references a new (tmp:) object that was not created in THIS "
                          "propose_changes call. Emit the producing add_node/add_lane and every op referencing "
                          "its temp id together in one call, then re-propose."),
            })
    return survivors, rejected
