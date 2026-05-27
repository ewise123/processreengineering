# Extraction Progress UI — Design

**Date:** 2026-05-27
**Status:** Approved, ready for implementation plan
**Scope:** Minimum viable progress visibility for the per-input claim-extraction step

## Problem

Claim extraction runs synchronously inside the `POST /api/v2/projects/{project_id}/inputs/{input_id}/extract-claims` request. The handler loops over every chunk of the parsed input, makes one Anthropic `messages.create` call per chunk, and wraps the entire loop in a single transaction that commits only at the end (`backend/app/api/v2/claims.py:92`). For a 136-chunk transcript this is ~25–30 minutes of wall time, and during that window:

1. The Input row's `status` remains `parsed`. The backend has no `extracting` state.
2. The only "extraction" signal in the UI is the React Query mutation's `isPending` flag, surfaced as a button label change to "Extracting…". This signal is lost on page refresh, navigation, or any client that didn't initiate the mutation.
3. No partial progress is visible. The committed claim count is whatever the previous successful run left behind; the new run's inserts are invisible to any other database session until the final commit.
4. If the backend reloads (uvicorn `--reload` triggers on any code edit), the network blips, or the HTTP request hits an upstream timeout, the entire run rolls back. Tens of minutes of LLM spend are lost with no surface area for the user to notice or retry intelligently.

A user staring at a row that says `parsed` and a button that says `Extracting…` cannot tell whether their job is on chunk 4 of 136 or has already silently failed.

## Verified during diagnosis (2026-05-27)

- Backend pid 399 was `idle in transaction` with `query_start` advancing every ~10–12s, doing `INSERT INTO claim_citations` repeatedly. The pipeline works; the run is mid-flight.
- 1,778 claims for the input were visible from a separate `psql` session, but those came from an *earlier* successful run; the current run will overwrite them. No claim from the in-flight run is visible until commit.
- `backend.log` has no entry for the POST because uvicorn logs requests only on completion. After 30 minutes the line still hasn't been written.
- The browser console message `Unable to add filesystem: <illegal path>` is a benign Chromium DevTools warning about Next.js dev-mode source-map paths under WSL. Unrelated to this work.

## Goals

- A user looking at the Documents page can tell, at any moment, whether extraction is in flight, what chunk it is on, how many claims have been produced so far, and roughly how long is left.
- A backend restart mid-extraction does not lose all work, and does not leave the UI claiming "in progress" indefinitely.
- All of the above is exposed through the existing `listInputs` endpoint — no new endpoint, no SSE, no background-job infrastructure.

## Non-goals (explicit, deferred)

- Background workers / job queue (Celery, RQ, arq). The request stays synchronous.
- SSE or WebSocket streaming.
- Cancel-in-flight extraction.
- Resumable extraction (skip chunks that already have citations on retry).
- Touching the unrelated `embed` or `detect-conflicts` paths.
- Fixing the benign Chrome DevTools `Unable to add filesystem` console message.

## Design

### Backend

#### 1. Schema migration

A single new Alembic revision adds:

- `InputStatus` enum gains a value: `extracting`. Ordering: `uploaded` → `parsing` → `parsed` → `extracting` → `parsed` (terminal). No new terminal status; `extracting` is transient.
- `inputs` table gains four columns:
  - `chunks_processed INTEGER NOT NULL DEFAULT 0`
  - `chunks_total INTEGER NOT NULL DEFAULT 0`
  - `extraction_started_at TIMESTAMP WITH TIME ZONE NULL`
  - `extraction_error TEXT NULL`

The defaults make the migration safe for existing rows.

#### 2. Rewrite `extract_input_claims` (`backend/app/api/v2/claims.py`)

The current handler structure is preserved (same route, same response model). Internal control flow becomes:

```text
1. Load input + chunks (as today).
2. If no chunks: return ClaimExtractionResult(0, 0).
3. Wipe prior claims for this input via citations (as today), commit. ← was implicit
4. Set on Input row:
     status = "extracting"
     chunks_total = len(chunks)
     chunks_processed = 0
     extraction_started_at = utcnow()
     extraction_error = None
   commit.
5. For each chunk:
     try:
       extracted = extract_claims_from_text(chunk.text)
     except Exception as e:
       set status="failed", extraction_error=str(e); commit; raise.
     For each ec in extracted:
       insert Claim + ClaimCitation rows.
     chunks_processed += 1
     commit.   ← per-chunk commit, the load-bearing change
6. After loop:
     status = "parsed"
     extraction_error = None
   commit, return ClaimExtractionResult(claim_count, citation_count).
```

Key behavior change: **commit cadence moves from once-at-end to once-per-chunk**. Each chunk's claims and citations are durable as soon as Anthropic returns. A backend reload at chunk N preserves chunks 1..N-1.

**Behavior change worth flagging:** the existing "wipe prior claims" step (lines 52–63 today) becomes its own committed transaction *before* the loop, instead of riding in the same transaction as the loop. Today, if a re-extract fails mid-loop, the wipe is rolled back and the user keeps their old claims. After this change, the wipe is immediately durable — a failed re-extract leaves the input with whatever subset of new claims got committed before the failure (possibly zero). This matches the user's mental model of "click Re-extract → old claims are gone now", but it is a real behavior change. The "Re-extract" confirmation dialog already warns the user this is destructive, so no copy change is needed.

#### 3. Startup sweep (`backend/main.py`)

On FastAPI startup, before serving requests:

```sql
UPDATE inputs
SET status = 'failed',
    extraction_error = 'Interrupted by backend restart'
WHERE status = 'extracting';
```

