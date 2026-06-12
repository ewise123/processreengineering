"""Map reconcile (SP-7c).

Two pieces, kept separate so the diff is testable without an LLM:

1. ``compute_claim_delta`` — pure code. Reads the durable process->claim links
   and the version's node->claim citations to find what drifted:
   * new evidence: claims linked to the process but cited by no node here;
   * vanished evidence: per node, the claims it still cites that are no longer
     linked to the process (deleted claims cascade their citations away, so a
     *dangling* citation cannot occur — only live-but-unlinked claims vanish).

2. ``propose_reconcile`` — one forced Anthropic call that turns the rendered
   map context + delta into an ``ops`` array citing short refs (N1, C1). Ref
   resolution + fabrication-dropping happens in the endpoint, not here.
"""
import os
from dataclasses import dataclass, field
from uuid import UUID

import anthropic
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.enums import NodeType
from app.models.claim import Claim
from app.models.process import NodeClaimLink, ProcessNode, ProcessVersion
from app.models.process_inventory import ProcessClaimLink
from app.services.map_chat import SYSTEM_PROMPT as CHAT_GUARDRAILS


@dataclass
class ClaimDelta:
    """New + vanished evidence for one (version, process) pair."""

    new_evidence: list[Claim] = field(default_factory=list)
    # node_id -> claim ids the node still cites that are no longer in the process
    vanished_evidence: dict[UUID, list[UUID]] = field(default_factory=dict)

    def is_empty(self) -> bool:
        return not self.new_evidence and not any(self.vanished_evidence.values())


def compute_claim_delta(db: Session, version: ProcessVersion, process_id: UUID) -> ClaimDelta:
    """Diff the durable process claim set against this version's citations."""
    # Claims currently linked to the process (durable scope).
    process_claim_ids = set(
        db.scalars(
            select(ProcessClaimLink.claim_id).where(
                ProcessClaimLink.process_id == process_id
            )
        ).all()
    )

    # Claim ids cited by any node in this version, with their node ids.
    citation_rows = list(
        db.execute(
            select(NodeClaimLink.node_id, NodeClaimLink.claim_id)
            .join(ProcessNode, NodeClaimLink.node_id == ProcessNode.id)
            .where(ProcessNode.version_id == version.id)
        ).all()
    )
    cited_claim_ids = {claim_id for _, claim_id in citation_rows}

    # New evidence: linked to process, cited by no node here. Load the Claim
    # rows (the prompt renders their kind/subject).
    new_ids = process_claim_ids - cited_claim_ids
    new_evidence = (
        list(db.scalars(select(Claim).where(Claim.id.in_(new_ids))).all())
        if new_ids
        else []
    )
    # Stable order by subject for deterministic prompts/tests.
    new_evidence.sort(key=lambda c: (c.subject or "", str(c.id)))

    # Vanished evidence: a cited claim no longer linked to the process.
    vanished: dict[UUID, list[UUID]] = {}
    for node_id, claim_id in citation_rows:
        if claim_id not in process_claim_ids:
            vanished.setdefault(node_id, []).append(claim_id)

    return ClaimDelta(new_evidence=new_evidence, vanished_evidence=vanished)


# ---------------------------------------------------------------------------
# Forced-tool Anthropic service
# ---------------------------------------------------------------------------

RECONCILE_MODEL = os.getenv("MAP_RECONCILE_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 2000  # an ops array over several nodes can be long; degrade to fewer ops if truncated

_NODE_TYPES = [t.value for t in NodeType]

_CLAIM_REFS = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Claim short refs (e.g. C1, C2) taken verbatim from the grounding context. Use ONLY refs that appear there; never invent one.",
}

RECONCILE_TOOL = {
    "name": "propose_reconcile",
    "description": (
        "Reconcile a process map against its claim set. Given the new evidence "
        "(claims now in the process but cited by no step) and vanished evidence "
        "(claims a step still cites but that left the process), propose the "
        "smallest set of ops that brings the map back in line WITHOUT discarding "
        "layout or hand edits. Prefer recite/flag/relabel over adding steps; only "
        "add a step when new evidence clearly describes an unmapped activity."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "ops": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "op": {
                            "type": "string",
                            "enum": [
                                "add_step",
                                "recite_node",
                                "flag_stale_node",
                                "relabel_node",
                            ],
                        },
                        # add_step
                        "name": {"type": ["string", "null"]},
                        "type": {"type": ["string", "null"], "enum": _NODE_TYPES + [None]},
                        "after_node_ref": {"type": ["string", "null"]},
                        "lane_ref": {"type": ["string", "null"]},
                        "lane_name": {"type": ["string", "null"]},
                        "edge_label": {"type": ["string", "null"]},
                        "cited_claim_refs": _CLAIM_REFS,
                        # recite_node
                        "node_ref": {"type": ["string", "null"]},
                        "add_claim_refs": _CLAIM_REFS,
                        "remove_claim_refs": _CLAIM_REFS,
                        # flag_stale_node
                        "vanished_claim_refs": _CLAIM_REFS,
                        # relabel_node
                        "proposed_name": {"type": ["string", "null"]},
                        # all ops
                        "rationale": {"type": "string"},
                    },
                    "required": ["op", "rationale"],
                },
            }
        },
        "required": ["ops"],
    },
}

_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


def propose_reconcile(*, client, model: str, context_block: str, delta_block: str) -> dict:
    """One forced-tool call. ``client`` is injected so the endpoint can pass
    ``_get_client()`` and tests can pass a fake. Returns ``{"ops": [...]}`` with
    short refs intact; the endpoint resolves them. Malformed/empty tool calls
    degrade to ``{"ops": []}``."""
    system = (
        CHAT_GUARDRAILS
        + "\n\n---\nTask: reconcile the process map against its claim set using the "
        "propose_reconcile tool. Make the smallest faithful set of ops.\n\n"
        "---\nCurrent process map (grounded source of truth):\n"
        + context_block
        + "\n\n---\nDrift to reconcile:\n"
        + delta_block
    )
    user = "Reconcile this map. Use the propose_reconcile tool."
    response = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        system=system,
        tools=[RECONCILE_TOOL],
        tool_choice={"type": "tool", "name": RECONCILE_TOOL["name"]},
        messages=[{"role": "user", "content": user}],
        timeout=60.0,
    )
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == RECONCILE_TOOL["name"]:
            raw = dict(block.input)
            ops = raw.get("ops")
            return {"ops": ops if isinstance(ops, list) else []}
    return {"ops": []}
