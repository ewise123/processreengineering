# SP-5a — AI edit-this-step (node-local actions) — Design

_Date: 2026-06-01 · Status: approved design / ready for plan · Sub-project SP-5a of the Maps-UI roadmap._

Pairs with:
- `docs/superpowers/specs/2026-05-28-maps-ui-roadmap-sp2-sp5.md` (umbrella roadmap; SP-5 section, p.119–137)
- `docs/superpowers/specs/2026-05-29-sp4-version-control-design.md` (the immediately prior sub-project; same no-migration "store in `properties` JSONB" approach)
- `docs/spec/process-reengineering-spec-v1.1.md` §5.1.4 (long-term Properties panel + AI-assist menu this is the first concrete slice of)

---

## What this is

Wire the disabled **"Ask AI to edit this step"** button (`src/components/canvas/properties-panel.tsx:237`) to a small **action menu** of grounded, propose-then-apply AI actions for the selected node. The AI proposes; the user accepts or rejects; nothing is ever auto-applied. AI-created steps are marked `ai_proposed` and rendered visibly distinct from claim-grounded steps.

This is **SP-5a** — the AI-edit framework plus four **node-local** actions. The fifth action, **decompose-to-next-level** (which creates a child `ProcessModel` and needs cross-level navigation), is **SP-5b**: its own brainstorm → spec → plan → stacked PR.

### Decisions locked during the brainstorm

- **Capability set:** the broad §5.1.4 menu, split for delivery. SP-5a ships **relabel, describe, validate-completeness, suggest-next-step**. SP-5b ships decompose.
- **Invocation:** an **action menu** — the button opens a popover of the four actions; clicking one fires a **focused, per-action** call. Each blocking Claude call stays small (fits the no-streaming / no-worker constraint).
- **Apply model:** **propose-then-apply, never auto-apply** (roadmap-locked).
- **Structural depth:** suggest-next-step inserts an `ai_proposed` node + edge **inline in the current version's graph**. No child `ProcessModel` in SP-5a.
- **Provenance:** AI output is marked `ai_proposed` and rendered distinct — **non-negotiable** (roadmap-locked).
- **Packaging:** SP-5a and SP-5b are **separate stacked PRs**; SP-5a is usable on its own.

---

## Foundations this builds on (already in the codebase)

- **Grounding context renderer.** `backend/app/services/map_chat.py:build_map_context()` already renders lanes/nodes/edges + claims (with `kind`, `subject`, and the first verbatim citation quote + source name) into a compact text block with short ids (L1/N1/E1/C1) the model can cite back. The chat endpoint (`process_maps.py:1087`) already assembles all of this for a version, including a "Currently selected" label. SP-5a reuses both rather than re-deriving them.
- **Guardrail prompt rules.** `map_chat.py:SYSTEM_PROMPT` already encodes: ground every substantive claim in sources and cite the claim id; no sycophancy; say "the sources don't say" rather than guess; use general process knowledge sparingly and only as a flagged question. SP-5a's per-action prompts reuse these rules verbatim.
- **Provenance marking hook.** `ClaimLinkKind.AI_PROPOSED` (`backend/app/enums.py:110`) exists and is currently unused — added precisely for this feature.
- **`properties` JSONB is free.** `ProcessNode.properties` is an open JSONB column already returned by `ProcessNodeRead`. SP-4 stores `_lineage_id` there with no migration; SP-5a stores `description` and `ai_proposed` the same way.
- **Node/edge mutation + undo plumbing.** `create_node` / `update_node` / `create_edge` / `delete_node` endpoints exist (`process_maps.py:478/518/570/668`). Edges FK their endpoints with `ondelete=CASCADE`, so deleting a node removes its edges — undo of an inserted step is a single node delete. SP-1/SP-2 established the canvas undo stack (`use-undo-stack.ts`) and the Properties `onUpdate` path.

---

## Actions & apply semantics

| Action | The AI returns | Accept does | Undo |
|---|---|---|---|
| **Relabel** | `{proposed_name, rationale, cited_claim_refs}` | `PATCH /nodes` with the new name (existing path) | existing rename undo entry |
| **Describe** | `{proposed_description, rationale, cited_claim_refs}` | `PATCH /nodes` writing `properties["description"]` | revert description to prior value |
| **Validate completeness** | `{gaps: [{summary, severity, cited_claim_refs}]}` | **advisory — read-only, no Accept** | n/a |
| **Suggest next step** | `{steps: [{proposed_name, proposed_type, edge_label, rationale, cited_claim_refs}]}` | atomically create a new node + edge marked `ai_proposed`; create `ai_proposed` claim links for any cited real claims | delete the new node (edge cascades) |

