# SP-7 — Process Inventory & the Claims-to-Maps Working Loop

_Design spec, 2026-06-09. Brainstormed and approved in-session. Supersedes the detection-run
model designed in `2026-05-28-multi-process-detection-design.md`._

## Problem

POET's workflow is AI-first where the consultant needs it to be user-first. The only way to
scope a process map is to run AI detection over all claims and then fight the result. The
specific walls, in priority order:

1. **No top-down map scoping.** A consultant cannot declare "I want maps for Order-to-Cash,
   Onboarding, and Escalations" and curate claims into them. The empty-cluster button only
   exists inside an AI-generated draft run (`processes/page.tsx` State A offers only Detect).
2. **Curation is lossy and run-scoped.** One accepted `DetectionRun` at a time; re-detecting
   supersedes all manual curation. New documents after acceptance land in no segment.
   `ClaimSegmentMembership` is single-membership; claim moves are one-at-a-time popovers.
3. **Claims are read-only.** No edit / delete / add-manual (`claims.py` has zero claim
   mutation endpoints). The only correction path is re-running extraction on a whole document.
4. **Maps are one-shot.** The segment→map link is a stamp (`source_segment_id`) used only for
   a stale badge. New evidence can't flow into an existing map; regenerating discards hand
   edits.
5. **No blank maps.** The shape palette and node/edge/lane CRUD are fully built, but the only
   `ProcessModel` constructor is AI generation, which 422s without claims.
6. **Provenance is view-only.** `NodeClaimLink` rows are written only by generation/AI; no
   attach/detach endpoint or UI.
7. **Conflicts are detect-only.** `ClaimConflict` has `resolution_status` + `resolution_notes`
   columns and the canvas already filters badges on `DETECTED`, but nothing can ever resolve
   one.

## Decisions (approved in brainstorming)

- **One durable Process Inventory** replaces the run/draft/accept/supersede lifecycle.
  Users create/rename/archive processes anytime. AI "Suggest processes" proposes new
  processes and claim assignments **into the same inventory** as per-item accept/reject
  suggestions. The run lifecycle is deleted, not deprecated.
- **Map refresh = reconcile-as-diff.** When a process's claim set changes after its map was
  generated or hand-edited, "Refresh from claims" produces targeted accept/reject ops that
  preserve layout and hand edits. Never regenerate over the user's work.
- **In scope:** claim editing, blank map creation, node↔claim link editing, conflict
  resolution.
- **Approach: hybrid.** Phase 1 ships the four schema-free quick wins first; Phase 2 is a
  clean data-model migration (no sentinel-run reuse of the detection tables); Phase 3 is the
  reconcile diff. Rationale: there is no production data yet (auth is stubbed), so migration
  reversibility is cheap insurance not worth permanent schema debt.

## Out of scope (later sub-projects)

Current→future-state delta workflow, L1→L2 drill-down hierarchy, claim search, node
comments, review assignment/multi-user, document delete/replace lifecycle, background job
queue, export. The data model below deliberately leaves room for the first two
(process 1→many maps; `level` stays on `ProcessModel`).

---

## Phase 1 — Quick wins (no new tables, independently shippable, parallelizable)

### 1.1 Claim CRUD

- `POST /projects/{id}/claims` — manual claim (kind, subject, normalized text). No citation
  required; optionally a free-text "manual quote".
- `PATCH /claims/{claim_id}` — edit kind / subject / normalized.
- `DELETE /claims/{claim_id}` — cascades drop citations, node links, conflicts.
- New column `claims.source` (`extracted` | `manual`, default `extracted`), one small
  migration. Manual claims survive re-extraction (the wipe in `claims.py:53-64` targets
  extracted claims for that input) and are badged in the UI.
- Delete confirmation must name affected maps (computed via `NodeClaimLink` join) because the
  cascade silently empties node evidence.
- **Bug fix folded in:** `run_conflict_detection` writes the AI's reasoning into
  `resolution_notes` (`claims.py:202`), colliding with user resolution notes. Move the AI
  reason to a new `claim_conflicts.detection_reason` column (same migration).
- UI: row actions + "Add claim" dialog on `claims/page.tsx`.

### 1.2 Conflict resolution

- `PATCH /projects/{id}/conflicts/{conflict_id}` — body `{resolution_status, resolution_notes}`.
  Allowed statuses: existing `ConflictStatus` enum (resolved / dismissed / detected).
- Canvas node badges and Issues tab already filter on `DETECTED`
  (`process_maps.py:904, 1093`) — resolving makes badges disappear with no canvas change.
- UI: resolve/dismiss buttons + notes field on `conflicts/page.tsx` and in the node Issues
  panel (`properties-panel.tsx` / `right-panel.tsx`).

### 1.3 Node↔claim link editing

- `POST /projects/{id}/nodes/{node_id}/claims` — body `{claim_ids, link_kind}`; idempotent on
  the existing `uq_node_claim_links_node_claim` constraint.
- `DELETE /projects/{id}/nodes/{node_id}/claims/{claim_id}`.
- Reuse `_check_node_in_project` (`process_maps.py:469`); sits beside the existing read-only
  `GET /nodes/{node_id}/citations`.
