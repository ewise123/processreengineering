# Multi-Process Detection — Design

_Date: 2026-05-28 · Status: design (pre-implementation) · Owner: chagood_

## Problem

A single document — or a collection of documents under a project — often covers more than one business process. A two-hour stakeholder interview about a strategic-accounts team realistically touches Accounts Payable, Quote-to-Cash, Onboarding, and Service Delivery in the same conversation. The current build assumes one project → one process map: the user picks a process name and level, the backend sends every extracted claim to Claude, and Claude returns a single BPMN structure. There is no detection step, no segmentation step, and no UX for "this material covers four processes — which one do you want first?"

The free-text **Focus** input on the existing Generate dialog is a half-measure: it appends `"Focus exclusively on the process named: X. Ignore claims about other processes."` to the prompt but still sends every claim in. The user must already know the process names exist, and the model is asked to filter rather than the data layer doing it. There is no review step, no persistence of which claims belong to which process, and no way to safely re-detect when a new document arrives.

This spec adds dynamic detection: a separate, user-triggered step that asks Claude to discover the distinct processes hiding in a project's claims, lets the user review and reshape the proposed splits, then drives generation per accepted cluster. The mechanism is domain-agnostic — the prompt teaches the model how to reason about process boundaries in the abstract, never about any specific industry or process kind.

## Non-goals

- No background workers or job queue. Detection is a blocking HTTP call, like extraction and generation today.
- No embedding-based clustering. The mechanism is a single Claude tool-use call. Embeddings already exist (`chunks.embedding`) and may be used in a later iteration; v1 does not depend on them.
- No automatic regeneration of existing maps when clusters change. Re-detection is safe — it never touches a map the user has already edited.
- No multi-cluster membership for a claim. A claim belongs to exactly one segment per detection run. A "move" affordance covers the cases where the model gets it wrong.

## End-to-end user flow

```
Sign in → Project → Documents tab
                       │
                       │ upload → parse → extract (existing)
                       ▼
                  [Detect processes]   ← NEW button next to Generate
                       │
                       │ POST /detect-processes (blocking, 10–60s)
                       ▼
              /projects/{id}/detect/{run_id}   ← NEW review page
                       │
                       │ rename / merge / delete / move / + new empty
                       │
                       ▼
                 [Accept & continue]
                       │
                       ▼
           Maps tab → post-accept generation panel
                       │
                       │ per-cluster generate (existing endpoint, new segment_id field)
                       ▼
                 Canvas (existing)
```

## Architecture

### Data model

Three new tables; one new nullable FK on an existing table.

**`detection_runs`** — one row per "I asked Claude to find processes" event.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `project_id` | uuid | FK → projects, indexed |
| `status` | text | `draft` / `accepted` / `archived` / `superseded` |
| `claim_count_at_run` | int | for "this run included N of M project claims" UI |
| `claim_id_set` | jsonb | array of claim ids in this run — supports re-run pre-population logic |
| `model_used` | text | model id used for the call (audit) |
| `prompt_tokens` | int | from the Anthropic response |
| `output_tokens` | int | from the Anthropic response |
| `reasoning_summary` | text | the model's "why these splits?" explanation |
| `notes` | text | free-form notes (currently unused, reserved) |
| `created_by` | uuid | FK → users (nullable for stub auth) |
| `created_at` | timestamptz | |

Status transitions:
- `draft → accepted` (Accept & continue button)
- `draft → archived` (Discard draft)
- `accepted → superseded` (a new run is accepted; the old one stays for provenance)
- `archived` and `superseded` are terminal.

**`process_segments`** — clusters proposed by the model and edited by the user.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `detection_run_id` | uuid | FK → detection_runs, indexed |
| `project_id` | uuid | denormalized for fast project-scoped queries |
| `name` | text | required for non-unassigned segments at acceptance |
| `description` | text | model output or user override |
| `order_index` | int | preserves the model's emitted ordering, user-reorderable later |
| `claim_count` | int | maintained on every membership change (1 cheap UPDATE) |
| `confidence` | float | model-reported, 0–1 |
| `is_unassigned` | boolean | exactly one row per run with `true`; receives ambient claims |
| `created_at`, `updated_at` | timestamptz | |

