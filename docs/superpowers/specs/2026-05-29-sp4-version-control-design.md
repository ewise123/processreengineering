# SP-4 — Version control (design)

_Date: 2026-05-29 · Status: design / approved-to-plan · Sub-project 4 of the Maps-UI roadmap (`docs/superpowers/specs/2026-05-28-maps-ui-roadmap-sp2-sp5.md`)._

Turns the placeholder **Versions tab** into a working history: a graphical version tree, **branch**, **restore**, and a structured **diff** between any two versions. It replaces the single read-only HEAD card and the disabled "+ Branch" button.

This sub-project mostly *wires up* foundations that already exist. A `ProcessVersion` is already a full graph snapshot (lanes/nodes/edges all FK `version_id`, with claim links hanging off nodes and edges) and already carries `parent_version_id` (a self-FK version tree), `status` (`draft/review/approved`), `notes`, and `created_by`. Only `getProcessGraph(versionId)` is exposed today; there is no list / copy / diff endpoint, and the canvas page has no version navigation.

---

## Locked decisions

From the roadmap (already locked) and this brainstorm:

1. **Snapshot-on-demand, not auto-versioning.** A version is created only when the user explicitly branches or restores. Canvas edits mutate the version in place (they already do — edits are live PATCHes); there is no staging/commit step.
2. **Branch and Restore are the same operation.** Both copy a *source* version into a brand-new version (next `version_number`, `parent_version_id` = source, `status=draft`). Non-destructive — history is never mutated. One backend endpoint backs both; the UI differs only in which source it passes and the auto-generated note.
3. **History renders as a graphical tree** (a compact git-style commit graph), not a flat list — even though most chains are linear.
4. **Diff is in scope** for this sub-project (not deferred to a follow-up).
5. **Node lineage id** is stamped to make the diff reliable (detects rename / lane-move, not just add/remove). It lives in the existing unused `ProcessNode.properties` JSONB — **no migration**.
6. **Provenance is preserved on copy.** `NodeClaimLink` and `EdgeClaimLink` rows are copied into the new version (claim ids unchanged). This is the roadmap's non-negotiable cross-cutting constraint.
7. **Merge is deferred.** No 3-way merge / cross-branch conflict resolution in this cut.

---

## Data model & migration

**No migration.** Everything needed already exists on `ProcessVersion` and the graph tables. The single new piece of per-node state is the **lineage id**, stored in `ProcessNode.properties["_lineage_id"]` as a stringified UUID.

**Lineage rule.** A node's lineage id is stamped the first time the node is persisted, seeded with its own id:
- **On copy:** the new node *inherits* the source node's `_lineage_id` (or, if the source has none — a pre-SP-4 row — seeds it with the source node's id).
- **On first creation** (`generate_process_map` and manual `create_node`): stamp `_lineage_id = str(node.id)` after the flush that assigns the id. This keeps lineage universal for all SP-4-era nodes.

So every descendant of a node shares one stable identity across versions. That identity is what lets the diff say "renamed" / "moved lane" instead of "removed + added."

- **Edges** need no lineage id of their own — an edge is identified by its endpoints' lineage pair `(source_lineage, target_lineage)`.
- **Lanes** are matched by `name` (lane rename detection is out of scope; lanes are add/remove only).
- **Pre-SP-4 nodes** (no `_lineage_id`) fall back to name-matching in the diff.

A copied version starts with a **fresh review slate** for free: SP-3 per-node `Review` rows are keyed by the (new) node id and the version-level request is keyed by `version_id`, so neither carries into the copy. No code needed.

---

## Backend — new `app/api/v2/versions.py` router

A dedicated router (mirroring the SP-3 `reviews.py` split) keeps the already-large `process_maps.py` from growing. Prefix `/projects/{project_id}`, tags `["versions"]`, registered in `app/api/v2/__init__.py`. All endpoints validate that the model belongs to the project and the version(s) belong to the model (404 otherwise), reusing the existing `get_project_or_404` dependency and the model/version lookup pattern already in `process_maps.py`.

### `GET /process-maps/{model_id}/versions`

Returns `list[VersionSummaryRead]` for the model, ordered by `version_number` ascending. Each row:

```
{ id, version_number, parent_version_id, status, notes, created_at,
  node_count, lane_count, edge_count }
```

