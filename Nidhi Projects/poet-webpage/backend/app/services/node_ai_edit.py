"""AI-assisted node-edit suggestion. Returns a proposal — application is the
caller's responsibility (existing PATCH /nodes/{id})."""
import os
from dataclasses import dataclass

import anthropic

EDIT_MODEL = os.getenv("NODE_EDIT_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 1024


SUGGEST_TOOL = {
    "name": "propose_node_edit",
    "description": (
        "Propose a single-node edit in response to the user's instruction. "
        "Currently scoped to label rewrites — the rationale should explain "
        "the change so the reviewer can decide whether to apply it."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "suggested_label": {
                "type": "string",
                "description": (
                    "The proposed new label for the node. Keep it concise "
                    "(under 60 chars), action-oriented when describing a "
                    "task, and faithful to the source claims."
                ),
                "minLength": 1,
                "maxLength": 200,
            },
            "rationale": {
                "type": "string",
                "description": (
                    "One or two sentences explaining what changed and why. "
                    "Reference specific claims or context when relevant."
                ),
                "maxLength": 500,
            },
        },
        "required": ["suggested_label", "rationale"],
    },
}


SYSTEM_PROMPT = """You help process-reengineering analysts refine BPMN node labels.

You receive:
- The current node's label, type, and lane.
- A list of supporting claims (kind + subject + optional citations).
- The user's instruction (e.g. "make it clearer", "match SOP wording", "shorten this").

Rules:
- Only propose a label change. Do not suggest moving lanes, changing type, or splitting nodes.
- Stay faithful to what the claims actually say. Do not invent process steps.
- Be concise and action-oriented for tasks ("Validate invoice header"), terse for events ("Invoice received"), interrogative for gateways ("Amount > $10K?").
- If the user's instruction can't be honored without inventing facts, propose the closest reasonable change and explain the limitation in the rationale.

Always call the propose_node_edit tool — never reply in plain text."""


@dataclass
class NodeEditSuggestion:
    suggested_label: str
    rationale: str


def suggest_node_edit(
    *,
    instruction: str,
    current_label: str,
    node_type: str,
    lane_name: str | None,
    claims: list[dict],
) -> NodeEditSuggestion:
    """`claims` is a list of {kind, subject, quote?} dicts giving context."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")

    client = anthropic.Anthropic(api_key=api_key)
    user_message = _build_user_message(
        instruction=instruction,
        current_label=current_label,
        node_type=node_type,
        lane_name=lane_name,
        claims=claims,
    )

    response = client.messages.create(
        model=EDIT_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        tools=[SUGGEST_TOOL],
        tool_choice={"type": "tool", "name": "propose_node_edit"},
        messages=[{"role": "user", "content": user_message}],
    )

    for block in response.content:
        if block.type == "tool_use" and block.name == "propose_node_edit":
            data = block.input
            return NodeEditSuggestion(
                suggested_label=str(data["suggested_label"]).strip(),
                rationale=str(data["rationale"]).strip(),
            )
    raise RuntimeError("Model did not return a propose_node_edit tool call")


def _build_user_message(
    *,
    instruction: str,
    current_label: str,
    node_type: str,
    lane_name: str | None,
    claims: list[dict],
) -> str:
    lane_line = f"Lane: {lane_name}\n" if lane_name else "Lane: (unassigned)\n"
    claim_lines = "\n".join(
        f"- [{c.get('kind', 'claim')}] {c.get('subject', '')}"
        + (f"  (\"{c['quote']}\")" if c.get("quote") else "")
        for c in claims
    ) or "(no linked claims)"
    return (
        f"Current node:\n"
        f"  Label: {current_label}\n"
        f"  Type: {node_type}\n"
        f"  {lane_line}"
        f"\nSupporting claims:\n{claim_lines}\n"
        f"\nUser instruction: {instruction}\n"
    )