Invariants:
- Every `detection_run` has exactly one `process_segment` with `is_unassigned=true`. Created in the same transaction as the run.
- At most one `detection_run` per project may be in `status=draft` at any time. Enforced by a partial unique index: `CREATE UNIQUE INDEX uq_detection_runs_one_draft_per_project ON detection_runs(project_id) WHERE status='draft'`.

**On claim-vs-chunk granularity.** Membership is stored per claim, not per chunk. The "cluster chunks, claims inherit" framing from the design conversation is preserved by giving the Claude prompt the source chunk ref alongside each claim — the model's segmentation is informed by source position, but assignment writes happen at claim granularity. There is no `chunk_segment_membership` table. The chunk-level view is derivable if ever needed via `claim_segment_memberships ⨝ claim_citations ⨝ chunks`, but no v1 feature requires it.

**`claim_segment_memberships`** — which claim belongs to which segment.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `claim_id` | uuid | FK → claims |
| `segment_id` | uuid | FK → process_segments |
| `detection_run_id` | uuid | FK → detection_runs (denormalized for the unique constraint below) |
| `created_at` | timestamptz | |

Constraint: `UNIQUE (claim_id, detection_run_id)` — a claim belongs to exactly one segment per run. "Move claim" is an UPDATE on `segment_id`, not insert+delete.

**Existing table — additive change**

`process_versions.source_segment_id` — nullable FK → `process_segments`, `ON DELETE SET NULL`. Records which accepted segment a map was generated from, so the maps list can surface "generated from a superseded detection run" without expensive joins. SET NULL means: if a segment is later hard-deleted (only possible while its run is still `draft` — accepted runs are immutable), maps lose their provenance pointer but are not themselves affected.

### Pipeline shape

```
Documents → Chunks → Claims (existing — unchanged)
                       │
                       ▼
              DetectionRun (new — single Claude call)
                       │ produces
                       ▼
            ProcessSegment(s) [draft → accepted]
                       │
                       │ each accepted segment can be the scope of
                       ▼
                  Generate Map (existing endpoint, new `segment_id` field)
                       │
                       ▼
            ProcessModel → ProcessVersion (existing)
```

## The detection service

New file: `backend/app/services/process_detection.py`. Mirrors `process_generation.py` in shape: blocking Anthropic call, tool-use schema, soft cap on input claims, JSON output.

### Input the model sees

Claims rendered as one numbered line each, three columns separated by ` | `:

```
[0] task | from chunk c7 | AP clerk validates invoice header in SAP
[1] actor | from chunk c3 | Buyer enters PO line items in Coupa
[2] sla | from chunk c12 | Approvals must clear within 48 hours
[3] system | from chunk c1 | Salesforce is used across all teams
...
```

- `kind` — the existing `ClaimKind` enum value.
- `source_chunk_ref` — short ref `c{n}` where n is the chunk's position within its document. Cheap signal that disambiguates two same-worded claims from different document spans.
- `subject` — the existing one-sentence subject.

Quote and `normalized` are deliberately omitted. They aren't needed for clustering and burn the context budget.

### The tool

```json
{
  "name": "record_process_segments",
  "description": "Record the distinct business processes detected in a set of claims.",
  "input_schema": {
    "type": "object",
    "properties": {
      "segments": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name":        { "type": "string", "maxLength": 80 },
            "description": { "type": "string", "maxLength": 280 },
            "claim_refs":  { "type": "array", "items": { "type": "integer" } },
            "confidence":  { "type": "number", "minimum": 0, "maximum": 1 }
          },
          "required": ["name", "description", "claim_refs", "confidence"]
        }
      },
      "unassigned_claim_refs": {
        "type": "array",
        "items": { "type": "integer" }
      },
      "reasoning_summary": { "type": "string", "maxLength": 800 }
    },
    "required": ["segments", "unassigned_claim_refs"]
  }
}
```