`severity` for validate gaps ∈ `{low, medium, high}`. `proposed_type` is constrained to the existing `NodeType` set.

**Relabel and Describe do NOT mark the node `ai_proposed`.** The node already exists and is (usually) claim-grounded; an AI-assisted rename or description is a field edit, not a new sourced step. The `ai_proposed` marking applies only to **steps the AI creates** (suggest-next-step), where the provenance risk actually lives.

---

## Backend

### New service: `backend/app/services/map_ai_edit.py`

- Reuses `build_map_context()` from `map_chat.py` for the grounding block (do not duplicate the renderer).
- One function per action. Each calls Anthropic with **tool-use and a single forced tool** (`tool_choice={"type": "tool", "name": ...}`) whose `input_schema` is that action's proposal shape — so the model must return structured JSON, never prose. The per-action system prompt = the map-chat guardrail rules + the action's specific instruction (e.g. relabel: "propose a clearer, source-faithful label for the selected step; cite the claim ids that justify it; if the current label is already faithful, say so and propose no change").
- Same env/timeout posture as `map_chat.chat()`: read `ANTHROPIC_API_KEY`, raise `RuntimeError` when unset, 60s timeout. Model from an env var (`MAP_AI_EDIT_MODEL`, default `claude-sonnet-4-6`), mirroring `CHAT_MODEL`.
- Returns plain dataclasses/dicts of proposals; the **endpoint** owns claim-ref resolution and DB access (the service stays I/O-free except the Anthropic call, so it's unit-testable with a mocked client).

### New endpoint: propose

`POST /process-maps/{model_id}/versions/{version_id}/nodes/{node_id}/ai-edit`

- Body: `{action: "relabel" | "describe" | "validate" | "suggest_next"}`.
- Validates project → model → version → node ownership (404 chain mirrors `chat_with_map`).
- Builds the same grounding context the chat endpoint builds (lanes/nodes/edges/claims with citation quotes + a selected-node label), calls the matching service function, then **resolves cited claim refs**: the model cites short refs (C1, C2…); the endpoint maps them back to real claim UUIDs **and drops any ref that is not among the project's claims presented in the grounding context**. (Scope is the project's claims, not only those already attached to a node in this version — a suggested next step must be able to cite a real project claim that no node carries yet. The apply endpoint re-filters to project-scoped claims as a second guard.) The model cannot fabricate provenance — only real, in-scope claim ids survive into the response.
- Returns the typed proposals (per `VersionAiEdit*` schemas below), each proposal carrying its surviving cited claim UUIDs.
- 502 when `ANTHROPIC_API_KEY` is unset (same contract as chat).
- No mutation. This endpoint only proposes.

### Apply paths

- **Relabel** → existing `PATCH /nodes/{id}` with `name`. No new backend.
- **Describe** → extend `NodeUpdate` with `description: str | None`; when present, `update_node` writes `node.properties["description"]` (merge, `flag_modified`). No migration.
- **Suggest-next-step** → **new** `POST /process-maps/{model_id}/versions/{version_id}/ai-proposed-step`:
  - Body: `{source_node_id, name, type, lane_id, x, relative_y, edge_label, cited_claim_ids}`.
  - In one transaction: create the node with `properties = {"ai_proposed": true, LINEAGE_KEY: <own id>}`; create the edge `source_node_id → new node`; for each `cited_claim_id` that is a real claim in the project, create a `NodeClaimLink(node=new, claim, link_kind=ai_proposed)`. Foreign/unknown claim ids are ignored (defense in depth — the propose endpoint already filters).
  - Returns the created node + edge (`ProcessNodeRead` + `ProcessEdgeRead`) so the canvas refreshes and the undo entry can target the new node id.
  - Undo = `DELETE`/`delete_node` of the new node; the edge and claim links cascade.

### Schemas (new, `backend/app/schemas/`)

A new `version_ai_edit.py` (or a section in an existing schema module) defining: `AiEditRequest` (the action enum); per-action proposal reads (`RelabelProposal`, `DescribeProposal`, `ValidateGap` + `ValidateProposal`, `SuggestedStep` + `SuggestNextProposal`); the union response `AiEditResponse`; and `AiProposedStepRequest` for the apply endpoint. Each proposal includes `rationale: str` and `cited_claim_ids: list[UUID]`.

---

## Provenance marking (the rendering contract)

- An AI-created **node** carries `properties["ai_proposed"] = true`. The canvas renders it visually distinct — dashed border + a sparkle/accent treatment — clearly unlike a sourced step.
- The connecting **edge** has no `properties` column (see `ProcessEdge` in `models/process.py`), so it does **not** store a flag. It inherits the dashed/accent styling **at render time from its `ai_proposed` endpoint(s)**. No edge schema change.
- When the suggestion is claim-grounded, `NodeClaimLink(link_kind=ai_proposed)` rows record the grounding and show up in the node's provenance list distinctly from `supports`/`partial`/`inferred` links. When the suggestion is pure inference (the model cited nothing real), only the node flag marks it — still visibly distinct, just with an empty provenance list.

