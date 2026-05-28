"""Cluster a project's claims into proposed business processes.

Single blocking call to Claude with a tool-use schema. The output drives
the new detection-review UI: each segment carries a name, description,
confidence, and an array of claim_refs (indices into the numbered claim
list the model was given).
"""
import os
from dataclasses import dataclass

import anthropic

DETECTION_MODEL = os.getenv("PROCESS_DETECTION_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 6000
MAX_CLAIMS_INPUT = 600

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
