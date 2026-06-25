# Per-Process Claim Suggest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-process "Suggest claims" action that asks Claude which project claims belong to a process you created, then lets you curate the matches in a deselect-preview dialog and link the chosen ones — filling the gap where a hand-created process could only be populated manually.

**Architecture:** Approach A (ephemeral). A new **read-only** endpoint `POST /processes/{id}/suggest-claims` runs one forced-tool Anthropic call (mirroring `map_reconcile`/`map_ai_edit`) over all project claims not already linked to the process, resolves the model's short refs to real claim ids, and returns ranked candidates — **persisting nothing**. The frontend shows a preview dialog (candidates pre-checked); "Add N claims" applies the selected subset through the **existing** `assignClaims` bulk endpoint. No migration, no new persistence.

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic v2 (backend, `anthropic`), Next.js 16 + React 19 + TypeScript (frontend), pytest (real `poet_test` Postgres) + Vitest.

**Design doc:** `docs/superpowers/specs/2026-06-12-per-process-claim-suggest-design.md`

---

## File structure

**Backend — create:**
- `backend/app/services/claim_matcher.py` — pure prompt-block renderers + the forced-tool `propose_claim_matches` + lazy `_get_client`.
- `backend/tests/test_claim_matcher.py` — renderer tests + faked-client service tests + schema test + endpoint tests.

**Backend — modify:**
- `backend/app/schemas/process.py` — add `ClaimMatchCandidate` + `SuggestClaimsResult`.
- `backend/app/api/v2/processes.py` — add the `suggest_claims_for_process` endpoint + a `_claim_match_client` wrapper + imports.

**Frontend — create:**
- `src/components/inventory/suggest-claims-dialog.tsx` — the deselect-preview dialog (reuses `triage-selection`).

**Frontend — modify:**
- `src/lib/types.ts` — `ClaimMatchCandidate` + `SuggestClaimsResult`.
- `src/lib/api.ts` — `suggestClaimsForProcess`.
- `src/components/inventory/process-list.tsx` — per-row "Suggest claims" button + dialog wiring.

---

## Conventions (read once)

- **Commit locally only. Never push. Never switch branches** (stay on `sp6-source-viewer`). End every commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Never use `rm`/`git rm`.**
- **Stage ONLY the files each task names.** NEVER `git add -A`/`git add .` — the working tree has unrelated modified files (`package.json`, `package-lock.json`, `src/app/layout.tsx`) and untracked dirs (`.agents/`, `.codex/`, `.cursor/`, `.gemini/`, `.vscode/`, `.zed/`, `config/`, `.mcp.json`, `opencode.json`, `skills-lock.json`) that MUST NOT be committed.
- **Backend tests** use the dockerized Postgres on `localhost:5433`, DB `poet_test`. Run from `backend/` with the venv: `cd backend && .venv/bin/pytest <args>`. The `db` fixture TRUNCATEs all tables before each test; commits are real.
- **Frontend:** type-check `npx tsc --noEmit` (repo root); tests `npm test` (Vitest, `environment: "node"`, `include: ["src/**/*.test.ts"]` — pure-logic `.test.ts` only; no DOM/component tests in this repo).
- **No new migration.** This feature reads existing tables and writes only via the existing `assignClaims` bulk endpoint.
- The forced-tool pattern to mirror lives in `backend/app/services/map_reconcile.py` (module-level model env var, lazy `_get_client()` raising `RuntimeError` without a key, `client.messages.create(... tools=[tool], tool_choice={"type":"tool","name":...}, timeout=60.0)`, iterate `response.content` for the `tool_use` block, and the `isinstance(list)` degrade guard).
- Verified facts: `Claim` has `kind: str` and `subject: str` columns; `ProcessClaimLink` has `process_id`/`claim_id`; `_get_process_in_project(db, project_id, process_id) -> Process` exists in `processes.py` and raises **404** if the process is missing or not in the project; `api.assignClaims(projectId, processId, claimIds)` POSTs to `/processes/{id}/claims` and returns `{ process_id, linked, already_linked }`; `triage-selection.ts` exports `toggleSelection`, `selectAll`, `clearSelection`, `isSelected`.

---

## Task 1: Pure prompt-block renderers

