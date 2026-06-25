# Design — Process-map reasoning trail, change log & best-practices seeding

_Created 2026-06-22. Source of requirements: `docs/transcripts/Process Mapping Updates.txt`, distilled in `docs/process-mapping-updates.md`. Pairs with `docs/how-it-works.md` (current behavior) and `docs/spec/process-reengineering-spec-v1.1.md` (target spec)._

## 1. Summary

Today the process-map editor can draft a swimlane map from grounded claims, edit it by hand and with per-node AI proposals, version it, and trace each node to the source quote that justified it. What it cannot do is answer **"why does this node/edge exist, and why has it changed?"** in a durable, per-object way. Reasoning produced during AI edits is discarded on apply; manual edits record nothing; two models meant for exactly this (`AuditEvent`, `AiInteraction`) are declared but never used.

This design adds a single **append-only change-event backbone** and builds three features on it:

- **Item 1 — Per-object reasoning trail.** Every node and edge carries why it was created and the reason for each change (AI *and* manual), traceable back to origin.
- **Item 2 — Change log.** A model-wide, filterable feed of those change events, as a new tab beside the existing Versions and Sources tabs.
- **Item 5 — Best-practices seeding cadence.** Generate a starter map from best-practice knowledge on an empty canvas, then refine it additively by feeding in correction transcripts — every step accruing provenance.

## 2. Scope

**In scope:** items 1, 2, 5 above.

**Explicitly out of scope:**

- **Item 3, chat-as-editor** (chat that proposes-and-applies edits with inline accept). Owned by Emory.
- **Item 4, stakeholder comments + AI triage.** Dropped from this arc — it overlaps heavily with the chat work Emory is doing, so it belongs with that effort, not here.
- **All authentication / OAuth / user-management work.** Change events are internal-only; `actor_id` is the existing hard-coded dev user. Nothing here touches identity, sessions, or roles.
- **Parked features** from `docs/process-mapping-updates.md`: reviewer assignment (P1), full auth (P2), client view (P3).
- **Unifying the three right-panel tabs** into one feed. Versions, Sources, and the new Change Log stay separate.

## 3. Decisions locked during brainstorming

1. **One spec, this arc** — items 1, 2, 5 designed together because 2 and 5 read or write through the item-1 backbone.
2. **Cosmetic edits are not changes.** Only semantic edits (and create/delete/branch) are logged; layout/style edits never produce events. See §5.
3. **Synthesize origin from claims for existing maps** — the migration backfills one origin event per existing node/edge, mining the reason from linked claims where present, falling back to "Created before provenance tracking" otherwise.
4. **Concise reason + full thinking trace for AI changes** — every event stores a short human-readable reason + cited claim IDs (shown by default); AI-driven changes additionally store the model's full extended-thinking blocks, surfaced via a collapsible "show thinking" disclosure.
5. **Three tabs stay separate**, and the per-object History (properties panel) and model-wide Change Log (tab) both exist — same data, two entry points for two workflows (in-context editing vs. review).
6. **One event per save; no-ops skipped; version branch logs once; undo/redo log as inverse events.** See §5.

## 4. The change-event backbone

### 4.1 Data model

A new append-only table `change_event` (`IdMixin` + `TimestampMixin`; `created_at` is the event time). Rows are never updated or deleted.

| column | type | notes |
|---|---|---|
| `id` | uuid | PK (IdMixin) |
| `created_at` | timestamptz | event time (TimestampMixin) |
| `target_type` | enum | `node` / `edge` / `lane` / `version` |
| `target_id` | uuid | **not a FK** — the trail must survive deletion of the target |
| `model_id` | uuid FK → process_models | scopes the change-log query (item 2) |
| `version_id` | uuid FK → process_versions, nullable | which version the change occurred in |
| `actor_kind` | enum | `user` / `ai` / `system` |
| `actor_id` | uuid, nullable | the dev user today; real users post-auth (out of scope) |
| `kind` | enum | `create`, `relabel`, `describe`, `retype`, `relane`, `link_claim`, `unlink_claim`, `connect`, `reconnect`, `delete`, `branch`, `restore`, `flag_stale`, `recite` |
| `reason` | text | concise human-readable line shown in history |
| `before` | jsonb, nullable | snapshot of the fields that changed, pre-change |
| `after` | jsonb, nullable | snapshot of the fields that changed, post-change |
| `cited_claim_ids` | jsonb, nullable | array of claim UUIDs the reason cites |
| `reasoning_trace` | jsonb, nullable | AI extended-thinking blocks; null for manual/system |
| `source` | enum | `generation` / `manual` / `chat` / `reconcile` / `import` / `migration` |
| `suggestion_id` | uuid FK → process_suggestions, nullable | back-link when the change came from a reconcile suggestion |