Tool-use buys schema enforcement and no JSON-parse retries. `reasoning_summary` is surfaced verbatim in the review screen.

### System prompt — six rules

The prompt teaches the model how to reason about process boundaries in the abstract. No domain examples, no industry-specific primers.

1. **A process is a goal-directed flow with a definable trigger and outcome** — not a topic. "Accounts Payable" is a process; "approvals" is a topic that runs through many processes.
2. **Boundaries follow ownership, trigger, and artifact transitions.** When the actor changes _and_ the artifact being acted on changes _and_ the upstream trigger changes, you've crossed a process boundary. Any one signal alone is insufficient.
3. **Be conservative — splits over merges.** If unsure whether two clumps belong together, split them. The user can merge in the review step; un-merging is harder.
4. **Name in noun phrases, not verbs.** "Strategic Account Onboarding," not "Onboard accounts." Use the language the source documents use when it is clear.
5. **Ambient claims go to `unassigned_claim_refs`.** Tooling/system mentions, organizational facts, cross-cutting policies — if a claim describes the environment rather than a flow, leave it unassigned.
6. **Confidence is per segment, not global.** A clear segment with 25 supporting claims is `0.9`. A speculative segment built from 3 fragmentary claims is `0.4`. The UI flags low confidence.

Additional rule on naming when the model cannot ground a cluster: emit `name: "Unnamed cluster {n}"` and `confidence ≤ 0.3`. Defensive — the model is not allowed to bluff a name.

### Bounds

- `MAX_CLAIMS_INPUT = 1200` (vs. 400 in generation). Detection's output is bounded — a few segment definitions plus a reasoning summary — whereas generation emits a full BPMN structure, so detection can afford more input claims at the same context cost. Raised from 600 on 2026-05-28 after a real project hit the cap at 875 claims.
- `MAX_TOKENS = 6000`. Budget breakdown: per-segment description ≈ 70 tokens × up to 15 segments + reasoning summary 200 tokens + tool-use overhead + claim_refs lists. 6000 is comfortable with headroom.
- If the project has more than 1200 claims, the endpoint rejects with a structured error directing the user to scope by input id (`scope_input_ids` parameter mirrors `generate_process_map`).
- Model errors → 503; no row is created (the run is created in the same transaction as the segment writes).
- If the model returns zero segments (everything went to `unassigned_claim_refs`), the endpoint returns `422` with a structured error: "The model could not identify any distinct processes in the supplied claims. This usually means the claims are too sparse or describe a single homogeneous activity. Try adding more documents, or skip detection and use the existing Generate dialog directly." No run is persisted in this case.

## API surface

All new endpoints under `/api/v2/projects/{project_id}/...`.

### Trigger detection

```
POST /projects/{project_id}/detect-processes
body: { scope_input_ids?: UUID[] }
→ 201 {
    detection_run_id: UUID,
    status: "draft",
    segments: ProcessSegmentRead[],
    unassigned_claims: ClaimSummary[],
    reasoning_summary: string,
    claim_count_at_run: int,
    model_used: string
  }
```

Blocking. Returns the freshly created run with all segments and memberships expanded so the review screen renders from one payload, no second fetch. Errors:

- `422` if the project has zero claims (existing extract-claims-first message).
- `422` if claim count > 1200 (suggests `scope_input_ids`).
- `503` if Anthropic returns an error (transaction rolls back; no row created).
- `409` if there is already a `draft` run for the project — the response includes the existing run's id so the UI can route the user back to "Resume draft" instead of starting fresh.

### Read

```
GET  /projects/{project_id}/detection-runs                 → list, newest first
GET  /projects/{project_id}/detection-runs/{run_id}        → run + segments + memberships
```

### Review-screen mutations (draft runs only)

