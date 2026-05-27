import os
from dataclasses import dataclass

import anthropic

from app.enums import ClaimKind

EXTRACTION_MODEL = os.getenv("CLAIM_EXTRACTION_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = 4096

CLAIM_TOOL = {
    "name": "record_claims",
    "description": "Record process-relevant claims extracted from a document chunk.",
    "input_schema": {
        "type": "object",
        "properties": {
            "claims": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {
                            "type": "string",
                            "enum": [k.value for k in ClaimKind],
                            "description": "The type of process element this claim describes.",
                        },
                        "subject": {
                            "type": "string",
                            "description": "A single concise sentence stating the claim, e.g. 'AP clerk logs invoice in ERP'.",
                        },
                        "normalized": {
                            "type": "object",
                            "description": "Typed structured fields. For threshold: amount, currency, comparator. For sla: duration, unit. For actor: name, role. Empty if not applicable.",
                        },
                        "confidence": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1,
                        },
                        "quote": {
                            "type": "string",
                            "description": "The exact verbatim sentence(s) from the source text that support this claim.",
                        },
                    },
                    "required": ["kind", "subject", "confidence", "quote"],
                },
            }
        },
        "required": ["claims"],
    },
}


SYSTEM_PROMPT = """You extract process-relevant claims from business documents (interviews, SOPs, policies, manuals, meeting notes).

A "claim" is an atomic statement about how a business process works. Examples by kind:
- actor: who does something ("Accounts Payable Clerk reviews invoices")
- task: what is done ("Match invoice to PO line items")
- decision: where the process branches ("Approver checks if total exceeds $10,000")
- threshold: a numeric or categorical condition ("Invoices over $10,000 require CFO approval")
- sla: a time bound ("Approvals must be completed within 48 hours")
- dependency: a prerequisite ("Cannot pay until 3-way match is complete")
- exception: an off-happy-path case ("If supplier is non-PO, route to manager queue")
- control: a check or audit step ("All invoices over $50K require dual approval")
- system: an IT system involved ("Records entry in Oracle ERP")
- gateway_condition: a decision branch label ("If invoice = duplicate, reject")

Rules:
- Only extract claims that are explicitly stated or strongly implied. Do not invent.
- Each claim must have a verbatim quote from the source supporting it.
- Be specific. "Process invoices" is too vague; "AP clerk validates invoice header in SAP" is good.
- Skip narrative filler, opinions, and aspirational language.
- If the chunk has no process-relevant content, return an empty claims array.

Use the record_claims tool with all extracted claims."""


@dataclass
class ExtractedClaim:
    kind: str
    subject: str
    normalized: dict
    confidence: float
    quote: str


_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        _client = anthropic.Anthropic(api_key=api_key)
    return _client


def extract_claims_from_text(text: str) -> list[ExtractedClaim]:
    if not text.strip():
        return []
    client = _get_client()
    response = client.messages.create(
        model=EXTRACTION_MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        tools=[CLAIM_TOOL],
        tool_choice={"type": "tool", "name": "record_claims"},
        messages=[{"role": "user", "content": text}],
    )

    claims: list[ExtractedClaim] = []
    for block in response.content:
        if block.type != "tool_use" or block.name != "record_claims":
            continue
        for c in block.input.get("claims", []):
            claims.append(
                ExtractedClaim(
                    kind=c["kind"],
                    subject=c["subject"],
                    normalized=c.get("normalized") or {},
                    confidence=float(c.get("confidence", 0.7)),
                    quote=c["quote"],
                )
            )
    return claims
