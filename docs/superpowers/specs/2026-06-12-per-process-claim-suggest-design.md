# Per-Process Claim Suggest — Design

**Date:** 2026-06-12
**Branch:** `sp6-source-viewer` (local; not pushed)
**Status:** Approved design, ready for an implementation plan.

## Problem

On the Processes tab a user can create their own process (e.g. "Order to Cash"), but it
starts empty. The only AI feature, **"Suggest processes"**, runs the opposite direction:
it clusters claims and proposes brand-new processes (`create_process` suggestions,
`process_id=None`); it never looks at a process you already named and finds the claims that
belong to it. Populating a hand-created process is therefore manual-only (Claim triage
panel → bulk assign). This design fills that gap: **"given this process, AI-suggest which
claims belong to it."**

The dispatcher already has an `assign_claims` op against an existing `process_id`, and the
bulk-assign endpoint `POST /processes/{id}/claims` (`api.assignClaims`) already links claims
to a process. The missing piece is a **matcher** that, given a process, picks candidate
claims for review.

## Decisions (locked during brainstorming)

- **Candidate pool:** *all* project claims (claims↔processes is many-to-many, so a claim may
  legitimately belong to several processes). The matcher **excludes** claims already linked
  to *this* process, and **flags** candidates that are linked to *another* process so the
  user accepts with full information.
- **Matching signal (the process "definition"):** process **name + description + the claims
  already linked to it** (as exemplars the model infers the pattern from). Falls back to
  name + description when the process is empty.
- **Trigger & review UI:** a **"Suggest claims" button on each process row**; results open a
  **preview dialog** (bundled-with-deselect): candidates pre-checked, user unticks the bad
  ones, then "Add N claims" applies the selected subset.
- **Architecture: Approach A — ephemeral matcher → curate → bulk-assign.** The suggest
  endpoint is **read-only** (persists nothing); the selected claims are applied through the
  existing `assignClaims` bulk endpoint. Chosen over Approach B (persist as durable
  `assign_claims` suggestions in the inbox) because deselect-before-apply is native to an
  ephemeral flow, it needs no migration and no "partially accept a persisted suggestion"
  concept, and it reuses the bulk-assign endpoint verbatim. The trade-off — matches are not
  durable across a page reload — is acceptable for a quick match→curate→add action.

## Architecture & data flow

1. User clicks **"Suggest claims"** on a process row in `ProcessList`.
2. `POST /api/v2/projects/{id}/processes/{process_id}/suggest-claims` →
   - builds the process **definition block** (name, description, up to ~30 already-linked
     claims as exemplars),
   - builds the **candidate block** (every project claim *not* already linked to this
     process, each with a short ref `C1`…`Cn`, its `kind` + `subject`, and an
     `also-linked-elsewhere` marker),
   - runs **one forced-tool Anthropic call**, resolves the model's `C#` refs back to real
     claim ids (dropping any it invented), and returns a **ranked candidate list**.
   - **Nothing is persisted.**
3. UI opens a **preview dialog**: candidates pre-checked, sorted by confidence; each row
   shows the claim subject, a kind badge, confidence %, the model's one-line rationale, and
   a muted "also in another process" hint where relevant.
4. User unticks unwanted candidates → **"Add N claims"** → `api.assignClaims(projectId,
   processId, selectedIds)` (`assigned_by="user"`) → invalidate `["processes"]`,
   `["unassigned"]`, `["maps"]` query keys → success toast → close dialog.
5. The process row's claim count updates; any newly-linked claims that were unassigned drop
   out of the triage panel's unassigned list.

## Backend components

### `backend/app/services/claim_matcher.py` (new)
Mirrors the `map_reconcile` / `map_ai_edit` forced-tool shape:
- module-level `CLAIM_MATCH_MODEL = os.getenv("CLAIM_MATCH_MODEL", "claude-sonnet-4-6")`;
- lazy `_get_client()` raising `RuntimeError` when `ANTHROPIC_API_KEY` is unset;
- a **pure** prompt/block builder (deterministic from process + candidates — unit-testable
  with no LLM);
- `propose_claim_matches(*, client, model, process_block, candidates_block) -> dict`
  returning `{"matches": [{"claim_ref": str, "confidence": float, "rationale": str}]}`;
  degrades to `{"matches": []}` on a malformed / wrong-tool response (same hardening as
  `propose_reconcile`).

Forced tool `match_claims` input schema: a single `matches` array; each item
`{claim_ref (string), confidence (number), rationale (string)}`, required `["claim_ref"]`.
The tool description instructs the model to use only refs that appear in the candidate
block and to judge fit against the process definition + exemplars.

### Endpoint in `backend/app/api/v2/processes.py`
`POST /processes/{process_id}/suggest-claims` → `SuggestClaimsResult`:
- `get_project_or_404` + the existing `_get_process_in_project` (404 if the process isn't in
  this project);