Counts are computed with three grouped queries (`func.count` grouped by `version_id`, filtered to the model's version ids) — no N+1. The frontend builds the tree from `parent_version_id`.

### `POST /process-maps/{model_id}/versions/{source_version_id}/copy`

Body: `VersionCopyRequest { note: str | None }`. Returns the new `ProcessVersionRead`. This single endpoint backs **both Branch and Restore**.

One transaction:
1. `next = max(version_number for model) + 1`.
2. New `ProcessVersion(model_id, version_number=next, parent_version_id=source_version_id, status=draft, notes=note, bpmn_xml=source.bpmn_xml, created_by=<dev user>)`. `generated_by_job_id` and `source_segment_id` are left null (this version was authored by copy, not by a generation job). If `note` is null, default to `"Copied from v{source.version_number}"`.
3. Copy in dependency order, building old→new id maps:
   - **lanes** — same `name / entity_id / order_index / height_px / color / collapsed`; map `old_lane_id → new_lane_id`.
   - **nodes** — same `type / name / position`; `lane_id = lanemap[old]`; `properties = {**source.properties, "_lineage_id": source.properties.get("_lineage_id") or str(old_node.id)}`; map `old_node_id → new_node_id`.
   - **edges** — `source_node_id / target_node_id = nodemap[old]`; same `label / condition_text / condition_claim_id / bend_x / bend_y`; map `old_edge_id → new_edge_id`.
   - **`NodeClaimLink`** — for each link on a copied node: `node_id = nodemap[old]`, same `claim_id / link_kind`.
   - **`EdgeClaimLink`** — for each link on a copied edge: `edge_id = edgemap[old]`, same `claim_id / link_kind`.
4. Commit; return the new version.

Branching from any version (including `approved`) is allowed — no status restriction. The source is never modified.

### `GET /process-maps/{model_id}/versions/diff?from={vA}&to={vB}`

Returns `VersionDiffRead`. Both versions must belong to the model (404 otherwise). Algorithm:

- Build an **identity key** per node: `_lineage_id` if present, else `f"name:{name}"`. Build identity→node maps for each side.
- Resolve each node's lane id to its lane **name** within its own version (for move detection).
- **nodes:**
  - `added` = identities in B not in A
  - `removed` = identities in A not in B
  - `renamed` = identity in both, different `name`
  - `moved` = identity in both, different lane name
  - `unchanged_count` = identity in both, same name and lane
- **edges:** key = `(source_identity, target_identity)`. `added` = in B not A; `removed` = in A not B.
- **lanes:** by name. `added` = names in B not A; `removed` = names in A not B.

Returned lists carry enough to render (e.g. node `{name, from_name?, from_lane?, to_lane?}`), kept summary-level — this is a structured list diff, not a rendered canvas overlay.

### Schemas — `app/schemas/version.py`

`VersionSummaryRead`, `VersionCopyRequest`, `VersionDiffRead` (+ nested `NodeChange`, `EdgeChange`, `LaneChange`). Mirrors the `schemas/review.py` split from SP-3.

### Small touch to `process_maps.py`

Stamp `_lineage_id` on node creation in `generate_process_map` (after the existing `db.flush()` at line ~304) and in `create_node` (after its flush), so all newly-authored nodes carry lineage. One line each.

---

## Frontend

### Types & API client

- **`src/lib/types.ts`** — `VersionSummary`, `VersionDiff` (+ `NodeChange`, `EdgeChange`, `LaneChange`).
- **`src/lib/api.ts`** — `listVersions(projectId, modelId)`, `copyVersion(projectId, modelId, sourceVersionId, note)`, `getVersionDiff(projectId, modelId, fromId, toId)`. URLs verified char-for-char against the router.

### `src/components/canvas/version-tree.ts` (new, pure, unit-tested)

From the flat `VersionSummary[]` build the parent/child tree and assign each version a **column** for the commit-graph rail:
- a child stays in its parent's column;
- a parent's *second* (and later) child takes a new column.

Linear history → a single column. Forks add columns. Output: rows in `version_number` order with `{version, column, parentColumn}` so the rail can draw dots and connector lines. This is the piece that gets isolated unit tests (linear chain, single fork, multi-fork).

### `VersionsTab` rewrite (`src/components/canvas/right-panel.tsx`)

- react-query `["versions", projectId, modelId]` → `listVersions`.
- Render a compact **git-style graph**: an SVG rail (dots + connector lines positioned by column) beside row cards. Each card: `vN`, status badge, `latest` badge (highest `version_number`), note, timestamp, node count. The **currently-viewed** version (`versionId` from the route) is highlighted.
- **Row actions:**
  - **Open** — navigate to that version (skipped on the current row).
  - On the **current** row: **Branch** → `copyVersion(currentId, "Branched from vN")`.
  - On **other** rows: **Restore** → `copyVersion(thatId, "Restored from vN")`.
  - Both call the same endpoint, then navigate to the new version.
  - The dead toolbar **"+ Branch"** is wired to branch-from-current.
- **Compare / diff:** a row's **"Diff vs current"** action expands an **inline** panel (no modal) showing the structured changes — added / removed / renamed / moved nodes, with edge and lane add/remove counts. Fetched via `getVersionDiff(thatId, currentId)`.

`RightPanel` already receives `projectId` / `modelId` / `versionId`; the tab adds its own query + mutations. Review/issues query keys are untouched.

### `page.tsx` (`src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx`)

- Add `useRouter` (the page currently imports only `useParams`).
- On a successful copy: invalidate `["versions", id, modelId]` and `router.push` to `/projects/{id}/maps/{modelId}/versions/{newVersionId}`.
- The route param change re-runs the graph / issues / review queries automatically (all keyed by `versionId`), so the canvas renders the new version with no extra wiring.
- The maps-list entry point (`latest_version_id` = max `version_number`) naturally follows to the newest snapshot after a branch/restore — consistent, no change needed.

---

## Testing

**Backend — `backend/tests/test_version_control.py`:**
- list returns all versions for the model with correct node/lane/edge counts, ordered.
- copy: new version has next `version_number`, `parent_version_id` = source, `status=draft`; lane/node/edge counts match source.
- copy preserves provenance: `NodeClaimLink` + `EdgeClaimLink` copied with unchanged `claim_id`, remapped owner ids.
- lineage: seeded on a pre-lineage source's copy; **inherited** unchanged across two successive copies (stable identity).
- restore (copy from an older version) sets `parent_version_id` to that older version.
- diff: detects `added` / `removed` / `renamed` (same lineage, new name) / `moved` (same lineage, new lane); edge add/remove via endpoint identity; lane add/remove by name.
- diff name-fallback when `_lineage_id` is absent on both sides.
- 404s: copy / diff referencing a version not in the model.
- copied version has no per-node `Review` rows (fresh slate sanity check).

**Frontend — Vitest:**
- `version-tree.ts` column assignment for linear, single-fork, and multi-fork histories.
- diff-summary rendering helper (counts/labels) from a `VersionDiff` fixture.

**Gates:** `npx tsc --noEmit`, `npm test` (Vitest), `npm run build`, backend `pytest`, manual `./run-local.sh` smoke: branch from current → edit the copy → restore an older version → diff two versions. Lint is advisory (see [[frontend-lint-baseline]]); after adding the backend migration-free work there is nothing to `alembic upgrade`, but if a later task does add a migration, remember the dev `poet` DB must be upgraded or the hot-reloading backend 500s (see [[dev-db-migration-on-reload]]).

---

## Out of scope

- **Merge / 3-way conflict resolution** and cross-branch reconciliation.
- **Per-version BPMN-XML regeneration** — the copy carries the source's cached `bpmn_xml` as-is.
- **A visual side-by-side canvas diff** — this cut ships a structured *list* diff, not a rendered overlay on the canvas.
- **Deleting / pruning versions.**
- **Lane rename detection** in the diff — lanes are add/remove by name only.
- **Named branches / branch labels** — branches exist structurally via `parent_version_id` but carry no name beyond their version number + note.

---

## File-change summary

**Backend**
- `app/api/v2/versions.py` — **new** router (list / copy / diff + helpers).
- `app/api/v2/__init__.py` — register the router.
- `app/schemas/version.py` — **new** schemas.
- `app/api/v2/process_maps.py` — stamp `_lineage_id` in `generate_process_map` + `create_node` (one line each).
- `backend/tests/test_version_control.py` — **new** integration tests.

**Frontend**
- `src/lib/types.ts` — version + diff types.
- `src/lib/api.ts` — `listVersions` / `copyVersion` / `getVersionDiff`.
- `src/components/canvas/version-tree.ts` (+ `.test.ts`) — **new** tree/column helper.
- `src/components/canvas/right-panel.tsx` — `VersionsTab` rewrite (graph + actions + inline diff).
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — `useRouter`, copy mutation, navigation, `["versions"]` invalidation.