This satisfies both halves of the roadmap's non-negotiable: AI steps **carry `link_kind = ai_proposed`** (when grounded) **and render visibly distinct** (always, via the node flag).

---

## Frontend

- **Button → popover menu.** Replace the disabled button (`properties-panel.tsx:237`) with a popover of the four actions. Each menu item fires the propose call for its action and shows a loading state.
- **Proposal cards.** Results render in an expandable section of the Properties panel: the proposed value, the `rationale`, **cited-claim chips** (reusing the existing claim/citation display style), and **Accept / Reject** controls. Validate-completeness cards are **read-only** (gaps with severity, no Accept). Accept applies via the matching path, records an undo entry, and clears the card; Reject dismisses it.
- **Description field.** Add a **Description** field to the Properties panel (display + manual edit of `properties["description"]`). This gives "Describe" output a home and lets the user see/tweak it. It is the only §5.1.4 property added in SP-5a.
- **`ai_proposed` rendering.** Thread an `aiProposed` flag onto `CanvasNode` from `properties`; the node renderer applies the distinct styling and the edge renderer derives its styling from whether either endpoint is `aiProposed`.
- **API client.** New fns in `src/lib/api.ts`: `aiEditNode(projectId, modelId, versionId, nodeId, action)`, `applyAiProposedStep(...)`; add `description` to the node-update fn. New types in `src/lib/types.ts` mirroring the proposal schemas.
- **Selection reset.** Like the existing change-note reset, clear any open proposal cards when the selection moves to another node (cards must not leak across nodes).

---

## Testing

**Binding gates** (per roadmap): `tsc --noEmit`, `npm test` (Vitest), backend `pytest`. Lint is advisory ([[frontend-lint-baseline]]).

**Backend (pytest):**
- Service unit tests with a **mocked Anthropic client** returning a canned tool-use block per action → assert it parses into the typed proposal shape; assert the no-key path raises.
- Propose-endpoint tests: 404 chain (bad project/model/version/node), 502 with no key (monkeypatched), structured response shape per action, and **claim-ref hygiene** — a model response citing a ref that maps to a claim outside this version is dropped from `cited_claim_ids`.
- Apply-step test: creates node + edge; node has `properties["ai_proposed"] is True` and a seeded `_lineage_id`; `ai_proposed` `NodeClaimLink` rows created only for cited real claims (foreign ids ignored); deleting the node cascades the edge (undo path).
- Describe-apply test: `PATCH /nodes` with `description` writes `properties["description"]` and leaves other properties (e.g. `_lineage_id`) intact.

**Frontend (Vitest):**
- Node-placement helper (computes the new node's downstream position from the source) — pure function, unit-tested.
- Proposal-card accept/reject behavior (applies vs. dismisses; clears on accept).
- `ai_proposed` styling derivation: an `aiProposed` node renders distinct; an edge with an `aiProposed` endpoint inherits the styling.

**Live smoke (best-effort, not a gate):** against `./run-local.sh` with a real `ANTHROPIC_API_KEY`. Local `.env` keys are typically blank, so this is a documented **manual checklist** (run each action on a real node; verify cards, accept relabel/describe, accept a suggested step and confirm it renders `ai_proposed`, undo it), not an automated gate.

---

## Out of scope (→ SP-5b or later)

- **Decompose-to-next-level**, child `ProcessModel` creation, and cross-level navigation/breadcrumb — all SP-5b.
- Streaming responses; background/async AI (no workers exist).
- Auto-apply of any proposal.
- Multi-node or whole-map AI authoring.
- The richer §5.1.4 properties (actor/system, duration, cost, controls, risks) beyond the single description field.
- Editing AI provenance after the fact (e.g. promoting an `ai_proposed` link to `supports`).

---

## Open risks / notes for the plan

- **Blocking latency.** Each action is one synchronous Claude call (~a few seconds). The popover/loading UX must make that legible; keep `max_tokens` modest per action.
- **Forced-tool reliability.** Tool-use with a forced tool is the structured-output mechanism; the plan should pin the tool `input_schema` per action and handle the (rare) case of a malformed/empty tool input gracefully (return an empty proposal list, not a 500).
- **Description field churn.** SP-5a introduces `properties["description"]` ahead of the full §5.1.4 properties build; that later build should adopt the same key rather than introduce a parallel one.
- **Edge styling derivation** must be cheap (computed from endpoint flags during the existing render pass) — no extra fetch.