- **candidate query**: project claims whose id is `NOT IN` this process's
  `process_claim_links`;
- **elsewhere set**: claim ids present in `process_claim_links` for *other* processes in the
  project (drives the `in_other_processes` flag);
- **exemplar query**: claims already linked to this process (subject + kind), capped at ~30
  for the prompt;
- **empty candidate pool → return `{candidates: []}` with NO LLM call** (mirrors the
  reconcile empty short-circuit);
- otherwise build the blocks, call `propose_claim_matches`; **`RuntimeError`/`ValueError`
  → HTTP 503** (nothing persisted);
- resolve match `claim_ref`s → real claim ids (drop fabrications, dedup), attach the model's
  `confidence` + `rationale`, look up each claim's `subject`/`kind`, set `in_other_processes`;
- return candidates **sorted by confidence descending**.

### Schemas (extend `backend/app/schemas/process.py`)
- `ClaimMatchCandidate { claim_id: UUID; subject: str; kind: str; confidence: float | None;
  rationale: str; in_other_processes: bool }`
- `SuggestClaimsResult { candidates: list[ClaimMatchCandidate] }`

### Prompt-size defaults
- Candidate block carries **`kind` + `subject` only** (no full evidence/chunk text), keeping
  the prompt bounded since "all project claims" can be large.
- **Soft cap ~200 candidates** (log what was dropped if exceeded — never silently truncate),
  **~30 exemplars**. These caps are starting values, easy to tune.

## Frontend components

- **`api.suggestClaimsForProcess(projectId, processId)`** → `SuggestClaimsResult`
  (`src/lib/api.ts`), plus matching types in `src/lib/types.ts`
  (`ClaimMatchCandidate`, `SuggestClaimsResult`).
- **`ProcessList` row** (`src/components/inventory/process-list.tsx`) gains a **"Suggest
  claims"** button alongside Rename/Archive. It runs the suggest mutation; on success it
  opens the dialog with the returned candidates. The button shows a pending/spinner state
  while the matcher runs.
- **`SuggestClaimsDialog`** (new, ~the size of `bulk-assign-popover.tsx`): holds checkbox
  selection via the existing pure `triage-selection` helpers
  (`selectAll(candidateIds)` initial state, `toggleSelection` on untick, `isSelected` for
  render). Renders each candidate (subject, kind badge, confidence %, rationale, optional
  "also in another process" hint), a header count, and **"Add N claims"** which calls
  `api.assignClaims` with the selected ids, invalidates the relevant queries, toasts, and
  closes.

## Error handling & edge cases

- **Empty candidate pool** (every claim already linked here, or the project has no claims) →
  endpoint returns `{candidates: []}`; dialog shows "No unlinked claims to suggest."
- **Model returns zero matches** → empty candidates → dialog shows "No claims matched this
  process."
- **Bulk-assign is idempotent** (`_link_claims` skips claims already linked to the process),
  so re-adding or overlapping selections are safe.
- **Missing `ANTHROPIC_API_KEY` or LLM error** → 503 → "Suggest failed: …" toast; nothing
  changes.
- **Fabricated refs** from the model are dropped during ref resolution (only refs present in
  the candidate block resolve).

## Testing

- **Backend** (real `poet_test` Postgres):
  - pure block-builder is deterministic given a process + candidate set;
  - `propose_claim_matches` with a faked client: parses matches; degrades to `{"matches":
    []}` on a wrong-tool/malformed response; `_get_client` raises without a key;
  - endpoint: candidates exclude claims already linked to this process; `in_other_processes`
    flag set correctly for a claim linked to a sibling process; fabricated ref dropped;
    empty-pool path makes **no** LLM call; 503 on LLM failure; 404 for a process in another
    project.
- **Frontend:** `npx tsc --noEmit` clean; the only unit-testable logic (selection Set
  toggling) is already covered by `triage-selection.test.ts` and is reused, not duplicated.
  The dialog itself is verified by live smoke (no DOM/component tests in this repo).

## Out of scope (explicitly not building)

- **Durable / inbox-backed matches** (Approach B): persisting `assign_claims` suggestions,
  partial-accept of a persisted suggestion, enriching the shared inbox row to show claim
  text. Revisit only if users want match-now / accept-later.
- **Full evidence text in the matching prompt** (subject + kind is the signal for now).
- **Auto-apply without review** — every match is curated before it links.
- **A new migration** — the feature reads existing tables and writes only via the existing
  bulk-assign path.

## Reuse summary

Forced-tool pattern from `map_reconcile`/`map_ai_edit`; the `_get_process_in_project` guard,
`_link_claims`, and `assignClaims` bulk endpoint from SP-7b; the `triage-selection` Set
helpers and the `bulk-assign-popover` shape on the frontend. Net new surface: one service,
one read-only endpoint, two schemas, one API client method, one dialog, one row button.