This guarantees that no Input row is left in the transient `extracting` state across a process boundary. The next user action (clicking "Extract claims" / "Re-extract") will resume cleanly.

#### 4. Pydantic schemas

`InputRead` (`backend/app/schemas/input.py`) gains:

```python
chunks_processed: int = 0
chunks_total: int = 0
extraction_started_at: datetime | None = None
extraction_error: str | None = None
```

`InputStatus` (`backend/app/enums.py`) gains the `EXTRACTING = "extracting"` member.

### Frontend

#### 1. Types

`src/lib/types.ts` mirrors the new fields on `InputRow`. Status union widens to include `"extracting"`. No other type touches are required.

#### 2. Documents page (`src/app/(app)/projects/[id]/documents/page.tsx`)

- **Status badge:** add an `extracting` variant — `secondary` color with a small spinning glyph. Failed status with a non-null `extraction_error` renders a tooltip on hover containing the error text.
- **New "Progress" cell** in the row (between "Status" and "Claims"): when `status === "extracting"`, render
  - `"42 / 136 chunks (31%)"` on the first line
  - A thin shadcn `<Progress value={pct} />` bar
  - On hover/tooltip: `"Elapsed 4m12s · ~9m30s remaining"` computed client-side from `extraction_started_at` and the current rate.

  When `status !== "extracting"`, render `—`.
- **Polling:** the page's `useQuery({ queryKey: ["inputs", id, "page", offset] })` gains `refetchInterval: hasExtractingRow ? 3000 : false`. `hasExtractingRow` is `data?.items.some(r => r.status === "extracting") ?? false`. Polling auto-stops when no row is extracting.
- **Extract button gating:** the button is disabled and labeled `"Extracting…"` whenever `row.status === "extracting"`, independent of whether *this* client's `useMutation` is pending. This way:
  - A page refresh during extraction still shows the correct disabled state.
  - A second tab opened by the same user can't fire a duplicate extract on the same input.
- **Mutation behavior:** the existing `extract.mutate` flow remains. Its `onSuccess` toast becomes a confirmation of the *server-final* count returned by the request. While the mutation is pending, the progress cell drives the user-visible feedback, not the mutation flag.

#### 3. Error rendering

When `status === "failed"` and `extraction_error` is set, the status badge becomes destructive variant with the error text exposed via tooltip. The existing toast on `mutation.onError` is unchanged.

### Component boundaries

- The progress cell is a self-contained `<ExtractionProgressCell row={row} />` component. It depends only on the four new `InputRow` fields. Tested in isolation by passing fixture rows.
- The polling decision (`refetchInterval`) lives on the page, derived from the query data. Not pushed into a hook.
- The startup sweep is a single SQL statement bound to FastAPI's `@app.on_event("startup")` (or the equivalent lifespan handler). Not abstracted.

## Failure modes

| Scenario | Behavior |
|---|---|
| Anthropic call raises on chunk N | status → `failed`, `extraction_error` populated, error toast fires, the N-1 already-committed chunks of claims remain. |
| Backend `--reload` mid-loop | Startup sweep flips the row to `failed` with "Interrupted by backend restart". User clicks Re-extract; prior claims (committed up to that chunk) are wiped, run starts fresh. |
| User clicks Re-extract while an `extracting` run is in flight | UI button is disabled (`row.status === "extracting"`), so this can't happen via the UI. The endpoint itself does not currently lock — a direct API caller could race. **Accepted as out of scope** for MVP; the destructive prior-claim wipe at the start of the second run would race with the first run's inserts. Track separately if it becomes a problem.
| Anthropic returns malformed tool call | Existing `extract_claims_from_text` silently skips non-`record_claims` blocks; behavior unchanged. |
| User closes browser tab mid-extraction | Backend continues running (synchronous request thread on uvicorn). Per-chunk commits keep claims durable. The next page load sees the in-flight `extracting` status and joins the polling. |
| Frontend polling fires while the row is `parsed` | `refetchInterval` is `false`; no extra requests. |

## Test plan

### Backend

- Unit test `extract_input_claims` with a stubbed `extract_claims_from_text` that yields 1 claim per chunk. Use 4 fixture chunks. Assert:
  - After call 1, opening a fresh session shows `chunks_processed == 1`, `status == "extracting"`, 1 claim committed.
  - After call 4, `status == "parsed"`, `chunks_processed == 4`, 4 claims committed.
- Unit test the failure path: stub raises on chunk 3. Assert `status == "failed"`, `extraction_error` is populated, claims from chunks 1–2 remain.
- Unit test the startup sweep against a DB that has one `extracting` row; assert it flips to `failed` with the expected `extraction_error`.

### Frontend

- Manual: re-upload the test transcript. Watch the row transition `parsed → extracting (1/136 → 136/136) → parsed`. Confirm:
  - Progress text and bar update at roughly the 3 s polling cadence.
  - The "Claims" count column increments concurrently (driven by the same query).
  - The Extract button stays disabled the entire time.
  - A mid-run page refresh still shows the correct disabled state and progress.
- Manual: stop the backend during a run, restart, reload page. Confirm the row shows `failed` with the "Interrupted by backend restart" tooltip.

## Migration / rollout

- One Alembic revision. No data backfill needed; defaults are safe.
- Frontend type changes are additive (new optional fields, widened union). No breaking change to existing consumers of `InputRow`.
- No env var changes. No new dependencies.

## Open questions

None at design time. Implementation may surface UI polish decisions (exact spinner glyph, badge color choice, tooltip phrasing) — defer those to the implementation plan / review.
