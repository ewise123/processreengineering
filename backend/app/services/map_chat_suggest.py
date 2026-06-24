"""Agentic chat that returns prose plus structured suggested changes.

Ask mode reuses the plain-text chat. Suggest mode binds one optional
`propose_changes` tool: the model replies with prose, a tool call, or both,
emitting suggestions only when an edit is warranted. The service stays
I/O-free apart from the Anthropic call and returns RAW dicts; the endpoint
does ref resolution and per-kind validation.
"""
import os

import anthropic

from app.enums import NodeType
from app.schemas.version_chat_suggest import ChatMode, OpKind
from app.services.map_chat import SYSTEM_PROMPT as CHAT_GUARDRAILS, ChatTurn, chat

SUGGEST_MODEL = os.getenv("MAP_CHAT_SUGGEST_MODEL", os.getenv("MAP_CHAT_MODEL", "claude-sonnet-4-6"))
MAX_TOKENS = 2000

_NODE_TYPES = [t.value for t in NodeType]
_OP_KINDS = [k.value for k in OpKind]

SUGGEST_INSTRUCTIONS = """\
You may propose concrete edits to the map. Call `propose_changes` ONLY when the
sources or the map's structure actually warrant a change. A question, or a map
that is already correct, gets a prose reply and NO tool call.

Rules for suggestions:
- One suggestion per discrete change. Give each a short imperative `title`.
- Reference EXISTING objects by their short refs from the context: nodes N1/N2,
  edges E1/E2, lanes L1/L2. Reference NEW objects you introduce by temp ids like
  tmp:1, tmp:2 — so an add_edge can point `from_ref`/`to_ref` at a new node's
  temp_id.
- Group related changes by giving them the same `group` string.
- Justify each with `rationale` and `cited_claim_refs` (short claim refs C1, C2
  from the context; never invent one).
- Do not propose a deletion casually; only when the sources clearly contradict
  an object's existence.
"""

PROPOSE_TOOL = {
    "name": "propose_changes",
    "description": "Emit one or more suggested edits to the open process map.",
    "input_schema": {
        "type": "object",
        "properties": {
            "suggestions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": _OP_KINDS},
                        "title": {"type": "string"},
                        "rationale": {"type": "string"},
                        "group": {"type": ["string", "null"]},
                        "cited_claim_refs": {
                            "type": "array", "items": {"type": "string"},
                            "description": "Short claim refs (C1, C2) from the context. Never invent one.",
                        },
                        "node_ref": {"type": ["string", "null"]},
                        "edge_ref": {"type": ["string", "null"]},
                        "lane_ref": {"type": ["string", "null"]},
                        "temp_id": {"type": ["string", "null"]},
                        "from_ref": {"type": ["string", "null"]},
                        "to_ref": {"type": ["string", "null"]},
                        "new_label": {"type": ["string", "null"]},
                        "description": {"type": ["string", "null"]},
                        "name": {"type": ["string", "null"]},
                        "node_type": {"type": ["string", "null"], "enum": [*_NODE_TYPES]},
                        "near_node_ref": {"type": ["string", "null"]},
                        "edge_label": {"type": ["string", "null"]},
                        "sub_steps": {"type": ["array", "null"], "items": {"type": "object"}},
                    },
                    "required": ["kind", "title", "rationale"],
                },
            }
        },
        "required": ["suggestions"],
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


def run_chat_suggest(
    *,
    history: list[ChatTurn],
    user_message: str,
    map_context_text: str,
    mode: ChatMode,
) -> tuple[str, list[dict]]:
    """Return (prose_message, raw_suggestion_dicts). Raw dicts use the model's
    short refs; the endpoint resolves and validates them."""
    if mode == ChatMode.ASK:
        message = chat(
            history=history,
            user_message=user_message,
            map_context_text=map_context_text,
        )
        return message, []

    system = (
        CHAT_GUARDRAILS
        + "\n\n---\n"
        + SUGGEST_INSTRUCTIONS
        + "\n\n---\nCurrent process map (grounded source of truth):\n"
        + map_context_text
    )
    messages = [{"role": t.role, "content": t.content} for t in history
                if t.role in ("user", "assistant")]
    messages.append({"role": "user", "content": user_message})

    client = _get_client()
    response = client.messages.create(
        model=SUGGEST_MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        tools=[PROPOSE_TOOL],
        messages=messages,
        timeout=90.0,
    )

    text_parts: list[str] = []
    raw_suggestions: list[dict] = []
    for block in response.content:
        if block.type == "text":
            text_parts.append(block.text)
        elif block.type == "tool_use" and block.name == "propose_changes":
            suggestions_raw = dict(block.input).get("suggestions", [])
            if isinstance(suggestions_raw, list):
                raw_suggestions.extend(suggestions_raw)
    return "".join(text_parts).strip(), raw_suggestions