Indexes: `(target_type, target_id, created_at)` for per-object history; `(model_id, created_at)` for the model-wide log feed.

> `source` includes `chat` so the enum need not change when Emory's chat-editor work lands. No code in this design emits `chat` events. There is no `move`/`recolor`/`resize` kind because cosmetic edits are never logged (§5).

### 4.2 Single write path

A helper `record_change(db, *, target_type, target_id, model_id, version_id, actor_kind, actor_id, kind, reason, before, after, cited_claim_ids, reasoning_trace, source, suggestion_id)` in a new module `app/services/change_log.py`. It inserts one row **within the caller's transaction**, so the event commits atomically with the change it describes — never a change without its event, never an event without its change. Callers pass only the fields that changed in `before`/`after`.

### 4.3 Capture sites

| site | kind(s) | source | notes |
|---|---|---|---|
| map generation (service path) | `create` per node & edge | `generation` | origin reasoning from the generator |
| `process_maps.create_node` / `create_edge` / `add_lane` | `create` / `connect` | `manual` | |
| `process_maps.update_node` | `relabel` / `describe` / `retype` / `relane` | `manual` | semantic fields only (§5); cosmetic ignored |
| `process_maps.update_edge` | `relabel` (label) / `reconnect` | `manual` | bend changes ignored |
| `process_maps.update_lane` | `relabel` (name) | `manual` | order/color/height/collapsed ignored |
| node claim attach / detach | `link_claim` / `unlink_claim` | `manual` | |
| `process_maps.delete_node` / `delete_edge` / `delete_lane` | `delete` | `manual` | |
| `process_maps.apply_proposed_step` | `create` | `reconcile` | carries proposal rationale + trace |
| reconcile apply (`apply_suggestion` ops) | `recite` / `flag_stale` / `relabel` / `create` | `reconcile` | + `suggestion_id` back-link |
| `versions.copy_version` (branch/restore) | `branch` / `restore` | `manual` | one version-level event; see §5 |

## 5. What constitutes a logged change

This is the explicit definition of when a `change_event` row is written.

**A row is written only when a semantic property actually changes value, or an object is created/deleted, or a version is branched/restored.**

**Logged (semantic):**
- **Node** — create, delete, `name` (relabel), `description` (describe), `type` (retype), `lane_id` (relane), claim link/unlink.
- **Edge** — create (connect), delete, `label`/`condition_text`, source/target reconnect.
- **Lane** — create, delete, `name`.
- **Version** — branch, restore.
- **Reconcile ops applied** — recite, flag_stale, relabel, add_step (`source=reconcile`).
- **Generation** — create per node/edge (`source=generation`, `import`, or best-practices seed).

**Never logged (cosmetic).** These still persist to their tables; they simply produce no event:
- Node canvas position (`x` / `relative_y`).
- Edge bend points (`bend_x` / `bend_y`).
- Lane `order_index` (reorder), `height_px`, `color`, `collapsed`.

**No-op rule.** Each mutating endpoint reads the row's current values *before* mutating. If no semantic field's value actually differs — re-saving identical text, a PATCH carrying only cosmetic fields, or a field set to its existing value — no event is written, and no reason is required (nothing changed).

**One event per save.** A single PATCH that changes several semantic fields at once produces **one** event. `before`/`after` enumerate every changed field; `kind` is the most-semantic field by this priority: `delete` > `create` > `retype` > `relane` > `relabel` > `describe` > `reconnect` > `connect` > `unlink_claim` > `link_claim`. (This matches the frontend, which coalesces edits per entity into one debounced PATCH via `use-persistence.ts`.)

