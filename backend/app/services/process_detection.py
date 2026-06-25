"""Cluster a project's claims into proposed business processes.

Single blocking call to Claude with a tool-use schema. The output drives
the new detection-review UI: each segment carries a name, description,
confidence, and an array of claim_refs (indices into the numbered claim
list the model was given).
"""
import os
from dataclasses import dataclass
from uuid import UUID

import anthropic
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.claim import Claim, ClaimCitation
from app.models.input import Chunk, DocumentSection

DETECTION_MODEL = os.getenv("PROCESS_DETECTION_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 6000
MAX_CLAIMS_INPUT = 1200

SEGMENT_TOOL = {
    "name": "record_process_segments",
    "description": "Record the distinct business processes detected in a set of claims.",
    "input_schema": {
        "type": "object",
        "properties": {
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "maxLength": 80},
                        "description": {"type": "string", "maxLength": 280},
                        "claim_refs": {
                            "type": "array",
                            "items": {"type": "integer"},
                        },
                        "confidence": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1,
                        },
                    },
                    "required": ["name", "description", "claim_refs", "confidence"],
                },
            },
            "unassigned_claim_refs": {
                "type": "array",
                "items": {"type": "integer"},
            },
            "reasoning_summary": {"type": "string", "maxLength": 800},
        },
        "required": ["segments", "unassigned_claim_refs"],
    },
}

SYSTEM_PROMPT = """You discover the distinct business processes present in a set of process claims extracted from documents (interviews, SOPs, policies, manuals, meeting notes).

A "claim" is an atomic statement about how a business process works. Each is rendered as:

  [index] kind | from chunk cN | subject

Your job is to group claims into business processes and return them via the record_process_segments tool. Follow these rules precisely:

1. A process is a goal-directed flow with a definable trigger and outcome — NOT a topic. "Accounts Payable" is a process; "approvals" is a topic that runs through many processes.
2. Boundaries follow ownership, trigger, and artifact transitions. When the actor changes AND the artifact being acted on changes AND the upstream trigger changes, you've crossed a process boundary. Any single signal alone is insufficient.
3. Be conservative — splits over merges. If unsure whether two clumps belong together, split them. The user can merge in the review step; un-merging is harder.
4. Name in noun phrases, not verbs. "Strategic Account Onboarding," not "Onboard accounts." Use the language the source documents use when it is clear.
5. Ambient claims go to unassigned_claim_refs. Tooling/system mentions, organizational facts, cross-cutting policies — if a claim describes the environment rather than a flow, leave it unassigned.
6. Confidence is per segment, not global. A clear segment with 25+ supporting claims is 0.9. A speculative segment built from 3 fragmentary claims is 0.4. The UI flags low confidence.

If you cannot ground a cluster in the claims' language, emit name: "Unnamed cluster {n}" and confidence ≤ 0.3. Do not invent names not supported by the source.

Every claim index appears exactly once: either in a segment's claim_refs OR in unassigned_claim_refs. Indices must be valid (0 ≤ i < total claims).

Use the record_process_segments tool with all extracted segments."""


@dataclass
class DetectedSegment:
    name: str
    description: str
    claim_refs: list[int]
    confidence: float


@dataclass
class DetectionResult:
    segments: list[DetectedSegment]
    unassigned_claim_refs: list[int]
    reasoning_summary: str
    model_used: str
    prompt_tokens: int | None
    output_tokens: int | None


_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


def render_claim_lines(claims: list[dict]) -> str:
    """Render the numbered three-column claim list the model sees."""
    return "\n".join(
        f"[{i}] {c.get('kind', '?')} | from chunk {c.get('chunk_ref', '?')} | {c.get('subject', '')}"
        for i, c in enumerate(claims)
    )


def detect_segments_from_claims(claims: list[dict]) -> DetectionResult:
    """Single Claude call. Each claim dict must carry kind, subject, chunk_ref.

    The caller is responsible for building chunk_ref (typically `c{n}` where
    n is the chunk's position within its document).
    """
    if not claims:
        return DetectionResult(
            segments=[],
            unassigned_claim_refs=[],
            reasoning_summary="",
            model_used=DETECTION_MODEL,
            prompt_tokens=None,
            output_tokens=None,
        )

    if len(claims) > MAX_CLAIMS_INPUT:
        claims = claims[:MAX_CLAIMS_INPUT]

    user_message = f"Cluster these {len(claims)} claims into business processes.\n\nClaims:\n{render_claim_lines(claims)}"

    client = _get_client()
    response = client.messages.create(
        model=DETECTION_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        tools=[SEGMENT_TOOL],
        tool_choice={"type": "tool", "name": "record_process_segments"},
        messages=[{"role": "user", "content": user_message}],
    )

    payload = None
    for block in response.content:
        if (
            getattr(block, "type", None) == "tool_use"
            and getattr(block, "name", None) == "record_process_segments"
        ):
            payload = block.input
            break
    if payload is None:
        raise RuntimeError(
            "Claude returned no record_process_segments tool_use block."
        )

    segments = [
        DetectedSegment(
            name=str(s.get("name", "")).strip(),
            description=str(s.get("description", "")).strip(),
            claim_refs=[
                int(r)
                for r in (s.get("claim_refs") or [])
                if isinstance(r, (int, float))
            ],
            confidence=float(s.get("confidence", 0.0)),
        )
        for s in (payload.get("segments") or [])
    ]
    unassigned = [
        int(r)
        for r in (payload.get("unassigned_claim_refs") or [])
        if isinstance(r, (int, float))
    ]
    reasoning = str(payload.get("reasoning_summary") or "").strip()

    usage = getattr(response, "usage", None)
    return DetectionResult(
        segments=segments,
        unassigned_claim_refs=unassigned,
        reasoning_summary=reasoning,
        model_used=DETECTION_MODEL,
        prompt_tokens=getattr(usage, "input_tokens", None) if usage else None,
        output_tokens=getattr(usage, "output_tokens", None) if usage else None,
    )


def _load_claims_for_detection(
    db: Session,
    project_id: UUID,
    scope_input_ids: list[UUID] | None,
) -> list[Claim]:
    q = select(Claim).where(Claim.project_id == project_id)
    if scope_input_ids:
        q = (
            q.join(ClaimCitation, ClaimCitation.claim_id == Claim.id)
            .join(Chunk, Chunk.id == ClaimCitation.chunk_id)
            .join(DocumentSection, DocumentSection.id == Chunk.section_id)
            .where(DocumentSection.input_id.in_(scope_input_ids))
            .distinct()
        )
    q = q.order_by(Claim.kind, Claim.created_at)
    return list(db.scalars(q).all())


def _chunk_ref_for_claim(
    db: Session, claim_id: UUID, chunk_ref_cache: dict
) -> str:
    """Pick the first citation's chunk and produce a ref like 'c{n}', where n
    is the chunk's order within its document. Cached per-claim."""
    if claim_id in chunk_ref_cache:
        return chunk_ref_cache[claim_id]
    cit = db.scalars(
        select(ClaimCitation)
        .where(ClaimCitation.claim_id == claim_id)
        .order_by(ClaimCitation.created_at)
        .limit(1)
    ).first()
    if cit is None:
        ref = "c?"
    else:
        chunk = db.get(Chunk, cit.chunk_id)
        section = db.get(DocumentSection, chunk.section_id) if chunk else None
        ref = f"c{(section.order_index if section else 0) + (chunk.char_start // 1000 if chunk else 0)}"
    chunk_ref_cache[claim_id] = ref
    return ref


