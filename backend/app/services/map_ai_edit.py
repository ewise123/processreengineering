"""Per-node AI-edit actions (SP-5a).

Each action is one synchronous Anthropic call using a single forced tool, so
the model must return structured JSON (mirrors conflict_detection.py). The
model cites claims by their short refs (C1, C2, ...) from the grounding
context; the *endpoint* resolves those refs to UUIDs and drops fabricated
ones. The service stays I/O-free apart from the Anthropic call so it is
unit-testable with a fake client.
"""
import os

import anthropic

from app.enums import NodeType
from app.services.map_chat import SYSTEM_PROMPT as CHAT_GUARDRAILS

AI_EDIT_MODEL = os.getenv("MAP_AI_EDIT_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 1200  # suggest_next with many downstream steps can approach this; bump if truncated

_NODE_TYPES = [t.value for t in NodeType]

_CITED = {
    "type": "array",
    "items": {"type": "string"},
    "description": (
        "Short refs (e.g. C1, C2) of the claims that justify this, taken verbatim from the "
        "grounding context. Use ONLY refs that appear there; never invent one."
    ),
}

RELABEL_TOOL = {
    "name": "propose_relabel",
    "description": "Propose a clearer, source-faithful label for the selected step.",
    "input_schema": {
        "type": "object",
        "properties": {
            "proposed_name": {
                "type": "string",
                "description": "The proposed step label. If no change is warranted, repeat the current label.",
            },
            "unchanged": {
                "type": "boolean",
                "description": "True if the current label is already faithful and you propose no change.",
            },
            "rationale": {
                "type": "string",
                "description": "One or two sentences, citing claim refs.",
            },
            "cited_claim_refs": _CITED,
        },
        "required": ["proposed_name", "unchanged", "rationale", "cited_claim_refs"],
    },
}

DESCRIBE_TOOL = {
    "name": "propose_description",
    "description": "Propose a concise description of what the selected step does, grounded in the sources.",
    "input_schema": {
        "type": "object",
        "properties": {
            "proposed_description": {"type": "string"},
            "rationale": {"type": "string"},
            "cited_claim_refs": _CITED,
        },
        "required": ["proposed_description", "rationale", "cited_claim_refs"],
    },
}

# NOTE: the user-facing action is AiEditAction.VALIDATE ("validate"); the Anthropic tool and
# service function are deliberately named "report_gaps" to be more descriptive of what the
# model actually does (reports completeness gaps). The route resolves the mismatch.
VALIDATE_TOOL = {
    "name": "report_gaps",
    "description": (
        "Report completeness gaps for the selected step: missing detail, undefined branches, "
        "unstated owners/thresholds. Empty array if none."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "gaps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "severity": {"type": "string", "enum": ["low", "medium", "high"]},
                        "cited_claim_refs": _CITED,
                    },
                    "required": ["summary", "severity", "cited_claim_refs"],
                },
            }
        },
        "required": ["gaps"],
    },
}

SUGGEST_TOOL = {
    "name": "propose_next_steps",
    "description": (
        "Propose one or more steps that plausibly follow the selected step, grounded in the "
        "sources. Empty array if the sources don't support any."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "proposed_name": {"type": "string"},
                        "proposed_type": {"type": "string", "enum": _NODE_TYPES},
                        "edge_label": {"type": ["string", "null"]},
                        "rationale": {"type": "string"},
                        "cited_claim_refs": _CITED,
                    },
                    "required": ["proposed_name", "proposed_type", "rationale", "cited_claim_refs"],
                },
            }
        },
        "required": ["steps"],
    },
}

_ACTION_INSTRUCTIONS = {
    "relabel": (
        "Focus on the currently selected step. Propose a clearer, source-faithful label. "
        "If the current label is already faithful, set unchanged=true and repeat it."
    ),
    "describe": (
        "Focus on the currently selected step. Write a concise description (1-3 sentences) "
        "of what it does, grounded only in the sources."
    ),
    "validate": (
        "Focus on the currently selected step. Identify completeness gaps the sources reveal "
        "(missing branches, undefined owners/thresholds, unstated exceptions). "
        "Do not invent requirements."
    ),
    "suggest_next": (
        "Focus on the currently selected step. Propose plausible NEXT steps grounded in the "
        "sources. If the sources don't support a next step, return an empty array rather than guessing."
    ),
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


def _run(tool: dict, action: str, map_context_text: str, selected_label: str | None) -> dict:
    system = (
        CHAT_GUARDRAILS
        + "\n\n---\nAction: "
        + _ACTION_INSTRUCTIONS[action]
        + "\n\n---\nCurrent process map (grounded source of truth):\n"
        + map_context_text
    )
    user = f"Selected: {selected_label or '(none)'}. Use the {tool['name']} tool."
    client = _get_client()
    response = client.messages.create(
        model=AI_EDIT_MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
        messages=[{"role": "user", "content": user}],
        timeout=60.0,
    )
    for block in response.content:
        if block.type != "tool_use" or block.name != tool["name"]:
            continue
        return dict(block.input)
    return {}  # malformed/empty tool call → caller treats as empty proposal


def propose_relabel(*, map_context_text: str, selected_label: str | None) -> dict:
    return _run(RELABEL_TOOL, "relabel", map_context_text, selected_label)


def propose_description(*, map_context_text: str, selected_label: str | None) -> dict:
    return _run(DESCRIBE_TOOL, "describe", map_context_text, selected_label)


def report_gaps(*, map_context_text: str, selected_label: str | None) -> dict:
    return _run(VALIDATE_TOOL, "validate", map_context_text, selected_label)


def propose_next_steps(*, map_context_text: str, selected_label: str | None) -> dict:
    return _run(SUGGEST_TOOL, "suggest_next", map_context_text, selected_label)