**Reason requirement (tiered).** If a PATCH changes ≥1 semantic field and carries no `reason`, the endpoint returns **HTTP 422** with an actionable message. A PATCH that touches only cosmetic fields, or is a no-op, never requires a reason and never prompts.

**Version branch/restore.** `copy_version` writes a single version-level event (`kind=branch` or `restore`). Cloned nodes/edges do **not** get per-object `create` events — their trail follows the existing lineage key (`LINEAGE_KEY` in node properties) back to the source version's objects, so per-object history can cross versions without doubling the table on every branch.

**Undo/redo.** The canvas replays undo/redo through the normal create/delete/patch endpoints, so each produces a normal event with its `reason` auto-prefixed "Undo of …" / "Redo of …", keeping the back-and-forth visible in the trail. (The undo stack supplies the inverse reason text; this is append-only, never a deletion of the prior event.)

### 5.1 Tiered reason mechanics

`NodeUpdate` / `EdgeUpdate` / `LaneUpdate` gain an optional `reason: str | None`. The endpoint:

1. Snapshots current values of the fields present in the patch.
2. Applies the patch (existing behavior).
3. Computes which **semantic** fields actually changed value.
4. If none changed → commit, write no event.
5. If ≥1 changed and `reason` is empty → roll back, return 422.
6. Else → commit, and `record_change` with one event (kind by priority, `before`/`after` = the changed semantic fields).

Cosmetic fields are applied and committed as today but excluded from the change computation in step 3.

### 5.2 Migration & backfill

One alembic migration (revision id ≤ 32 chars per repo constraint):

1. Create the `change_event` table, its enums, and indexes.
2. **Data step:** insert one origin event per existing `process_node` and `process_edge`:
   - `kind=create`, `actor_kind=system`, `source=migration`, `version_id` = the object's version.
   - If the object has linked claims (`NodeClaimLink` / `EdgeClaimLink`), set `reason = "Originated from claim: '<claim subject>'"` (first claim; count noted if multiple) and populate `cited_claim_ids`.
   - Otherwise `reason = "Created before provenance tracking"`, empty `cited_claim_ids`.
3. Drop the superseded `AuditEvent` and `AiInteraction` tables and remove them from `app/models/__init__.py`.

Precedent for a data-bearing migration with tests: `0009_process_inventory` / `test_inventory_migration.py`.

## 6. Item 1 — Per-object reasoning trail

**Backend.** `GET /projects/{pid}/nodes/{id}/history` and `GET /projects/{pid}/edges/{id}/history` → the object's events ordered oldest→newest, each with actor, kind, reason, cited claims (hydrated to subject + citation), `reasoning_trace` presence flag, timestamp, and source.

**Frontend.** A "History" collapsible section in `properties-panel.tsx`, beside the existing Provenance section. Each entry renders an actor icon (human / AI / system), the kind, the reason, relative time, clickable cited-claim chips (→ open the document/source viewer at the citation), and for AI entries a collapsed **"show thinking"** disclosure rendering `reasoning_trace`.

**Manual reason capture UX.** Semantic edits made through the properties panel get a small inline reason input that must be filled before the save commits. Semantic actions taken directly on the canvas (delete via keyboard, drag a node into a different lane) trigger a lightweight reason prompt. Cosmetic drags/resizes stay silent and unlogged.

## 7. Item 2 — Change log

**Backend.** `GET /projects/{pid}/models/{modelId}/log` returns *only* `change_event` rows for the model — reverse-chronological, cursor-paginated on `created_at` (the table grows unbounded). Filters: `?target_id=`, `?actor_kind=`, `?source=`, `?since=`.

**Frontend.** A new **"Change Log" tab** in `right-panel.tsx`, alongside (not merged with) Versions and Sources:

- Model-wide by default: every node/edge change with actor icon, kind/reason, cited-claim chips, and the "show thinking" disclosure for AI entries.
- Filters to the selected object when a node/edge is selected (same data as the properties-panel History, full width).
- Clicking an entry focuses the affected object on the canvas, reusing `ReviewTab`'s existing focus behavior.

