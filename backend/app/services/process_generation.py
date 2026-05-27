"""Generate a structured BPMN process map from a project's claims.

Input: a numbered list of claims (kind + subject) extracted in Phase 2.
Output: a `structure` dict (steps + gateways, each with `claim_refs`) that
matches the legacy build_bpmn_xml shape, plus the rendered BPMN XML.

The system prompt and level guidance are adapted from the legacy main.py
process-map generator (extract_process_structure / STRUCTURE_PROMPT /
LEVEL_INSTRUCTIONS), with one additive change: every step and gateway must
include a `claim_refs` array indexing back into the claims list. That list is
how we populate node_claim_links / edge_claim_links for provenance.
"""
import json
import os
import re
from dataclasses import dataclass

import anthropic

GENERATION_MODEL = os.getenv("PROCESS_GENERATION_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 8000
MAX_CLAIMS_INPUT = 400  # soft cap; prompt remains well under context window

STRUCTURE_PROMPT = """You are a business process analyst. Given a numbered list of CLAIMS extracted from documents (interviews, SOPs, policies), produce a BPMN 2.0 process map covering those claims.

Return ONLY a valid JSON object in this exact format — no markdown, no explanation:
{
  "process_name": "Short name of the process",
  "steps": [
    {
      "id": "step_1",
      "type": "userTask",
      "name": "Imperative verb + object (max 40 chars)",
      "role": "Actor or department performing this step",
      "claim_refs": [<integer indices into the claims list that support this step>]
    }
  ],
  "gateways": [
    {
      "id": "gw_1",
      "type": "exclusive",
      "name": "Decision question?",
      "after_step": "step_2",
      "yes_label": "Yes",
      "no_label": "No",
      "yes_to": "step_3",
      "no_to": "step_4",
      "claim_refs": [<integer indices into the claims list that support this gateway>]
    }
  ]
}

BPMN 2.0 RULES — follow these precisely:

TASK TYPES — choose the most accurate for each step:
  "userTask"         — a human performs the activity (default for most manual steps)
  "serviceTask"      — an automated system or IT service performs the activity with no human intervention
  "manualTask"       — physical or offline work performed by a person without a system
  "businessRuleTask" — applying a business rule, policy check, or automated decision engine
  "sendTask"         — sending a message, email, or notification to an external party
  "receiveTask"      — waiting to receive a message, document, or trigger from an external party

TASK NAMING — imperative verb + object (the action performed, not a noun phrase):
  CORRECT: "Review application", "Submit claim form", "Approve payment"
  WRONG:   "Application review", "Claim form submission", "Payment approval"
  Do NOT start the name with the actor/role — the actor is shown in the swimlane header.

GATEWAY TYPES:
  "exclusive"  — exactly one outgoing path (XOR — most decisions)
  "parallel"   — ALL outgoing paths simultaneously (AND)
  "inclusive"  — one or more outgoing paths (OR)

GATEWAY NAMING — must be a question:
  CORRECT: "Application complete?", "Approval granted?", "Risk level acceptable?"
  WRONG:   "Check application", "Decision", "Approval"

GATEWAY CONDITIONS — always use exactly "Yes" and "No" for yes_label/no_label.
  For parallel gateways, omit yes_label and no_label.

GATEWAY ROUTING:
- yes_to is ALWAYS the step immediately after the gateway in sequence — do not set explicitly.
- no_to MUST point to a DIFFERENT step than the one immediately after the gateway. If unclear, omit (No will route to End).
- A gateway with both Yes and No going to the same step is invalid — use a task instead.

CLAIM_REFS RULES — the most important new rule:
- EVERY step and EVERY gateway MUST include claim_refs.
- Each claim_ref is an integer index pointing to a numbered claim in the user message ([0], [1], [2], ...).
- A step or gateway can reference 1+ claims. Pick the claim(s) that most directly support that element.
- If you cannot find any supporting claim for a step/gateway you want to include, OMIT that step/gateway entirely. Do not invent unsupported elements.
- It is acceptable for one claim to be referenced by multiple steps if it genuinely informs each.

ADDITIONAL RULES:
- The number of steps is defined by the detail level instruction below — follow it precisely.
- Step IDs must be unique snake_case strings.
- The "role" field is REQUIRED for every step. If unclear from claims, use "Process Team".
- Group related steps under the same role name so swimlanes are meaningful.
- Include gateways only where there is a clear decision or split.
- If no clear branches exist, return an empty gateways array."""


LEVEL_INSTRUCTIONS = {
    "1": (
        "This is a LEVEL 1 — Process Landscape map. Purpose: executive alignment and scope definition.\n"
        "STEP COUNT: 5–10 major process phases only.\n"
        "CONTENT RULES:\n"
        "  - Show ONLY the major end-to-end stages — what happens, not how.\n"
        "  - Do NOT include sub-tasks, decision gateways, exception paths, or system interactions.\n"
        "  - Return an EMPTY gateways array — no decision points at this level.\n"
        "  - Use a single broad role (e.g. 'Business', 'Operations') or omit swimlane differentiation.\n"
        "  - Suitable for: steering committees, strategy sessions, executive briefings."
    ),
    "2": (
        "This is a LEVEL 2 — End-to-End Cross-Functional Process map. Purpose: understand flow across teams.\n"
        "STEP COUNT: 15–25 activities.\n"
        "CONTENT RULES:\n"
        "  - Introduce full BPMN elements: start/end events, activities, and key decision gateways.\n"
        "  - Show major steps AND handoffs between functions — who does what and when.\n"
        "  - Use distinct swimlane roles for each function or department involved.\n"
        "  - Include key decision points (exclusive gateways) that drive the main flow.\n"
        "  - Do NOT break activities into individual sub-tasks — keep each step at a functional action level."
    ),
    "3": (
        "This is a LEVEL 3 — Detailed Operational Workflow map. Purpose: diagnose inefficiencies and design improvements.\n"
        "STEP COUNT: 30–50 activities.\n"
        "CONTENT RULES:\n"
        "  - Break each Level 2 activity into its granular component tasks.\n"
        "  - Include detailed decision logic, exception paths, rework loops, and system interactions.\n"
        "  - Assign specific roles, departments, or systems to EVERY step.\n"
        "  - Capture real operational complexity — this map should expose bottlenecks and handoff delays."
    ),
    "4": (
        "This is a LEVEL 4 — Work Instruction / System-Level Detail map. Purpose: execution, training, and automation design.\n"
        "STEP COUNT: 50–80 activities (use the most important if the process would exceed 80).\n"
        "CONTENT RULES:\n"
        "  - The lowest level of detail — step-by-step instructions for individuals or systems.\n"
        "  - Each step should describe a single atomic action (open a screen, enter a field, apply a rule).\n"
        "  - Include all business rules, validation checks, and conditional logic.\n"
        "  - Assign precise roles, named systems, or tools to every step."
    ),
}


@dataclass
class GeneratedStructure:
    process_name: str
    steps: list[dict]
    gateways: list[dict]


_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


def generate_structure_from_claims(
    claims: list[dict],
    *,
    level: str = "2",
    process_name: str | None = None,
    focus: str | None = None,
    map_type: str | None = None,
) -> GeneratedStructure:
    """Call Claude to produce a structure dict from numbered claims.

    Each claim in `claims` should be a dict with at least `kind` and `subject`.
    The list order defines the integer indices the model emits in `claim_refs`.
    """
    if not claims:
        return GeneratedStructure(
            process_name=process_name or "Process", steps=[], gateways=[]
        )
    if len(claims) > MAX_CLAIMS_INPUT:
        claims = claims[:MAX_CLAIMS_INPUT]

    level_note = LEVEL_INSTRUCTIONS.get(level, LEVEL_INSTRUCTIONS["2"])
    system_prompt = STRUCTURE_PROMPT + f"\n\nIMPORTANT — Detail level instruction:\n{level_note}"

    focus_note = ""
    if focus:
        focus_note += (
            f'\n\nFocus exclusively on the process named: "{focus}". '
            "Ignore claims about other processes."
        )
    if map_type == "current_state":
        focus_note += (
            "\n\nMAP TYPE — CURRENT STATE: Document the process EXACTLY AS IT EXISTS TODAY. "
            "Show the actual workflow including manual steps, handoffs, delays, and inefficiencies. "
            "Do not optimise — capture reality."
        )
    elif map_type == "future_state":
        focus_note += (
            "\n\nMAP TYPE — FUTURE STATE: Design the process AS IT SHOULD WORK after improvement. "
            "Show the optimised, streamlined workflow with inefficiencies removed."
        )

    numbered = "\n".join(
        f"[{i}] {c.get('kind', '?')}: {c.get('subject', '')}" for i, c in enumerate(claims)
    )
    name_hint = f'\n\nThe process_name field should be: "{process_name}".' if process_name else ""

    user_message = (
        f"Generate the BPMN structure from these numbered claims.{focus_note}{name_hint}\n\n"
        f"Claims:\n{numbered}"
    )

    client = _get_client()
    message = client.messages.create(
        model=GENERATION_MODEL,
        max_tokens=MAX_TOKENS,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
    )

    raw = message.content[0].text.strip()
    raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
    raw = re.sub(r"\n?```$", "", raw).strip()
    raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", raw)
    match = re.search(r"\{[\s\S]*\}", raw)
    if match:
        raw = match.group(0)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Could not parse structure from Claude response: {e}")

    if process_name and not parsed.get("process_name"):
        parsed["process_name"] = process_name

    return GeneratedStructure(
        process_name=parsed.get("process_name", process_name or "Process"),
        steps=parsed.get("steps", []) or [],
        gateways=parsed.get("gateways", []) or [],
    )