- UI: attach (claim picker) / detach controls in the properties panel citations section.

### 1.4 Blank map creation

- Extract steps 4–6 of `generate_process_map` (find-or-create model, version numbering,
  default lane) into a shared `_create_model_and_version(...)` helper.
- `POST /projects/{id}/process-maps` — body `{name, level}`; creates model + empty version +
  one default lane + Start/End nodes (with the lineage-key stamping at
  `process_maps.py:326-328`). No AI, no claims required.
- UI: "New blank map" button on `maps/page.tsx` routing straight into the canvas, which
  already supports full editing.

## Phase 2 — Process Inventory core (clean migration)

### Data model

**`processes`** — the durable inventory entity.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| project_id | uuid fk projects, cascade, indexed | |
| name | str(300) not null | |
| description | text default "" | |
| order_index | int default 0 | user-orderable |
| status | str(20) default "active" | `active` \| `archived` |
| created_by | uuid fk users, set null | |
| timestamps + soft delete | | mirror `ProcessModel` mixins |

No `level` column — level is a property of a map view, not the process; it stays on
`ProcessModel` (one process can carry an L2 and an L4 map).

**`process_claim_links`** — durable many-to-many; replaces `ClaimSegmentMembership`.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| process_id | uuid fk processes, cascade, indexed | |
| claim_id | uuid fk claims, cascade, indexed | |
| assigned_by | str(20) default "user" | `user` \| `ai_accepted` \| `inherited` |
| created_at | | |
| UNIQUE(process_id, claim_id) | | multi-membership allowed by construction |

"Unassigned" = a claim with zero link rows (left-join query). No synthetic Unassigned
segment.

**`process_suggestions`** — unified accept/reject inbox for AI discovery **and** map
reconcile. The structural guarantee that curation is never lost: every row is independently
acceptable; accepting mutates the durable inventory/map immediately; rejecting touches
nothing else.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| batch_id | uuid, indexed | one click = one batch |
| project_id | uuid fk, indexed | |
| kind | str(30) | `process_discovery` \| `map_reconcile` |
| process_id | uuid fk processes, set null | null for discovery-create; set for reconcile |
| version_id | uuid fk process_versions, set null | set for reconcile |
| op | str(40) | see vocabulary |
| payload | jsonb | op-specific |
| rationale | text | model's grounding |
| confidence | float nullable | |
| status | str(20) default "pending" | `pending` \| `accepted` \| `rejected` |
| model_used / token counts | | audit |
| created_at / resolved_at | | |

**Op vocabulary**

- Discovery: `create_process` `{name, description, claim_ids}`;
  `assign_claims` `{process_id, claim_ids}`.
- Reconcile: `add_step` `{name, type, after_node_id, lane_id|lane_name, edge_label,
  cited_claim_ids}`; `recite_node` `{node_id, add_claim_ids, remove_claim_ids}`;
  `flag_stale_node` `{node_id, vanished_claim_ids}`; `relabel_node` `{node_id, proposed_name}`.

**Altered:** `process_models.process_id` (uuid fk processes, set null, indexed) — a process
has many maps. **Dropped:** `process_versions.source_segment_id`; tables `detection_runs`,
`process_segments`, `claim_segment_memberships` (after data migration).

### Migration (single Alembic revision after `0007`)

1. Create the three tables; add `process_models.process_id`.
2. Data step (raw SQL): for each **accepted** `DetectionRun`, each non-unassigned
   `ProcessSegment` → one `processes` row (name, description, order_index, created_at); each
   of its memberships → a `process_claim_links` row (`assigned_by='inherited'`). Drafts,
   superseded, and archived runs are discarded. Unassigned-segment claims simply get no
   links (the new triage state).
3. Re-link maps: for each `ProcessModel`, follow any version's `source_segment_id` to the
   migrated process; set `process_id`. Unresolvable → `process_id=NULL` ("unlinked maps",
   attachable from the UI).
4. Drop `source_segment_id`, then the three detection tables.

Downgrade recreates empty tables only — **honestly lossy**, called out in the PR.
Acceptable: no production data exists. The migration ships in its own PR with a
Postgres-backed test (seeded detection data → assert process/link/relink counts). Dev DB
needs `alembic upgrade head` after merge (hot-reload 500s otherwise).

### API (new router `backend/app/api/v2/processes.py`, prefix `/projects/{project_id}`)

- `GET /processes` (with claim_count, map_count) · `POST /processes` · `PATCH
  /processes/{id}` · `DELETE /processes/{id}` (soft).
- `GET /processes/{id}/claims` · `POST /processes/{id}/claims` `{claim_ids}` (bulk, idempotent)
  · `DELETE /processes/{id}/claims` `{claim_ids}` (bulk).
- `GET /claims/unassigned` — triage view.
- `POST /suggest-processes` `{scope_input_ids?}` — runs the existing
  `detect_segments_from_claims` clustering but writes `process_discovery` suggestions.
  Existing claim-ref hardening (`_resolve_refs` pattern) drops fabricated refs.
