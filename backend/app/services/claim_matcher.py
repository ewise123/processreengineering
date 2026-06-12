"""Per-process claim matcher (ephemeral).

Given a process (name, description, and the claims already linked to it as
exemplars) and a list of candidate claims, ask Claude which candidates belong
to the process. Two pieces, kept separate so the prompt is testable without an
LLM:

1. ``render_process_block`` / ``render_candidates_block`` — pure prompt text.
2. ``propose_claim_matches`` — one forced Anthropic tool call returning a
   ``matches`` array citing candidate short refs (C1, C2). Ref resolution +
   fabrication-dropping happens in the endpoint, not here.
"""
import os

import anthropic


def render_process_block(
    name: str, description: str, exemplars: list[tuple[str, str]]
) -> str:
    """Render the process 'definition' the model matches against."""
    lines = [f"Process name: {name}"]
    if description.strip():
        lines.append(f"Description: {description.strip()}")
    if exemplars:
        lines.append("Claims already linked to this process (examples of what belongs here):")
        for kind, subject in exemplars:
            lines.append(f"  - [{kind}] {subject}")
    else:
        lines.append("This process has no claims yet.")
    return "\n".join(lines)


def render_candidates_block(candidates: list[tuple[str, str, str, bool]]) -> str:
    """Render the candidate claims. Each tuple is (ref, kind, subject, in_other)."""
    lines = ["Candidate claims — cite the ones that belong by their ref:"]
    for ref, kind, subject, in_other in candidates:
        tag = "  (already linked to another process)" if in_other else ""
        lines.append(f"  {ref}: [{kind}] {subject}{tag}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Forced-tool Anthropic service
# ---------------------------------------------------------------------------

CLAIM_MATCH_MODEL = os.getenv("CLAIM_MATCH_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 1500

_SYSTEM = (
    "You assign claims to a business process in POET, a process-mapping tool. A "
    "claim belongs to a process when it describes an activity, decision, input, or "
    "output that is part of that process. Use the process's existing claims as the "
    "pattern of what belongs. Be precise — omit claims you are unsure about rather "
    "than guessing."
)

MATCH_TOOL = {
    "name": "match_claims",
    "description": (
        "Given a process (its name, description, and the claims already linked to "
        "it) and a list of candidate claims, pick the candidates that genuinely "
        "belong to this process. Cite each by its ref (e.g. C1) taken verbatim from "
        "the candidate list; never invent a ref. Include only claims that clearly "
        "fit; omit the rest."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "matches": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim_ref": {
                            "type": "string",
                            "description": "A candidate ref (e.g. C1) verbatim from the list.",
                        },
                        "confidence": {
                            "type": ["number", "null"],
                            "description": "0..1 confidence that the claim belongs.",
                        },
                        "rationale": {
                            "type": "string",
                            "description": "One short sentence on why it fits.",
                        },
                    },
                    "required": ["claim_ref"],
                },
            }
        },
        "required": ["matches"],
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


def propose_claim_matches(
    *, client, model: str, process_block: str, candidates_block: str
) -> dict:
    """One forced-tool call. ``client`` is injected so the endpoint can pass
    ``_get_client()`` and tests can pass a fake. Returns ``{"matches": [...]}`` with
    candidate refs intact; the endpoint resolves them. Malformed/empty tool calls
    degrade to ``{"matches": []}``."""
    system = (
        _SYSTEM
        + "\n\n---\nProcess to match against:\n"
        + process_block
        + "\n\n---\n"
        + candidates_block
    )
    user = "Select the candidate claims that belong to this process. Use the match_claims tool."
    response = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        system=system,
        tools=[MATCH_TOOL],
        tool_choice={"type": "tool", "name": MATCH_TOOL["name"]},
        messages=[{"role": "user", "content": user}],
        timeout=60.0,
    )
    for block in response.content:
        if getattr(block, "type", None) == "tool_use" and block.name == MATCH_TOOL["name"]:
            raw = dict(block.input)
            matches = raw.get("matches")
            return {"matches": matches if isinstance(matches, list) else []}
    return {"matches": []}