```
PATCH  /projects/{project_id}/segments/{segment_id}
body: { name?, description? }
→ 200 ProcessSegmentRead

POST   /projects/{project_id}/detection-runs/{run_id}/segments
body: { name }                         ← "+ New empty cluster"
→ 201 ProcessSegmentRead

POST   /projects/{project_id}/segments/{segment_id}/merge
body: { into_segment_id }              ← memberships move, source segment deleted
→ 200 ProcessSegmentRead

DELETE /projects/{project_id}/segments/{segment_id}
→ 204                                  ← memberships move to the run's Unassigned segment

POST   /projects/{project_id}/segments/{segment_id}/claims
body: { claim_id }                     ← single-claim move
→ 200 ProcessSegmentRead
```

Mutations against a non-`draft` run return `409`. The Unassigned segment cannot be renamed, deleted, or merged.

### Acceptance

```
POST /projects/{project_id}/detection-runs/{run_id}/accept
→ 200 { run_id, accepted_segment_count }
```

Server validation:

- Every non-unassigned segment has a non-blank name.
- No two non-unassigned segments share an exact name (case-insensitive) within the run.
- Unassigned segments are skipped.
- Any prior `status=accepted` run on the same project flips to `status=superseded` in the same transaction.

Returns `422` with the offending segment ids if validation fails.

### Generation — additive change

```
POST /projects/{project_id}/generate-process-map
body: {
  name, level, focus?, map_type?, scope_input_ids?,
  segment_id?: UUID            ← NEW
}
```