Two pure functions that turn a process definition and a candidate list into compact prompt text. No LLM, fully unit-testable.

**Files:**
- Create: `backend/app/services/claim_matcher.py`
- Create: `backend/tests/test_claim_matcher.py`

- [ ] **Step 1: Write the failing test** — create `backend/tests/test_claim_matcher.py`:

```python
"""Tests for the per-process claim matcher: pure renderers, forced-tool service,
schemas, and the suggest-claims endpoint."""
from uuid import uuid4

import pytest

from app.services.claim_matcher import render_candidates_block, render_process_block


def test_render_process_block_with_exemplars():
    block = render_process_block(
        "Order to Cash",
        "Quote through payment.",
        [("task", "Receive purchase order"), ("decision", "Run credit check")],
    )
    assert "Order to Cash" in block
    assert "Quote through payment." in block
    assert "Receive purchase order" in block
    assert "Run credit check" in block


def test_render_process_block_empty_process():
    block = render_process_block("Brand New", "", [])
    assert "Brand New" in block
    assert "no claims yet" in block.lower()


def test_render_candidates_block_flags_elsewhere():
    block = render_candidates_block(
        [
            ("C1", "task", "Ship the goods", False),
            ("C2", "task", "Issue the invoice", True),
        ]
    )
    assert "C1" in block and "Ship the goods" in block
    assert "C2" in block and "Issue the invoice" in block
    assert "another process" in block.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_claim_matcher.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.claim_matcher'`.

- [ ] **Step 3: Write the renderers** — create `backend/app/services/claim_matcher.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_claim_matcher.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/claim_matcher.py backend/tests/test_claim_matcher.py
git commit -m "$(printf 'feat(claim-suggest): pure prompt-block renderers\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Forced-tool `propose_claim_matches` + `_get_client`

One synchronous Anthropic call with a single forced tool returning a `matches` array. Mirrors `map_reconcile.propose_reconcile`.

**Files:**
- Modify: `backend/app/services/claim_matcher.py`
- Test: `backend/tests/test_claim_matcher.py` (extend)

- [ ] **Step 1: Append the failing tests** to `backend/tests/test_claim_matcher.py`:

```python
from types import SimpleNamespace

from app.services import claim_matcher


class _FakeBlock:
    def __init__(self, name, payload):
        self.type = "tool_use"
        self.name = name
        self.input = payload


class _FakeClient:
    def __init__(self, name, payload):
        self._block = _FakeBlock(name, payload)

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        return SimpleNamespace(content=[self._block])


def test_propose_claim_matches_parses():
    fake = _FakeClient(
        "match_claims",
        {"matches": [{"claim_ref": "C1", "confidence": 0.9, "rationale": "fits"}]},
    )
    out = claim_matcher.propose_claim_matches(
        client=fake, model="m", process_block="p", candidates_block="c"
    )
    assert out["matches"][0]["claim_ref"] == "C1"


def test_propose_claim_matches_degrades_on_wrong_tool():
    fake = _FakeClient("not_the_tool", {"junk": True})
    out = claim_matcher.propose_claim_matches(
        client=fake, model="m", process_block="p", candidates_block="c"
    )
    assert out == {"matches": []}


def test_propose_claim_matches_degrades_on_non_list():
    fake = _FakeClient("match_claims", {"matches": None})
    out = claim_matcher.propose_claim_matches(
        client=fake, model="m", process_block="p", candidates_block="c"
    )
    assert out == {"matches": []}


def test_get_client_raises_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    claim_matcher._client = None
    with pytest.raises(RuntimeError):
        claim_matcher._get_client()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_claim_matcher.py -v`
Expected: FAIL — `AttributeError: module 'app.services.claim_matcher' has no attribute 'propose_claim_matches'`.

- [ ] **Step 3: Add the imports, tool, client, and service** — at the TOP of `backend/app/services/claim_matcher.py` add the import block (above the renderers):

```python
import os

import anthropic
```

Then append to the bottom of the file:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_claim_matcher.py -v`
Expected: PASS (3 renderer + 4 service tests = 7).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/claim_matcher.py backend/tests/test_claim_matcher.py
git commit -m "$(printf 'feat(claim-suggest): match_claims forced-tool service\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Result schemas