The Versions tab keeps savepoints/branch/restore/diff; the Sources tab keeps documents/claims. No merging.

## 8. Item 5 — Best-practices seeding cadence

Thin layer over items 1–2 and the existing generation + reconcile machinery.

- **"Generate best-practices draft"** on an empty canvas: an action that generates a starter map from generic best-practice knowledge instead of client documents. Each generated node/edge gets an origin `change_event` (`source=generation`) whose reason flags it as a best-practice assumption, with empty `cited_claim_ids`. This realizes Emory's "if it doesn't tie to a document, the provenance says it was an assumption."
- **Additive re-ingest:** feeding a correction transcript runs through the existing claim-extraction → reconcile path **against the current map** (additive), not a from-scratch regeneration. Each accepted change accrues a `change_event` (`source=reconcile`, with `suggestion_id`), so the trail accumulates across presentation rounds.

## 9. Testing strategy

Follows existing patterns: backend `pytest` calling endpoint functions directly with the `db` fixture and patching `_get_client` for LLM calls; frontend `tsc` + Vitest. (Frontend `npm run lint` is advisory, not a gate.)

New coverage:

- **change_log service:** `record_change` writes a well-formed row inside the caller's transaction.
- **Migration backfill:** every existing node/edge gets exactly one origin event; claim-linked objects get a mined reason + cited claims; unlinked objects get the fallback reason. (Mirror `test_inventory_migration`.)
- **What-is-a-change rules (§5):**
  - semantic patch without reason → 422;
  - semantic patch with reason → one event, kind by priority, before/after = changed fields;
  - multi-field semantic patch → exactly one event;
  - cosmetic-only patch (position/bend/color/etc.) → commits, zero events, no reason needed;
  - no-op patch (value equals current) → commits, zero events;
  - claim attach/detach → link/unlink events.
- **Version branch/restore:** `copy_version` writes exactly one version-level event; cloned objects get no per-object create events.
- **Undo path:** replaying an inverse mutation writes a normal event with the "Undo of …" reason.
- **History endpoints:** ordered, hydrated, per-object.
- **Log endpoint:** filters (`target_id`/`actor_kind`/`source`/`since`) and cursor pagination.
- **Reconcile apply:** applying a suggestion writes a `change_event` with `source=reconcile` and the `suggestion_id` back-link.
- **Best-practices seeding:** generation writes origin events; re-ingest is additive (existing nodes survive, new ones get events).

## 10. Phasing

Each phase is independently shippable and testable.

1. **Backbone.** `change_event` table + enums + migration + backfill; `record_change`; wire every capture site (§4.3) with the §5 rules; retire `AuditEvent`/`AiInteraction`. Records everything; no new UI yet.
2. **Item 1 UI.** History endpoints + properties-panel History section + tiered reason capture UX.
3. **Item 2.** Log endpoint + Change Log tab.
4. **Item 5.** Best-practices generation seed + additive re-ingest wiring.

## 11. Risks & open questions

- **Missed capture sites.** The backbone's value depends on *every* semantic mutation calling `record_change`. Mitigation: audit the manual endpoints in phase 1; a test that mutates via each endpoint and asserts the expected event count would catch regressions.
- **Reason-prompt friction.** The tiered rule (§5.1) is a first cut. If consultants find the semantic prompt annoying on specific actions, the semantic/cosmetic classification is the single place to tune it.
- **`reasoning_trace` size.** Storing full extended-thinking per AI change inflates rows. Acceptable for now (low volume, high audit value); the trace is a leaf field and can be truncated or offloaded later without touching the rest of the schema.
- **Cross-version history via lineage.** Per-object history following the lineage key across branches (rather than per-version create events) keeps the table small but means the history endpoint must walk lineage to show a branched object's pre-branch trail. Phase 2 decides whether to walk lineage eagerly or show "branched from vN — see source" with a link.
- **Backfill reason quality.** Mined origin reasons are only as good as the linked claims; unlinked objects get a neutral, clearly-labeled fallback.