- `GET /process-suggestions?status=&kind=` · `POST /process-suggestions/{id}/accept` ·
  `POST /process-suggestions/{id}/reject` · `POST /process-suggestion-batches/{batch_id}/accept`.
- One `apply_suggestion(db, suggestion)` dispatcher handles all accepts.

**Modified:** `POST /generate-process-map` takes `process_id` (replaces `segment_id`), scopes
claims via `process_claim_links`, stamps `process_models.process_id`. `PATCH
/process-maps/{model_id}` attaches/detaches `process_id` (for unlinked migrated maps).
**Deleted:** all of `process_detection.py`'s endpoints and `services/process_detection.py`'s
run persistence (the pure clustering function is kept and rewired).

### Frontend

- `processes/page.tsx` — full rewrite: durable inventory list (inline create/rename/archive),
  unassigned-claims triage panel with **multi-select bulk assign**, "Suggest processes"
  button, suggestion inbox. The `resolveCurrentRun` model is deleted.
- New `src/components/inventory/`: `process-list.tsx`, `suggestion-inbox.tsx` (the single
  reusable diff-review surface — also used by reconcile on the canvas),
  `claim-triage-panel.tsx`, `bulk-assign-popover.tsx`.
- Deleted: `src/components/detect/*` (segment-card, merge-popover, move-claim-popover,
  new-empty-cluster-button, post-accept-panel) and `detect-processes-button.tsx`. The
  `detect/[runId]` route already redirects; keep the shim.
- `maps/page.tsx` — group maps by process; "unlinked maps" section with attach control. The
  superseded-run stale badge is replaced by a live **"N unreconciled claims"** count per map
  (claims in the process not cited by any node).
- `src/lib/api.ts` / `types.ts` — drop the 9 detection methods; add the surface above.

## Phase 3 — Reconcile-as-diff

- `POST /process-maps/{model_id}/versions/{version_id}/reconcile` (beside
  `apply_proposed_step` in `process_maps.py`).
- **Delta computed in plain code first** (cheap, testable, grounds the model): claims linked
  to the process but cited by no node → "new evidence"; claims cited by nodes but no longer
  in the process (or deleted) → "vanished evidence".
- One Claude call in new `services/map_reconcile.py`, modeled on `map_ai_edit.py`'s
  forced-tool pattern: context = `assemble_map_context(db, version)` + the delta; output =
  array of reconcile ops with `cited_claim_refs`; refs resolved and fabrications dropped.
- Ops persist as `map_reconcile` suggestions → **a reconcile survives page reload**, unlike
  the ephemeral AI-edit panel today.
- Accept dispatch: `add_step` reuses `apply_proposed_step`'s body; `recite_node` writes
  `NodeClaimLink` rows (the Phase 1.3 machinery); `flag_stale_node` sets
  `node.properties["evidence_stale"]=true` (non-destructive; canvas already round-trips
  `properties` JSONB, so badging is frontend-read-only); `relabel_node` uses the
  `update_node` path. Layout and hand edits are never regenerated.
- UI: "Refresh from claims" in the canvas right panel, reusing `suggestion-inbox.tsx`.

## Error handling

- Accepting a suggestion whose target node/claim was deleted in the meantime → graceful
  no-op, suggestion marked with a `target_gone` outcome (mirrors `apply_proposed_step`
  silently dropping unknown claim ids at `process_maps.py:1312`).
- All new claim/process/suggestion endpoints use the existing project-scoping 404 guard
  pattern.
- Suggest/reconcile LLM failures surface as 503 with the run untouched (suggestions are only
  written after a successful, parsed response).

## Testing

- pytest per new endpoint following `backend/tests/` patterns; dedicated tests for
  `apply_suggestion` dispatch (including stale-target no-ops) and the reconcile delta
  computation (pure function).
- Postgres-backed migration test asserting segment→process / membership→link / map-relink
  counts.
- Vitest for triage selection and suggestion-inbox state logic (pattern of existing canvas
  `.test.ts` files).
- Gates: `tsc`, Vitest, pytest. Lint advisory (7 pre-existing errors are baseline).

## Build sequence

1. Phase 1 slices (1.1–1.4) — parallelizable, each its own PR.
2. Schema + migration PR (backend only; nothing reads the new tables yet).
3. Inventory CRUD + curation API + rewritten Processes page (frontend/backend land together).
4. Suggest-processes + suggestion inbox.
5. Map↔process wiring: generate-by-process, attach, maps-page regroup, blank-map button moves
   under processes too.
6. Reconcile service + endpoint + canvas panel.

## Risks

- The data migration is one-way; mitigated by the Postgres test and a dev-DB dry run
  (snapshot counts before/after).
- Slice 3 is the one frontend+backend coupled landing; everything else is independently
  shippable.
- Dropping `source_segment_id` breaks the `list_process_maps` join and stale badge — both are
  replaced in the same slice, never left dangling.
- `claim_count` display semantics change under multi-membership (sum of per-process counts >
  distinct claims); display-only, documented in the UI as "claims assigned".