**Files:**
- Modify: `backend/app/schemas/process.py`
- Test: `backend/tests/test_claim_matcher.py` (extend)

- [ ] **Step 1: Append the failing test** to `backend/tests/test_claim_matcher.py`:

```python
from app.schemas.process import ClaimMatchCandidate, SuggestClaimsResult


def test_suggest_claims_result_shape():
    r = SuggestClaimsResult(
        candidates=[ClaimMatchCandidate(claim_id=uuid4(), subject="s", kind="task")]
    )
    assert r.candidates[0].in_other_processes is False
    assert r.candidates[0].rationale == ""
    assert r.candidates[0].confidence is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_claim_matcher.py::test_suggest_claims_result_shape -v`
Expected: FAIL — `ImportError: cannot import name 'ClaimMatchCandidate'`.

- [ ] **Step 3: Add the schemas** — in `backend/app/schemas/process.py`, add near the other suggestion schemas (the file already imports `BaseModel`, `Field`, and `UUID`; if it does not import `Field`, add it to the existing `from pydantic import ...` line):

```python
class ClaimMatchCandidate(BaseModel):
    claim_id: UUID
    subject: str
    kind: str
    confidence: float | None = None
    rationale: str = ""
    in_other_processes: bool = False


class SuggestClaimsResult(BaseModel):
    candidates: list[ClaimMatchCandidate] = Field(default_factory=list)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_claim_matcher.py -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/process.py backend/tests/test_claim_matcher.py
git commit -m "$(printf 'feat(claim-suggest): ClaimMatchCandidate + SuggestClaimsResult schemas\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: The `suggest-claims` endpoint

Read-only endpoint: loads candidates (project claims not already linked to this process), the "linked elsewhere" set, and exemplars (claims already linked here); builds the prompt blocks; calls `propose_claim_matches`; resolves refs (dropping fabrications); returns ranked candidates. Empty candidate pool → no LLM call. LLM failure → 503. Nothing persisted.

**Files:**
- Modify: `backend/app/api/v2/processes.py`
- Test: `backend/tests/test_claim_matcher.py` (extend)

- [ ] **Step 1: Append the failing tests** to `backend/tests/test_claim_matcher.py`:

```python
import re
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import select as _select

from app.api.v2 import processes as proc_api
from app.enums import AssignedBy
from app.models.claim import Claim
from app.models.identity import Organization, User
from app.models.process_inventory import Process, ProcessClaimLink
from app.models.project import Project


def _seed(db):
    """Project with two processes (A = target, B = sibling) and four claims:
    - c_here:      linked to A (an exemplar; must NOT be a candidate)
    - c_match:     unlinked anywhere (a candidate; not in another process)
    - c_elsewhere: linked to B only (a candidate; in another process)
    - c_nomatch:   unlinked anywhere (a candidate)
    """
    org = Organization(name="O"); db.add(org); db.flush()
    user = User(org_id=org.id, email=f"u-{uuid4()}@x.io", name="U"); db.add(user); db.flush()
    project = Project(org_id=org.id, name="P", created_by=user.id); db.add(project); db.flush()
    proc_a = Process(project_id=project.id, name="Order to Cash"); db.add(proc_a)
    proc_b = Process(project_id=project.id, name="Procure to Pay"); db.add(proc_b)
    db.flush()
    c_here = Claim(project_id=project.id, kind="task", subject="Receive PO", normalized={})
    c_match = Claim(project_id=project.id, kind="task", subject="Ship the goods", normalized={})
    c_elsewhere = Claim(project_id=project.id, kind="task", subject="Pay supplier", normalized={})
    c_nomatch = Claim(project_id=project.id, kind="task", subject="Unrelated note", normalized={})
    db.add_all([c_here, c_match, c_elsewhere, c_nomatch]); db.flush()
    db.add(ProcessClaimLink(process_id=proc_a.id, claim_id=c_here.id))
    db.add(ProcessClaimLink(process_id=proc_b.id, claim_id=c_elsewhere.id))
    db.commit()
    return project, proc_a, proc_b, c_here, c_match, c_elsewhere, c_nomatch


