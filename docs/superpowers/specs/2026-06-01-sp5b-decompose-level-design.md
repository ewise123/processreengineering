# SP-5b — Decompose-to-next-level (child ProcessModel + cross-level navigation) — Design

_Date: 2026-06-01 · Status: approved design / ready for plan · Sub-project SP-5b of the Maps-UI roadmap._

Pairs with:
- `docs/superpowers/specs/2026-06-01-sp5a-ai-edit-step-design.md` (SP-5a — the AI-edit framework + four node-local actions this extends)
- `docs/superpowers/specs/2026-05-29-sp4-version-control-design.md` (version tree + diff/restore that the re-decompose flow rides on)
- `docs/superpowers/specs/2026-05-28-maps-ui-roadmap-sp2-sp5.md` (umbrella roadmap; SP-5 section)
- `docs/spec/process-reengineering-spec-v1.1.md` §5.1.4 ("decompose to next level" in the long-term AI-assist menu)

---

## What this is

The fifth and final SP-5 AI-edit action: **Decompose**. On a selected step, the AI proposes the finer sub-steps that compose it, grounded in that step's claims plus its immediate neighbors'. On **Accept**, SP-5b materializes a **child `ProcessModel`** one level deeper, links it to the parent step, and lets the user drill between levels (subprocess `+` marker → double-click in, breadcrumb out).

This is **SP-5b**, a stacked PR on top of SP-5a. SP-5a shipped relabel / describe / validate / suggest-next (all node-local, single-version). SP-5b is the only SP-5 action that crosses model and level boundaries, so it gets its own brainstorm → spec → plan → PR.

### Decisions locked during the brainstorm

- **Grounding scope:** the selected node's claims **plus its immediate upstream/downstream neighbors'** (one edge hop). Tighter than SP-5a suggest-next's project-wide scope; the sub-steps are the fine detail of *this* step in local context.
- **Engine:** **forced-tool propose-then-apply** (SP-5a-consistent), not the auto-committing generation pipeline and not an empty shell. The AI proposes; the user accepts; nothing is auto-applied.
- **Navigation:** a subprocess **`+` marker** on decomposed steps, **double-click** to drill in, and a **breadcrumb** to drill up. BPMN-conventional and discoverable.
- **Level cap:** decompose is offered only on **L1–L3** steps; disabled at L4 (the generation prompt and request schema define only 1–4). The apply endpoint guards too.
- **Re-decompose:** running Decompose again on an already-decomposed step **appends a new `ProcessVersion` to the existing child model** — history preserved; reconcile old vs. re-generated via SP-4's existing diff/restore. No in-place merge.
- **Provenance:** child sub-step nodes are marked `ai_proposed` and rendered visibly distinct, with `ai_proposed` claim links — non-negotiable (roadmap-locked). The decomposed **parent** node is *not* marked (it already exists and is sourced).

---

## Foundations this builds on (already in the codebase)

- **The hierarchy is already modeled.** `ProcessModel.parent_model_id` (self-FK, `ondelete=SET NULL`) and `ProcessModel.level` (canonical `L1`–`L4` via `_normalize_level`) exist (`backend/app/models/process.py`). A child map *is* a `ProcessModel` with `parent_model_id` set and `level` one deeper. No new tables, no migration.
- **`ProcessNode.properties` JSONB is free.** It already holds `_lineage_id` (SP-4), `description` and `ai_proposed` (SP-5a). SP-5b stores `child_model_id` the same way — no migration.
- **The SP-5a AI-edit framework.** `map_ai_edit.py` (forced-tool-per-action, guardrail prompt, claim-ref hygiene), the `ai-edit` propose endpoint and its dispatcher, the proposal-card UI, `useAiEditNode` cache + shimmer loading, and the `ai_proposed` rendering (`shapes.tsx`) all exist. SP-5b adds one action to each layer rather than inventing them.
- **SP-4 versioning.** `ProcessVersion` is a version tree (`parent_version_id`) and diff/restore already exist. Re-decompose just appends a child version; reconciliation reuses SP-4.
- **The generation persist shape.** `generate_process_map` (`process_maps.py:115`) shows the canonical way to persist a structure: dedupe roles → lanes (document order), build the ordered element list, create nodes + a linear edge chain, attach claim links. SP-5b's apply borrows this *shape* without the auto-commit-on-generate semantics.

---

## Architecture & data model

**The links (no migration).**

