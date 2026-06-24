"""Conversational AI assistant for an open process map.

Design goals (per user direction 2026-04-29):
- Grounded in the project's sources (claims + citations). Never invent.
- Non-sycophantic: push back when the user's premise contradicts the sources;
  say "I don't know" rather than guess; flag tradeoffs.
- Selection (a node/edge) is *context*, not constraint. Reason about
  neighbors, the lane, and the whole flow when answering.
"""
import os
from dataclasses import dataclass

import anthropic

CHAT_MODEL = os.getenv("MAP_CHAT_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 1500


SYSTEM_PROMPT = """You are an assistant inside POET, a process-reengineering tool that maps real business processes from interviews, SOPs, and other source documents.

Your job:
- Help the analyst review and improve the process map currently open.
- Answer questions about specific steps, transitions, and gaps.
- Challenge the map when it disagrees with the source claims.

Hard rules:
1. **Ground every substantive claim in the project's sources.** When you cite a fact about the process, reference the supporting claim by its short id (e.g. "claim C3 says…"). Do not invent process steps, timings, owners, or thresholds that aren't in the claims.
2. **No sycophancy.** If the user's premise is wrong relative to the sources, say so plainly. Don't hedge with "great question" or agree to please. If you don't know something, say "I don't know" or "the sources don't say."
3. **Use general process knowledge sparingly and explicitly.** If you draw on patterns from typical processes (e.g. "AP processes usually have a 3-way match"), label it as general knowledge, distinguish it from what the sources actually say, and frame it as a question — never an assertion about this process.
4. **Selection is context, not scope.** When the user has a node or edge selected, treat it as the focus of the conversation but freely reason about neighbors, the lane, the upstream/downstream path, and the whole map.
5. **When asked about gaps:** look at the actual edges + claims for evidence. Cite which steps exist, which don't, and what the sources do or do not say about transitions.
6. **Format:** plain prose. Use short paragraphs. Use lists only when comparing multiple items. Keep responses tight — usually under 200 words unless the user asks for depth.

You receive the current map state and the conversation history each turn."""


@dataclass
class ChatTurn:
    role: str  # "user" | "assistant"
    content: str


def chat(
    *,
    history: list[ChatTurn],
    user_message: str,
    map_context_text: str,
    extra_instructions: str = "",
) -> str:
    """Run one turn of the chat. `history` is the prior turns (oldest first),
    `user_message` is the new message, `map_context_text` is the rendered
    map summary the model should ground in. `extra_instructions` is an optional
    block inserted between the system prompt and the map context."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")

    client = anthropic.Anthropic(api_key=api_key)

    # Compose the system message: persona + optional extra instructions + the
    # current map state. Keeping the map context in `system` (not in user
    # messages) lets prompt caching kick in across turns — only the last user
    # message changes.
    full_system = SYSTEM_PROMPT
    if extra_instructions:
        full_system += "\n\n---\n" + extra_instructions
    full_system += (
        "\n\n---\nCurrent process map (grounded source of truth):\n"
        + map_context_text
    )

    messages = []
    for turn in history:
        if turn.role not in ("user", "assistant"):
            continue
        messages.append({"role": turn.role, "content": turn.content})
    messages.append({"role": "user", "content": user_message})

    response = client.messages.create(
        model=CHAT_MODEL,
        max_tokens=MAX_TOKENS,
        system=full_system,
        messages=messages,
        timeout=60.0,
    )
    parts: list[str] = []
    for block in response.content:
        if block.type == "text":
            parts.append(block.text)
    return "".join(parts).strip() or "(no response)"


def build_map_context(
    *,
    lanes: list[dict],
    nodes: list[dict],
    edges: list[dict],
    claims: list[dict],
    selected_label: str | None,
) -> str:
    """Render the map + claims as a compact text block the model can ground in.

    Each entity gets a short id (L1, N1, E1, C1) so the model can cite back.
    Claim `kind` and `subject` are included; the first citation quote is
    included when present so the model can quote sources verbatim.
    """
    out: list[str] = []
    if selected_label:
        out.append(f"Currently selected: {selected_label}")
        out.append("")

    out.append("LANES:")
    for lane in lanes:
        out.append(f"  L{lane['idx']}: {lane['name']}")
    out.append("")

    out.append("NODES:")
    for node in nodes:
        lane_ref = f" (in {node['lane_ref']})" if node.get("lane_ref") else ""
        out.append(
            f"  N{node['idx']} [{node['type']}]: {node['label']}{lane_ref}"
        )
    out.append("")

    out.append("EDGES:")
    for edge in edges:
        label = f" '{edge['label']}'" if edge.get("label") else ""
        out.append(
            f"  E{edge['idx']}: {edge['source_ref']} -> {edge['target_ref']}{label}"
        )
    out.append("")

    out.append("CLAIMS (source-of-truth statements with citations):")
    if not claims:
        out.append("  (no extracted claims yet)")
    for claim in claims:
        attached = (
            f" [attached to {claim['attached_to']}]"
            if claim.get("attached_to")
            else " [unattached]"
        )
        out.append(
            f"  C{claim['idx']} [{claim['kind']}]{attached}: {claim['subject']}"
        )
        if claim.get("quote"):
            out.append(f"     quote: \"{claim['quote']}\"")
            if claim.get("source"):
                out.append(f"     source: {claim['source']}")

    return "\n".join(out)
