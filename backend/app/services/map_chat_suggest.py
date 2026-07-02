"""Agentic chat that returns prose plus structured suggested changes.

Ask mode reuses the plain-text chat. Suggest mode binds one optional
`propose_changes` tool: the model replies with prose, a tool call, or both,
emitting suggestions only when an edit is warranted. The service stays
I/O-free apart from the Anthropic call and returns RAW dicts; the endpoint
does ref resolution and per-kind validation.
"""
import os

import anthropic

from app.schemas.version_chat_suggest import ChatMode
from app.services.map_chat import SYSTEM_PROMPT as CHAT_GUARDRAILS, ChatTurn, chat
from app.services.map_chat_agent import MENTION_INSTRUCTIONS, PROPOSE_TOOL, SUGGEST_INSTRUCTIONS

SUGGEST_MODEL = os.getenv("MAP_CHAT_SUGGEST_MODEL", os.getenv("MAP_CHAT_MODEL", "claude-sonnet-4-6"))
MAX_TOKENS = 2000

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
