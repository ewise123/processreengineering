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
