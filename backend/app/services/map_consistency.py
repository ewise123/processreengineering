"""Deterministic structural consistency scan for a process map.

Pure function over plain dicts (no DB, no LLM) so it is trivially testable and
reusable. Each Finding names the offending object ids and a severity. The chat
layer can later phrase fixes; this module only detects.
"""
from dataclasses import dataclass, field

_EXCLUSIVE_GATEWAY_TYPES = {"gateway_exclusive", "gateway_inclusive"}


@dataclass
class Finding:
    code: str
    severity: str  # "low" | "medium" | "high"
    summary: str
    node_ids: list[str] = field(default_factory=list)
    edge_keys: list[str] = field(default_factory=list)
    lane_ids: list[str] = field(default_factory=list)


def scan_map(*, nodes: list[dict], edges: list[dict], lanes: list[dict]) -> list[Finding]:
    findings: list[Finding] = []
    node_ids = {n["id"] for n in nodes}

    # 1. Dangling edges: endpoint missing from the node set.
    for e in edges:
        src, tgt = e.get("source_node_id"), e.get("target_node_id")
        if src not in node_ids or tgt not in node_ids:
            findings.append(Finding(
                code="dangling_edge", severity="high",
                summary=f"Edge {src}->{tgt} references a node that does not exist.",
                node_ids=[x for x in (src, tgt) if x in node_ids],
                edge_keys=[f"{src}->{tgt}"],
            ))

    # 2. Duplicate step names (case-insensitive, non-empty).
    by_name: dict[str, list[str]] = {}
    for n in nodes:
        key = (n.get("name") or "").strip().lower()
        if key:
            by_name.setdefault(key, []).append(n["id"])
    for name, ids in by_name.items():
        if len(ids) > 1:
            findings.append(Finding(
                code="duplicate_name", severity="medium",
                summary=f"{len(ids)} steps share the name '{name}'.",
                node_ids=sorted(ids),
            ))

    # 3. Exclusive/inclusive gateways with fewer than two outgoing branches.
    out_count: dict[str, int] = {}
    for e in edges:
        out_count[e.get("source_node_id")] = out_count.get(e.get("source_node_id"), 0) + 1
    for n in nodes:
        if n.get("type") in _EXCLUSIVE_GATEWAY_TYPES and out_count.get(n["id"], 0) < 2:
            findings.append(Finding(
                code="single_branch_gateway", severity="medium",
                summary=f"Decision gateway '{n.get('name')}' has fewer than two outgoing branches.",
                node_ids=[n["id"]],
            ))

    # 4. Orphan nodes: no incoming or outgoing edge (ignore start/end events).
    touched: set[str] = set()
    for e in edges:
        touched.add(e.get("source_node_id"))
        touched.add(e.get("target_node_id"))
    for n in nodes:
        if n["id"] not in touched and n.get("type") not in ("event_start", "event_end"):
            findings.append(Finding(
                code="orphan_node", severity="low",
                summary=f"Step '{n.get('name')}' is not connected to any other step.",
                node_ids=[n["id"]],
            ))

    # 5. Ownerless lanes: blank lane name.
    for l in lanes:
        if not (l.get("name") or "").strip():
            findings.append(Finding(
                code="ownerless_lane", severity="low",
                summary="A lane has no owner/role name.",
                lane_ids=[l["id"]],
            ))

    return findings