- **Child model:** `ProcessModel(parent_model_id = parent.model_id, level = next_level(parent.level), name = parent step label)`. A new `_next_level("L3") -> "L4"` helper sits beside `_normalize_level`.
- **Node → child:** the decomposed parent `ProcessNode.properties["child_model_id"] = <child model uuid>` (merge + `flag_modified`, same as SP-5a's `description`).
- **Child → parent (breadcrumb):** *reverse lookup*, no new column. From a child map: `parent_model_id` → parent model → the node in the parent's **latest** version whose `properties["child_model_id"]` equals this child model. That yields the parent step's label and a deep-link target. If the match isn't found (an edge case after certain restores that predate the decompose), the breadcrumb still links to the parent map without focusing a node. This is the explicit reason we do **not** add `ProcessModel.parent_node_id` + a migration.

**Parent-node marking.** The decomposed step keeps its original `NodeType` — it is **not** re-typed to `subprocess`. The canvas renders a subprocess **`+` marker** purely from `properties["child_model_id"]` being present. This is reversible, non-destructive (no type churn, no type-change undo), and the marker drives double-click drill-in. The parent node is **not** `ai_proposed` (it already exists and is claim-grounded; decompose adds a child link, not a new sourced step — same reasoning as SP-5a relabel/describe).

**Level math & cap.** Decompose is offered only when the parent model's `level ∈ {L1, L2, L3}`. At L4 the menu item is disabled with a tooltip ("Already at the most detailed level"). The apply endpoint guards independently (422) so the cap can't be bypassed by a crafted request.

---

## Backend

### New service tool — `backend/app/services/map_ai_edit.py`

A fifth forced tool alongside the existing four:

```python
DECOMPOSE_TOOL = {
  "name": "propose_decompose",
  "description": "Break the selected step into the finer sub-steps that compose it, grounded in the sources.",
  "input_schema": {
    "type": "object",
    "properties": {
      "sub_steps": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "proposed_name": {"type": "string"},
            "proposed_type": {"type": "string", "enum": _NODE_TYPES},
            "role": {"type": "string", "description": "Actor/system performing this sub-step; becomes a child-map lane."},
            "edge_label": {"type": ["string", "null"]},
            "rationale": {"type": "string"},
            "cited_claim_refs": _CITED,
          },
          "required": ["proposed_name", "proposed_type", "role", "rationale", "cited_claim_refs"],
        },
      }
    },
    "required": ["sub_steps"],
  },
}
```

`_ACTION_INSTRUCTIONS["decompose"]`: *"Break the selected step into the concrete sub-steps that compose it — the level of detail one tier finer. Order them as they flow. Use only what the sources support; if they don't support a breakdown, return an empty array rather than inventing one."* Plus `propose_decompose(*, map_context_text, selected_label)` mirroring the other public fns. Same `AI_EDIT_MODEL` / `MAX_TOKENS` / 60s timeout / `_get_client` posture.

### Propose — extend the existing dispatcher

`POST /process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/ai-edit` gains the `decompose` action. Two differences from SP-5a actions:

- **Grounding scope = node + neighbors.** Before resolving refs, gather the selected node plus the nodes one edge hop upstream/downstream (via this version's edges) and union their claim refs. The hygiene filter keeps only surviving refs in that set (tighter than SP-5a suggest-next's project-wide scope).
- **L4 guard:** 422 if the parent model's `level` is already L4.

Returns a `DecomposeProposal` (ordered sub-steps, each carrying rationale + surviving cited claim UUIDs). 404 chain and 502-on-no-key are inherited from the existing endpoint. No mutation.

### Apply — new endpoint

`POST /process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/decompose`

Body: `DecomposeRequest` — the accepted `sub_steps` (name, type, role, edge_label, cited_claim_ids). One transaction:

1. **Find-or-create** the child `ProcessModel` (`parent_model_id`, `level = next_level`, `name = parent label`). First decompose creates it; re-decompose reuses the one referenced by `parent.properties["child_model_id"]`.
2. Append a new `ProcessVersion`: `version_number = max(child versions) + 1`, `parent_version_id` = the child's current latest (or `None` on first). **This is how re-decompose = new child version** — SP-4 diff/restore reconcile old vs. re-generated.
3. Persist the proposal: lanes (one per distinct `role`, document order, falling back to a single "Process Team" lane if none); nodes (each `properties = {"ai_proposed": true, LINEAGE_KEY: <own id>}`); a linear edge chain (sub-step *i* → *i+1*) carrying each sub-step's `edge_label`; and `ai_proposed` `NodeClaimLink` rows for each `cited_claim_id` that resolves to a real claim in scope (foreign ids ignored — defense in depth on top of the propose-side hygiene).
4. Set parent `node.properties["child_model_id"]` (merge + `flag_modified`).
5. Return `{child_model_id, child_version_id}` for navigation.

Re-filter cited claims on apply to the **node+neighbor** scope (matching what propose presented) — unlike SP-5a suggest-next, which re-filters to project scope.

### Ancestry — new endpoint (breadcrumb)

`GET /process-maps/{model_id}/ancestry` → ordered `[{model_id, version_id, level, label}]` from root to this map. Walks `parent_model_id` upward; for each parent, resolves the decomposed step's `label` via the reverse lookup above and the deep-link `version_id` = that ancestor's latest version. A root map (no parent) returns a single-element chain (or the frontend simply renders nothing).

### Remove sub-process — apply path for reversal

`DELETE /process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/decompose` (or a small dedicated route): **soft-deletes** the child model (sets `deleted_at`, so it drops out of the maps list via the existing `deleted_at.is_(None)` filter) and clears the parent node's `child_model_id`. The child's graph rows (versions/lanes/nodes/edges/links) are *not* hard-deleted — they simply become unreachable once the model is soft-deleted, consistent with how `ProcessModel`'s `SoftDeleteMixin` works elsewhere. This is the explicit reversal (see Frontend → Reversal).

### Schemas — `backend/app/schemas/version_ai_edit.py`

- `SubStep` (proposed_name, proposed_type∈`NodeType`, role, edge_label?, rationale, cited_claim_ids) and `DecomposeProposal{sub_steps: list[SubStep]}` — propose response.
- `DecomposeRequest{sub_steps: list[SubStep]}` — apply body (the accepted steps; `SubStep.cited_claim_ids` are resolved UUIDs at this point).
- `DecomposeResult{child_model_id, child_version_id}` — apply response.
- `AncestryCrumb{model_id, version_id, level, label}` and the `list[AncestryCrumb]` response.
- `AiEditAction` gains `DECOMPOSE`; `AiEditResponse` gains an optional `decompose: DecomposeProposal | None`.
- `proposed_type` constrained via the existing `_NODE_TYPE_PATTERN`; `role`/`proposed_name`/`edge_label` length-bounded as in SP-5a.

---

## Frontend

**Action menu + proposal cards.** The Properties AI-edit popover (SP-5a) gains **Decompose into sub-steps**, disabled-with-tooltip when the model is at L4. It fires the propose call through the existing `useAiEditNode` cache and shows the SP-5a shimmer loading skeleton. Results render as a **decompose card**: the ordered sub-steps (name · type · lane) with rationale + cited-claim chips, plus **Accept / Reject**. When the node already has `child_model_id`, the card header notes "Creates v_N+1 of the existing sub-process; the current version is kept in history." Reject dismisses; the card clears on selection change (SP-5a behavior).

**On Accept → navigate.** Accept calls the apply endpoint, then routes to the child version (`/projects/[id]/maps/{child_model_id}/versions/{child_version_id}`) so the user lands in the freshly generated sub-process to review and edit it. A toast confirms. On returning to the parent, the step shows the `+` marker.

**Cross-level navigation.**

- **`+` marker:** `CanvasNode` gains `hasChild?: boolean` (mapped in `layout.ts` from `properties.child_model_id`). `shapes.tsx` draws a small boxed `+` at bottom-center (BPMN collapsed-subprocess convention), lowest precedence vs. selected / issue / ai-proposed styling.
- **Double-click to drill in:** the canvas double-click handler, when the node `hasChild`, routes to the child model's latest version. Single-click still selects (no change).
- **Breadcrumb:** a new `<LevelBreadcrumb>` in the top floating bar, fed by the ancestry endpoint, renders `Root ▸ … ▸ This map`; each crumb links to that ancestor's latest version. Root maps render no breadcrumb — zero change to existing single-level maps.

**Reversal.** Decompose-accept is **not** on the canvas Ctrl+Z stack — it spans models and triggers navigation, where an inline undo entry would be confusing. Instead, a decomposed parent node's Properties shows a **"Remove sub-process"** control that calls the remove endpoint (soft-deletes the child model so it leaves the maps list, clears `child_model_id`) and drops the `+` marker. One place, explicit, reversible.

**API client / types.** New fns in `src/lib/api.ts`: `applyDecompose(projectId, modelId, versionId, nodeId, subSteps)`, `getMapAncestry(projectId, modelId)`, `removeSubProcess(projectId, modelId, versionId, nodeId)`; `aiEditNode` already takes an `action`, extended to accept `"decompose"`. New types in `src/lib/types.ts` mirroring the schemas.

---

## Provenance (the rendering contract)

- Child sub-step **nodes** carry `properties["ai_proposed"] = true` → the SP-5a dashed/violet/✦ treatment, with `ai_proposed` `NodeClaimLink`s for grounded steps and an empty provenance list for pure-inference steps (still visibly distinct via the node flag).
- The decomposed **parent** node is unmarked — existing, sourced; it only gains the `+` child marker.
- This satisfies the roadmap's non-negotiable across the level boundary: AI-created steps **carry `link_kind = ai_proposed`** (when grounded) **and render visibly distinct** (always).

---

## Testing

**Binding gates** (per roadmap): `tsc --noEmit`, `npm test` (Vitest), backend `pytest`. Lint is advisory ([[frontend-lint-baseline]]).

**Backend (pytest):**
- Service unit test: mocked Anthropic client returns a canned `propose_decompose` tool-use block → parses into `DecomposeProposal`; no-key path raises.
- Propose-endpoint tests: **node+neighbor claim-ref hygiene** (a ref outside the node+neighbor set is dropped); **L4 → 422**; 404 chain (bad project/model/version/node); 502 with no key.
- Apply tests: first decompose **creates the child model** (`parent_model_id`, `level = next_level`, `name = parent label`) **+ v1**, sets parent `child_model_id`, sub-steps have `ai_proposed` true + seeded `_lineage_id`, `ai_proposed` links only for cited real claims (foreign ids ignored); **re-decompose appends v2 to the same child model** (version_number increments, parent_version_id chains, `child_model_id` unchanged).
- Ancestry-endpoint test: a 3-level chain returns root→leaf with resolved labels and latest-version deep-links; reverse-lookup miss degrades to a parent-map link without a node label.
- Remove-sub-process test: soft-deletes the child model and clears the parent `child_model_id`.
- Describe/SP-5a regression: the existing `ai-edit` actions still dispatch unchanged after the `decompose` branch is added.

**Frontend (Vitest — node-env / pure-logic, per the project's convention; no `.test.tsx`):**
- `hasChild` derivation from `properties.child_model_id`.
- Breadcrumb chain builder (root→leaf ordering; root map yields no crumbs).
- Decompose card accept/reject state (accept clears the card; reject dismisses).

Canvas marker rendering and double-click drill-in are verified by `tsc --noEmit` + live smoke (no component test — matches the established no-`.test.tsx` convention for canvas components).

**Live smoke (best-effort, not a gate)** against `./run-local.sh` with a real `ANTHROPIC_API_KEY` (local `.env` keys are typically blank, so this is a documented manual checklist): decompose an L2 step → land in the child map → return and see the `+` marker → double-click drills in → breadcrumb drills up → re-decompose makes child v2 → "Remove sub-process" clears the marker and the child.

---

## Out of scope (→ later)

- In-place **merge** of a re-generated child graph with the user's hand-edits (reconcile via SP-4 diff/restore instead).
- Auto-propagating a parent label/claim edit down into an existing child, or rolling child sub-steps back up into the parent summary.
- **L5+** / relaxing the 1–4 level convention.
- BPMN-XML regeneration for child versions (the child's `bpmn_xml` is left null on AI-decompose, as canvas edits already don't regenerate XML).
- Streaming / background AI (no workers exist).
- Multi-node or whole-map decomposition in one call.

---

## Open risks / notes for the plan

- **Reverse-lookup correctness across restores.** The child→parent breadcrumb assumes the parent's *latest* version still carries `child_model_id` on the decomposed node. SP-4 branch/restore copy node `properties` forward, so this holds for normal flows; a restore of a version predating the decompose is the documented degradation (breadcrumb → parent map without node focus). The plan should add the reverse-lookup-miss test.
- **Blocking latency.** Decompose is one synchronous Claude call returning several sub-steps — larger than SP-5a's single-node actions. Keep `MAX_TOKENS` modest; the shimmer skeleton must cover it.
- **Forced-tool reliability.** A malformed/empty `propose_decompose` input returns an empty `sub_steps` (no 500), surfaced as "the sources don't support a breakdown" — mirror SP-5a's empty-proposal handling.
- **Child model name collisions.** Find-or-create keys the child on `parent.properties["child_model_id"]`, not on name — two sibling steps with the same label get distinct child models. Do **not** reuse the generation path's `(project, level, name)` find-or-create here.
- **`level` column width.** `ProcessModel.level` is `String(4)`; `L1`–`L4` fit. The L4 cap keeps it inside that bound.
