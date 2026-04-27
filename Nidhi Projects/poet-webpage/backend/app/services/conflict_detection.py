import os
from dataclasses import dataclass

import anthropic

from app.enums import ConflictKind

DETECTION_MODEL = os.getenv("CONFLICT_DETECTION_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 8192


CONFLICT_TOOL = {
    "name": "record_conflicts",
    "description": "Record contradictions between claims about the same business process.",
    "input_schema": {
        "type": "object",
        "properties": {
            "conflicts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim_a_index": {
                            "type": "integer",
                            "description": "0-based index of the first claim in the input list.",
                        },
                        "claim_b_index": {
                            "type": "integer",
                            "description": "0-based index of the second claim.",
                        },
                        "kind": {
                            "type": "string",
                            "enum": [k.value for k in ConflictKind],
                        },
                        "reason": {
                            "type": "string",
                            "description": "One sentence explaining why these claims contradict.",
                        },
                    },
                    "required": ["claim_a_index", "claim_b_index", "kind", "reason"],
                },
            }
        },
        "required": ["conflicts"],
    },
}


SYSTEM_PROMPT = """You are an analyst comparing claims about a single business process to find contradictions.

Conflict kinds:
- threshold_mismatch: Two claims state different numeric thresholds for the same decision (e.g., "approval over $10K" vs "approval over $25K").
- owner_mismatch: Two claims assign the same task to different actors/roles.
- sla_mismatch: Two claims state different time bounds for the same step.
- sequence_mismatch: Two claims describe the same two activities in different orders.
- missing_path: A decision claim has only one outcome described, with no claim describing what happens on the other branch.

Rules:
- Only flag genuine contradictions about the SAME activity, decision, or actor. Different activities are not conflicts.
- Use exact 0-based indices into the input list to identify which claims contradict.
- Skip pairs where the difference is just precision ("a few days" vs "3-5 days").

Use the record_conflicts tool. If no conflicts, return an empty array."""


@dataclass
class DetectedConflict:
    claim_a_index: int
    claim_b_index: int
    kind: str
    reason: str


_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


def detect_conflicts(claim_summaries: list[str]) -> list[DetectedConflict]:
    """Pass a numbered list of claim summaries; returns detected conflicts as index pairs."""
    if len(claim_summaries) < 2:
        return []
    numbered = "\n".join(f"[{i}] {s}" for i, s in enumerate(claim_summaries))
    client = _get_client()
    response = client.messages.create(
        model=DETECTION_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        tools=[CONFLICT_TOOL],
        tool_choice={"type": "tool", "name": "record_conflicts"},
        messages=[{"role": "user", "content": numbered}],
    )

    conflicts: list[DetectedConflict] = []
    for block in response.content:
        if block.type != "tool_use" or block.name != "record_conflicts":
            continue
        for c in block.input.get("conflicts", []):
            conflicts.append(
                DetectedConflict(
                    claim_a_index=int(c["claim_a_index"]),
                    claim_b_index=int(c["claim_b_index"]),
                    kind=c["kind"],
                    reason=c["reason"],
                )
            )
    return conflicts
