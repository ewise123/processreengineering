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

MENTION_INSTRUCTIONS = (
    "When you reference a specific step or a source claim, wrap its short ref in "
    "double brackets so the UI can turn it into a link: a node (step) as [[N3]], a "
    "claim as [[C1]]. Refer to a transition by linking its endpoint STEPS — e.g. "
    "\"from [[N1]] to [[N2]]\" — never emit an edge ref. Use the refs exactly as they "
    "appear in the map context below; never invent one. The [[ref]] link ALREADY "
    "shows the element's name, so never restate that name anywhere near the ref — not "
    "in parentheses, not after a dash or colon, not as a bold heading, title, or "
    "quoted label. Refer to a step ONLY through its [[ref]] link and write naturally "
    "around it: \"[[N3]] is the entry point…\", never \"[[N3]] — Receive invoice…\" or a "
    "\"**Receive invoice**\" heading above the text."
)

SUGGEST_INSTRUCTIONS = """\
You may propose concrete edits to the map via the `propose_changes` tool.

When to propose vs. converse:
- If the user gives a DIRECT, actionable instruction to change the map ("add a
  step…", "rename…", "describe…", "remove…", "move…", "connect…", "split…"), call
  `propose_changes` RIGHT AWAY. This holds even mid-conversation — a chatty
  history never turns a direct command into a discussion. When you do propose:
  - Your prose message MUST be empty or a single short clause of framing. Do NOT
    write the proposed content (the new label, the description text, the new
    step's details) out in prose — the card already shows it, so repeating it is
    noise. A "describe this step" command should return the description ONLY
    inside the describe_node suggestion, with empty prose.
  - NEVER ask whether to apply, proceed, or confirm — no "Shall I apply it?",
    "Do you want me to…", "Let me know if…". The card's own Apply/Dismiss control
    is the only confirmation; asking in prose is wrong and redundant.
- If the request is open-ended or exploratory ("help me think about…", "what's
  wrong with…", "is this right?"), reply in prose and hold off on the tool until
  the user asks for a specific change.
- A map that is already correct gets a prose reply and NO tool call.

Rules for suggestions:
- One suggestion per discrete change. Give each a short imperative `title`.
- Reference EXISTING objects by their short refs from the context: nodes N1/N2,
  edges E1/E2, lanes L1/L2. Reference NEW objects you introduce by temp ids like
  tmp:1, tmp:2 — so an add_edge can point `from_ref`/`to_ref` at a new node's
  temp_id.
- For a NEW step (add_node), put its label in `new_label` (NOT `name` — `name` is
  only for lanes). Every add_node MUST carry a `temp_id`, and any add_edge that
  wires it in MUST reference that same temp_id.
- In `title` and `rationale`, when you mention a step or a source claim, wrap its
  ref in double brackets exactly as in prose ([[N3]] for a step, [[C1]] for a
  claim) — the UI turns these into named, clickable links. Never write a bare
  "N3" in a title or rationale, and never repeat the step's name in parentheses
  after the ref.
- Group related changes by giving them the same `group` string. For EACH group
  you use, add one entry to the top-level `groups` array — {"id": "<that group
  string>", "summary": "<one short sentence on what the grouped changes
  accomplish together>"} — so the user sees the bundle's overall purpose.
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
                        "new_label": {
                            "type": ["string", "null"],
                            "description": "The label/text of a node. REQUIRED for add_node (the new step's label) and relabel_node/relabel_edge. Do NOT use `name` for a node — that field is only for lanes.",
                        },
                        "description": {"type": ["string", "null"]},
                        "name": {
                            "type": ["string", "null"],
                            "description": "A LANE's name — only for add_lane and rename_lane. For a node's label use `new_label`.",
                        },
                        "node_type": {"type": ["string", "null"], "enum": [*_NODE_TYPES]},
                        "near_node_ref": {"type": ["string", "null"]},
                        "edge_label": {"type": ["string", "null"]},
                        "sub_steps": {"type": ["array", "null"], "items": {"type": "object"}},
                    },
                    "required": ["kind", "title", "rationale"],
                },
            },
            "groups": {
                "type": "array",
                "description": (
                    "One entry per group string used across the suggestions, giving "
                    "the bundle's overall purpose in one short sentence."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "summary": {"type": "string"},
                    },
                    "required": ["id", "summary"],
                },
            },
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
) -> tuple[str, list[dict], list[dict]]:
    """Return (prose_message, raw_suggestion_dicts, raw_group_dicts). Raw dicts
    use the model's short refs; the endpoint resolves and validates them."""
    if mode == ChatMode.ASK:
        message = chat(
            history=history,
            user_message=user_message,
            map_context_text=map_context_text,
            extra_instructions=MENTION_INSTRUCTIONS,
        )
        return message, [], []

    system = (
        CHAT_GUARDRAILS
        + "\n\n---\n"
        + SUGGEST_INSTRUCTIONS
        + "\n\n"
        + MENTION_INSTRUCTIONS
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
    raw_groups: list[dict] = []
    for block in response.content:
        if block.type == "text":
            text_parts.append(block.text)
        elif block.type == "tool_use" and block.name == "propose_changes":
            payload_in = dict(block.input)
            suggestions_raw = payload_in.get("suggestions", [])
            if isinstance(suggestions_raw, list):
                raw_suggestions.extend(suggestions_raw)
            groups_raw = payload_in.get("groups", [])
            if isinstance(groups_raw, list):
                raw_groups.extend(groups_raw)
    return "".join(text_parts).strip(), raw_suggestions, raw_groups