When `segment_id` is set, the claims loader joins through `claim_segment_memberships` (filtered by the segment's `detection_run_id` to scope correctly). The handler writes `process_versions.source_segment_id` so the map records its provenance. When `segment_id` is unset, behavior is unchanged.

## Frontend

### Where the action lives

- **Project detail → Documents tab.** New **"Detect processes"** button next to the existing "Generate map" button. Disabled when no claims exist. When an accepted run already exists, label changes to **"Re-detect processes"** with a badge showing the accepted segment count. When a draft already exists, label is **"Resume draft (N segments)"** and the click routes back to the review page.
- **Maps tab.** Empty state when there are claims but no maps shows the primary CTA pointing at the detect flow rather than at generation directly. Today's empty state assumes one process; the new copy reframes around discovery.

### Review page — new route

`/projects/{id}/detect/{run_id}` — full-page route, not a modal. Three regions:

- **Header row.** Run metadata (date, candidate count, total claim count). Three action buttons: Re-detect (creates a fresh draft, archives the current), Discard draft, Accept & continue.
- **Main column.** One card per non-unassigned segment, ordered by `order_index`. Each card shows:
  - Header: cluster name (editable inline, debounced PATCH on blur/Enter, 400 ms), confidence badge, claim count.
  - Description: smaller, editable line under the name.
  - Claim list: virtualized for clusters with hundreds of claims. Each row shows `kind` + `subject` + a "Move ↓" chevron that opens a popover listing every other cluster.
  - Card actions: Rename, Merge (single-select popover of other clusters), Delete.
  - Below the last card: **+ New empty cluster** — POSTs an empty segment, focused for naming.
- **Right rail.** "Why these splits?" panel with the model's `reasoning_summary`, collapsible. Below it, the Unassigned card — smaller, pinned, never renamable or generatable.

Confidence styling: below 0.5 paints the card border amber and shows a ⚠ icon. Visual cue, not a block.

No drag-drop in v1 — keyboard-popover is faster and accessible. Drag-drop can be added later without changing the data model.

### Post-accept generation panel

After Accept & continue, redirect to the Maps tab with the generation panel open:

```
┌─ Generate maps from N accepted processes ──────────────────────────────┐
│                                                                         │
│ Default settings applied to every cluster:                              │
│   Level: [L2 ▾]   Map type: [Current state ▾]                          │
│                                                                         │
│ ┌─ Cluster name ──┐   Level: [L2 ▾]   [Generate now]                   │
│ (one row per accepted segment)                                          │
│                                                                         │
│             [Skip — generate manually]      [Generate all in sequence] │
└─────────────────────────────────────────────────────────────────────────┘
```

Two intents, two buttons:

- **Generate all in sequence.** Fires `POST /generate-process-map` for each cluster serially. Progress shown live in the same cell style used today for extraction. Failures don't block the rest; failed rows show a retry.
- **Generate now (per cluster).** Single map, user's pace.
- **Skip — generate manually.** Dismisses the panel. The existing Generate dialog gains a new first field, "From detected process: [None / cluster names…]", defaulting to None for backward compatibility.

### Edge cases

- **Only 1 cluster detected.** Show the review screen anyway with a banner: "We found a single process. You can still rename and accept, or skip to direct generation."
- **Detection in progress.** Button shows a spinner with elapsed time, matching the extraction-progress pattern.
- **Detection failed.** Button returns to idle; toast shows the 503 message. No draft created.
- **Re-detection while a draft already exists.** Documents-tab button reads "Resume draft (N segments)" and routes back to the review page. Discard draft on the review page is the only way to start fresh.
- **Stale maps after re-detect + accept.** Maps generated from a now-superseded segment show a small "Generated from older detection run" indicator on the maps list, with a "Regenerate from current cluster" action. Non-blocking.

### Re-run pre-population heuristic

When a new draft is created and a prior accepted run exists, the new segments pre-inherit data from the old accepted ones when there's overlap:

- For each new segment, compute the set intersection of `claim_id_set ∩ old_accepted_segment.claim_id_set`.
- If ≥ 70% of the new segment's claims previously belonged to a single old accepted segment, the new segment inherits the old name and a banner "Matches existing 'X'".
- Pure Python, fully unit-testable, no embeddings. The 70% threshold is a deliberate choice and lives behind a constant for easy tuning.

**Where this runs in the pipeline.** The detection service applies the heuristic in-process, after parsing the Claude tool-use response and before writing the segments to the database. The newly-created segment rows are persisted with their inherited names already set, so the review screen renders the inheritance without a second round-trip. The "Matches existing 'X'" banner is a UI-only signal driven by comparing each new segment's name against the names of the prior accepted run's segments at render time — no extra column needed.

## Backward compatibility

- Existing `POST /generate-process-map` continues to work with no `segment_id` — the legacy "all claims, optional focus string" path is unchanged.
- The existing Generate dialog's Focus input stays. It's redundant with detection-driven flows but harmless, and removing it now would break the workflow for users who haven't run detection yet.
- The Maps tab's empty state changes only when claims exist but no maps do. When neither exist, the existing "upload + extract" guidance is unchanged.
- No migration touches `claims`, `chunks`, `process_models`, or `process_versions` destructively. The only existing-table change is one nullable column on `process_versions`.

## Testing

- **Unit — detection service.** Mock the Anthropic client to return a known tool-use payload. Assert (a) claims are rendered with the three-column format, (b) `MAX_CLAIMS_INPUT` truncation, (c) the run + Unassigned segment are created in the same transaction, (d) 503 path rolls back cleanly.
- **Unit — re-run pre-population heuristic.** Pure-Python function, exhaustively tested across overlap percentages, including ties, empty intersections, and the 70% boundary.
- **Integration — API.** Per endpoint: 201/200 happy path, validation rejections, draft-only mutation gate, accept-then-supersede transition, scope_input_ids filtering, the new `segment_id` field on generate-process-map.
- **Frontend.** Component tests for the cluster card (rename, merge, delete, move), the post-accept panel (per-cluster generate + sequence + skip), and the Maps tab empty-state copy variants.
- **End-to-end smoke.** Upload a known multi-process transcript fixture (NOT the user's actual transcript — a small synthetic two-process example), extract, detect, accept, generate, assert two ProcessModels exist and each carries the right `source_segment_id`.

## Open questions deferred to implementation

- Exact UX for the merge popover when there are 10+ clusters (search? grouped list?). Implementation-time call.
- Whether the description field on a segment should support markdown. Default: plain text. Revisit if users ask.
- Sort order in the Maps list when a project has both detection-scoped maps and legacy "all claims" maps. Default: created_at desc, no grouping. Revisit if it gets noisy.