def _match_all(*, client, model, process_block, candidates_block):
    """Fake matcher: cite every ref present in the candidates block."""
    refs = re.findall(r"\bC\d+\b", candidates_block)
    return {"matches": [{"claim_ref": r, "confidence": 0.8, "rationale": "fit"} for r in refs]}


def test_suggest_excludes_linked_here_and_flags_elsewhere(db):
    project, proc_a, _b, c_here, c_match, c_elsewhere, c_nomatch = _seed(db)
    with patch.object(proc_api, "propose_claim_matches", _match_all), \
         patch.object(proc_api, "_claim_match_client", return_value=object()):
        resp = proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=project, db=db
        )
    ids = {c.claim_id for c in resp.candidates}
    assert c_here.id not in ids                      # already linked to A -> not a candidate
    assert ids == {c_match.id, c_elsewhere.id, c_nomatch.id}
    by_id = {c.claim_id: c for c in resp.candidates}
    assert by_id[c_elsewhere.id].in_other_processes is True
    assert by_id[c_match.id].in_other_processes is False


def test_suggest_drops_fabricated_ref(db):
    project, proc_a, *_ = _seed(db)

    def _one_real_one_fake(*, client, model, process_block, candidates_block):
        refs = re.findall(r"\bC\d+\b", candidates_block)
        return {"matches": [
            {"claim_ref": refs[0], "confidence": 0.7, "rationale": "ok"},
            {"claim_ref": "C999", "confidence": 0.9, "rationale": "fabricated"},
        ]}

    with patch.object(proc_api, "propose_claim_matches", _one_real_one_fake), \
         patch.object(proc_api, "_claim_match_client", return_value=object()):
        resp = proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=project, db=db
        )
    assert len(resp.candidates) == 1  # the fabricated C999 was dropped


def test_suggest_empty_pool_makes_no_llm_call(db):
    project, proc_a, _b, c_here, c_match, c_elsewhere, c_nomatch = _seed(db)
    # Link every remaining candidate to A so the candidate pool is empty.
    for c in (c_match, c_elsewhere, c_nomatch):
        db.add(ProcessClaimLink(process_id=proc_a.id, claim_id=c.id))
    db.commit()
    with patch.object(proc_api, "propose_claim_matches", side_effect=AssertionError("LLM called")):
        resp = proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=project, db=db
        )
    assert resp.candidates == []


def test_suggest_503_on_llm_failure(db):
    project, proc_a, *_ = _seed(db)
    with patch.object(proc_api, "_claim_match_client", return_value=object()), \
         patch.object(proc_api, "propose_claim_matches", side_effect=RuntimeError("boom")):
        with pytest.raises(HTTPException) as exc:
            proc_api.suggest_claims_for_process(
                process_id=proc_a.id, project=project, db=db
            )
    assert exc.value.status_code == 503


def test_suggest_404_for_foreign_process(db):
    project, proc_a, *_ = _seed(db)
    other = Project(org_id=project.org_id, name="P2", created_by=project.created_by)
    db.add(other); db.commit()
    with pytest.raises(HTTPException) as exc:
        proc_api.suggest_claims_for_process(
            process_id=proc_a.id, project=other, db=db
        )
    assert exc.value.status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_claim_matcher.py -k suggest -v`
Expected: FAIL — `AttributeError: module 'app.api.v2.processes' has no attribute 'suggest_claims_for_process'`.

- [ ] **Step 3: Add imports + the endpoint** — in `backend/app/api/v2/processes.py`:

Add to the schema import block (`from app.schemas.process import (...)`): `ClaimMatchCandidate,` and `SuggestClaimsResult,`.

Add service imports near the other `from app.services...` imports:

```python
from app.services import claim_matcher as _claim_matcher_mod
from app.services.claim_matcher import (
    propose_claim_matches,
    render_candidates_block,
    render_process_block,
)
```

If the module has no logger yet, add near the top (after the imports): `import logging` and `logger = logging.getLogger(__name__)`.

Add the client wrapper near the other module-level helpers (e.g. just above `apply_suggestion`):

```python
def _claim_match_client():
    """Thin wrapper so the endpoint resolves the Anthropic client lazily and
    tests can patch it without a real key."""
    return _claim_matcher_mod._get_client()
