"""Map reconcile (SP-7c).

Two pieces, kept separate so the diff is testable without an LLM:

1. ``compute_claim_delta`` — pure code. Reads the durable process->claim links
   and the version's node->claim citations to find what drifted:
   * new evidence: claims linked to the process but cited by no node here;
   * vanished evidence: per node, the claims it still cites that are no longer
     linked to the process (deleted claims cascade their citations away, so a
     *dangling* citation cannot occur — only live-but-unlinked claims vanish).

2. ``propose_reconcile`` — one forced Anthropic call (added in a later task)
   that turns the rendered map context + delta into an ``ops`` array citing
   short refs (N1, C1). Ref resolution + fabrication-dropping happens in the
   endpoint, not here.
"""
from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.claim import Claim
from app.models.process import NodeClaimLink, ProcessNode, ProcessVersion
from app.models.process_inventory import ProcessClaimLink


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