```

Add the endpoint (place it next to `suggest_processes`):

```python
@router.post("/processes/{process_id}/suggest-claims", response_model=SuggestClaimsResult)
def suggest_claims_for_process(
    process_id: UUID,
    project: Annotated[Project, Depends(get_project_or_404)],
    db: Annotated[Session, Depends(get_db)],
) -> SuggestClaimsResult:
    """Ask Claude which project claims belong to this process. Considers all
    project claims NOT already linked here; flags candidates linked to another
    process. Read-only — persists nothing; the chosen claims are applied via the
    bulk-assign endpoint. Empty candidate pool -> no LLM call. LLM failure -> 503."""
    proc = _get_process_in_project(db, project.id, process_id)

    linked_here = (
        select(ProcessClaimLink.claim_id)
        .where(ProcessClaimLink.process_id == proc.id)
        .scalar_subquery()
    )
    candidates = list(
        db.scalars(
            select(Claim)
            .where(Claim.project_id == project.id, Claim.id.not_in(linked_here))
            .order_by(Claim.kind, Claim.created_at)
        ).all()
    )
    MAX_CANDIDATES = 200
    if len(candidates) > MAX_CANDIDATES:
        logger.info(
            "suggest-claims: capping %d candidates to %d for process %s",
            len(candidates), MAX_CANDIDATES, proc.id,
        )
        candidates = candidates[:MAX_CANDIDATES]

    if not candidates:
        return SuggestClaimsResult(candidates=[])

    candidate_ids = [c.id for c in candidates]
    elsewhere = set(
        db.scalars(
            select(ProcessClaimLink.claim_id).where(
                ProcessClaimLink.claim_id.in_(candidate_ids),
                ProcessClaimLink.process_id != proc.id,
            )
        ).all()
    )
    exemplars = [
        (c.kind, c.subject)
        for c in db.scalars(
            select(Claim)
            .join(ProcessClaimLink, ProcessClaimLink.claim_id == Claim.id)
            .where(ProcessClaimLink.process_id == proc.id)
            .limit(30)
        ).all()
    ]

    ref_by_id = {c.id: f"C{i + 1}" for i, c in enumerate(candidates)}
    id_by_ref = {ref: cid for cid, ref in ref_by_id.items()}
    claim_by_id = {c.id: c for c in candidates}

    process_block = render_process_block(proc.name, proc.description or "", exemplars)
    candidates_block = render_candidates_block(
        [(ref_by_id[c.id], c.kind, c.subject, c.id in elsewhere) for c in candidates]
    )

    try:
        client = _claim_match_client()  # raises RuntimeError if no key
        raw = propose_claim_matches(
            client=client,
            model=_claim_matcher_mod.CLAIM_MATCH_MODEL,
            process_block=process_block,
            candidates_block=candidates_block,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    out: list[ClaimMatchCandidate] = []
    seen: set = set()
    for m in raw.get("matches", []):
        cid = id_by_ref.get(str(m.get("claim_ref", "")).strip().upper())
        if cid is None or cid in seen:
            continue
        seen.add(cid)
        claim = claim_by_id[cid]
        out.append(
            ClaimMatchCandidate(
                claim_id=cid,
                subject=claim.subject,
                kind=claim.kind,
                confidence=m.get("confidence"),
                rationale=m.get("rationale", "") or "",
                in_other_processes=cid in elsewhere,
            )
        )
    out.sort(key=lambda c: (c.confidence is None, -(c.confidence or 0.0)))
    return SuggestClaimsResult(candidates=out)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_claim_matcher.py -v`
Expected: PASS (8 prior + 5 endpoint tests = 13).

- [ ] **Step 5: Confirm module imports + full suite**

Run: `cd backend && .venv/bin/python -c "import app.api.v2.processes; import app.api.v2"`
Expected: no error.
Run: `cd backend && .venv/bin/pytest -q`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v2/processes.py backend/tests/test_claim_matcher.py
git commit -m "$(printf 'feat(claim-suggest): suggest-claims endpoint (candidate exclusion, ref hygiene, 503)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Frontend types + API client

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add types** — in `src/lib/types.ts`, add near the other process types:

```typescript
export interface ClaimMatchCandidate {
  claim_id: UUID;
  subject: string;
  kind: string;
  confidence: number | null;
  rationale: string;
  in_other_processes: boolean;
}

export interface SuggestClaimsResult {
  candidates: ClaimMatchCandidate[];
}
```

- [ ] **Step 2: Add the API client function** — in `src/lib/api.ts`, add to the `api` object near `assignClaims` (around line 415):

```typescript
  suggestClaimsForProcess: (projectId: UUID, processId: UUID) =>
    request<SuggestClaimsResult>(
      `/api/v2/projects/${projectId}/processes/${processId}/suggest-claims`,
      { method: "POST", json: {} }
    ),
```

Add `SuggestClaimsResult` to the `import type { ... } from "@/lib/types"` block at the top of `api.ts`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "$(printf 'feat(claim-suggest): frontend types + suggestClaimsForProcess client fn\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: Deselect-preview dialog + process-row button

**Files:**
- Create: `src/components/inventory/suggest-claims-dialog.tsx`
- Modify: `src/components/inventory/process-list.tsx`

- [ ] **Step 1: Create the dialog** — `src/components/inventory/suggest-claims-dialog.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { isSelected, selectAll, toggleSelection } from "./triage-selection";
import type { ClaimMatchCandidate, UUID } from "@/lib/types";

/** Deselect-preview of AI-suggested claims for one process. Pre-checks every
 * candidate; "Add" links the ticked subset via the existing bulk-assign call. */
export function SuggestClaimsDialog({
  projectId,
  processId,
  processName,
  candidates,
  open,
  onOpenChange,
}: {
  projectId: UUID;
  processId: UUID;
  processName: string;
  candidates: ClaimMatchCandidate[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  // Pre-check all candidates whenever a fresh set arrives.
  useEffect(() => {
    setChosen(selectAll(candidates.map((c) => c.claim_id)));
  }, [candidates]);

  const add = useMutation({
    mutationFn: () =>
      api.assignClaims(projectId, processId, Array.from(chosen) as UUID[]),
    onSuccess: (res) => {
      toast.success(`Added ${res.linked} claim(s) to "${processName}".`);
      qc.invalidateQueries({ queryKey: ["processes", projectId] });
      qc.invalidateQueries({ queryKey: ["unassigned", projectId] });
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(`Add failed: ${e.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Suggested claims for &ldquo;{processName}&rdquo;</DialogTitle>
          <DialogDescription>
            Untick any that don&apos;t belong, then add the rest. Selected claims
            are linked to this process.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-2 overflow-auto">
          {candidates.map((c) => (
            <li key={c.claim_id} className="rounded border p-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={isSelected(chosen, c.claim_id)}
                  onChange={() => setChosen((prev) => toggleSelection(prev, c.claim_id))}
                />
                <span className="flex-1">
                  <span className="flex items-center gap-2">
                    <Badge variant="outline">{c.kind}</Badge>
                    {c.confidence != null && (
                      <span className="text-xs text-muted-foreground">
                        {(c.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                    {c.in_other_processes && (
                      <span className="text-xs text-amber-600">also in another process</span>
                    )}
                  </span>
                  <span className="mt-0.5 block font-medium">{c.subject}</span>
                  {c.rationale && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {c.rationale}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} disabled={chosen.size === 0 || add.isPending}>
            {add.isPending ? "Adding…" : `Add ${chosen.size} claim${chosen.size === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Wire the button into `ProcessList`** — in `src/components/inventory/process-list.tsx`:

Add imports:

```tsx
import { SuggestClaimsDialog } from "./suggest-claims-dialog";
```

Add `ClaimMatchCandidate` to the existing `import type { Process, UUID } from "@/lib/types"` line (→ `import type { ClaimMatchCandidate, Process, UUID } from "@/lib/types";`).

Inside the `ProcessList` component, add state + the suggest mutation (near the other `useMutation` hooks):

```tsx
  const [matchFor, setMatchFor] = useState<{
    process: Process;
    candidates: ClaimMatchCandidate[];
  } | null>(null);

  const suggest = useMutation({
    mutationFn: (p: Process) => api.suggestClaimsForProcess(projectId, p.id),
    onSuccess: (data, p) => {
      if (data.candidates.length === 0) {
        toast(`No unlinked claims matched "${p.name}".`);
      } else {
        setMatchFor({ process: p, candidates: data.candidates });
      }
    },
    onError: (e: Error) => toast.error(`Suggest failed: ${e.message}`),
  });
```

In each active process row's button group (the `<div className="flex gap-1">` that holds Rename/Archive), add a "Suggest claims" button as the FIRST button:

```tsx
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => suggest.mutate(p)}
                    disabled={suggest.isPending && suggest.variables?.id === p.id}
                  >
                    {suggest.isPending && suggest.variables?.id === p.id
                      ? "Matching…"
                      : "Suggest claims"}
                  </Button>
```

After the `<ul>` of processes (still inside the component's returned root element), render the dialog once:

```tsx
      {matchFor && (
        <SuggestClaimsDialog
          projectId={projectId}
          processId={matchFor.process.id}
          processName={matchFor.process.name}
          candidates={matchFor.candidates}
          open={matchFor !== null}
          onOpenChange={(o) => {
            if (!o) setMatchFor(null);
          }}
        />
      )}
```

(`useState`, `useMutation`, `toast`, `api`, and `Button` are already imported in `process-list.tsx`.)

- [ ] **Step 3: Type-check + tests**

Run: `npx tsc --noEmit`
Expected: clean.
Run: `npm test`
Expected: PASS (existing Vitest suite still green — `triage-selection.test.ts` already covers the Set helpers this dialog reuses).

- [ ] **Step 4: Commit**

```bash
git add src/components/inventory/suggest-claims-dialog.tsx src/components/inventory/process-list.tsx
git commit -m "$(printf 'feat(claim-suggest): per-process Suggest-claims button + deselect dialog\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: Full verification + execution outcome

**Files:**
- Modify: `docs/superpowers/plans/2026-06-12-per-process-claim-suggest.md` (append an "Execution outcome" section)

- [ ] **Step 1: Backend gate**

Run: `cd backend && .venv/bin/pytest -q`
Expected: PASS (all tests incl. `test_claim_matcher.py`).

- [ ] **Step 2: Frontend gates**

Run: `npx tsc --noEmit` → clean.
Run: `npm test` → PASS.

- [ ] **Step 3: Live smoke (best-effort — requires a real key + dev DB at head)**

If `backend/.env` has a real `ANTHROPIC_API_KEY` and the stack is up (`./run-local.sh status`): on a project with extracted claims, create a process (e.g. "Order to Cash"), click **Suggest claims** on its row → a dialog of candidate claims appears (pre-checked, with kind/confidence/why and an "also in another process" hint where relevant). Untick one, click **Add N claims** → toast confirms; the process's claim count rises and the added claims leave the triage panel's unassigned list. Re-running Suggest claims no longer offers the just-added claims (they're now linked here). If the key is blank, record that the endpoint returns 503 by design and live smoke is deferred — candidate selection, ref hygiene, and the empty-pool short-circuit are covered by automated tests.

- [ ] **Step 4: Record the outcome + commit**

Append an "## Execution outcome" section documenting gate results (pytest/tsc/vitest counts), live-smoke result or deferral, and any deviations from this plan. Commit:

```bash
git add docs/superpowers/plans/2026-06-12-per-process-claim-suggest.md
git commit -m "$(printf 'docs(claim-suggest): record execution outcome\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Verification

- **pytest** (`cd backend && .venv/bin/pytest -q`): all green, including `test_claim_matcher.py` —
  renderers (process block with/without exemplars; candidate block flags elsewhere); `propose_claim_matches` faked-client parse + degrade-on-wrong-tool + degrade-on-non-list + no-key RuntimeError; schema shape; endpoint (excludes already-linked + flags elsewhere, drops fabricated ref, empty-pool-no-LLM, 503-on-failure, 404-foreign-process).
- **tsc** (`npx tsc --noEmit`): clean.
- **Vitest** (`npm test`): green (reuses `triage-selection.test.ts`; no new pure logic to test).
- **Manual smoke:** create a process → Suggest claims → curate in the dialog → Add → claims link and leave the unassigned list.

---

## Self-review notes (resolved during planning)

- **Reuse over rebuild.** The endpoint reuses `_get_process_in_project` and the forced-tool pattern; the apply path reuses `assignClaims` (`_link_claims` is idempotent, so re-adding is safe); the dialog reuses the `triage-selection` Set helpers and mirrors `bulk-assign-popover`. Net new: one service, one endpoint, two schemas, one client method, one dialog, one button.
- **Ephemeral by design.** Nothing is persisted; matches don't survive a reload (re-run to refresh). This is the chosen Approach A trade-off, not an oversight.
- **Candidate scope.** All project claims except those already linked to this process; claims linked to *other* processes are valid candidates (M2M) but flagged `in_other_processes` so the user accepts knowingly.
- **Prompt size.** Candidate block carries `kind` + `subject` only; soft cap of 200 candidates (logged when exceeded — never silently truncated) and 30 exemplars.
- **Ref hygiene.** The model cites `C#` refs; the endpoint resolves them against the candidate set and drops any it invents (proven by the `C999` test), mirroring `map_reconcile`.
- **Failure modes.** Empty candidate pool → no LLM call, empty result. Missing key / LLM error → 503, nothing changed.

---

## Execution outcome (2026-06-12)

Executed via subagent-driven development (fresh implementer per task + reviews, controller adjudication) on branch `sp6-source-viewer`, committed locally, **not pushed**. 6 feature commits `de01267..1548771`, plus this outcome commit.

### Gates (all green)
- **Backend** `cd backend && .venv/bin/pytest -q`: **157 passed** (incl. `test_claim_matcher.py` — renderers; `propose_claim_matches` parse/degrade-on-wrong-tool/degrade-on-non-list/no-key; schema shape; endpoint excludes-already-linked + flags-elsewhere, drops-fabricated-ref, dedups-repeated-ref, tolerates-non-numeric-confidence, empty-pool-no-LLM, 503, 404).
- **tsc** `npx tsc --noEmit`: clean. **Vitest** `npm test`: **67 passed / 11 files** (reuses `triage-selection.test.ts`; no new pure logic to test).
- The final holistic review verdict was **READY TO INTEGRATE** — every backend↔frontend seam (field contract, endpoint path, `assignClaims` return shape, invalidation keys) lines up; no orphaned code; no SP commit included the unrelated working-tree files.

### Commit map
`de01267` renderers · `d95b45a` match_claims forced-tool · `85ad241` schemas · `26a8f8f` suggest-claims endpoint · `602b684` FE types+client · `1548771` Suggest-claims button + deselect dialog.

### Deviations from the plan (controller-adjudicated)
- **Non-numeric confidence guard (added during review).** The plan built `ClaimMatchCandidate(confidence=m.get("confidence"))` outside the 503 try/except; a model returning a non-numeric confidence (untrusted output) would raise a Pydantic `ValidationError` → unhandled 500. Hardened to `conf if isinstance(conf, (int, float)) else None` (matching the sibling reconcile endpoint's refusal to trust model confidence), with `test_suggest_tolerates_non_numeric_confidence` + `test_suggest_dedups_repeated_ref` added.
- **`_claim_match_client` wrapper placed next to its only caller** (just above `list_suggestions`) rather than above `apply_suggestion` — module-level def, patchable, reads better.
- **Unused test imports omitted** (`_select`, `AssignedBy` from the plan's draft snippet) to avoid lint noise; `logger` added to `processes.py` (none existed).

### Follow-ups (non-blocking)
- **503 vs 500 on `anthropic.APIError`.** The endpoint's `except (RuntimeError, ValueError)` does not catch `anthropic.APIError` (network/429/529), which would surface as 500, not the documented 503. This is the established convention across the AI-endpoint family (the SP-7c reconcile endpoint and `embeddings.py` catch identically); harden all of them together in a separate change rather than diverging one endpoint.
- **200-candidate cap orders by `(kind, created_at)`**, so on projects with >200 unlinked claims the truncation is biased toward earlier kinds (logged, never silent). Revisit ordering only if it bites in practice.
- Live smoke deferred per the plan's Step 3 unless run on the Windows dev stack with a real key (the stack is currently up via `./run-local.sh`, and `backend/.env` has a key, so this is now exercisable in the browser: create a process → **Suggest claims** → curate → **Add**).
