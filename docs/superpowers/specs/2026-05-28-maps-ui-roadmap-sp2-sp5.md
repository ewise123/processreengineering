# Maps UI — Roadmap Spec for SP-2 … SP-5

_Date: 2026-05-28 · Status: roadmap / umbrella spec · Covers the four sub-projects after SP-1._

This is the **overall spec for the remaining planned Maps-UI work**. It is deliberately one level above the per-feature specs: it locks the scope, the foundations each sub-project builds on, the sequencing, and — most importantly — the **open design decisions** that must be resolved when each sub-project starts. The three large sub-projects (SP-3, SP-4, SP-5) each still get their own detailed brainstorm → spec → plan before any code, exactly as SP-1 did. SP-2 is small enough to go straight to a short spec + plan.

It pairs with:
- `docs/superpowers/specs/2026-05-28-sp1-canvas-hardening-design.md` (SP-1 design)
- `docs/superpowers/plans/2026-05-28-sp1-canvas-hardening.md` (SP-1 plan)
- `docs/how-it-works.md` and `docs/spec/process-reengineering-spec-v1.1.md` (§5.1.4 defines the long-term target editor)

---

## Where this came from

An audit of the Maps UI found the backend fully wired but several visible controls non-functional and several editor capabilities missing. The work was decomposed into five independent sub-projects. The user chose to **build out the deferred feature set for real** (not hide the placeholders), keep the 4-shape palette as-is, and keep the Review-mode toggle for SP-3.

| # | Sub-project | One-line goal | Backend work | Size / Risk |
|---|---|---|---|---|
| SP-1 | Canvas hardening | Make every existing control work + add multi-select/copy-paste/context-menus/lane-collapse | none | M / low — **in progress** |
| SP-2 | Node + lane editing | Functional Type dropdown + persisted lane color | small (2 fields) | S / low |
| SP-3 | Stakeholder review | Per-node approve/request-change/assign + Review tab + review overlay | medium | L / med |
| SP-4 | Version control | Versions tab: list / branch / restore / diff | medium | L / med-high |
| SP-5 | AI edit-this-step | "Ask AI to edit this step" → grounded proposals | medium | M-L / high |

**Recommended order: SP-2 → SP-3 → SP-4 → SP-5** (SP-1 first). SP-2 is a quick, low-risk win and SP-5 wants SP-2's type editing to apply AI type suggestions; SP-3 leans on SP-1's selection/overlay groundwork.

### SP-1 status snapshot (so a remote session can resume cleanly)
- Tasks 1–6 **done, reviewed (spec + code-quality), committed and pushed** to `origin/repo-restructure`.
- Task 7 (selection `Set` refactor, commit `03c4485`) is **implemented, committed, and pushed but its spec + code-quality reviews are not yet run** — run those before starting Task 8.
- Tasks 8–14 (tools/marquee/shortcuts, group move, bulk bar, copy/paste, context menus, lane collapse, full verification) remain.

---

## Shared foundations already in the codebase

The single most important finding from the audit: **much of the backend data model for this work already exists and is unused.** These sub-projects mostly wire up and extend foundations rather than inventing them.

- **Review workflow:** `Review` and `ReviewComment` tables exist (`backend/app/models/workflow.py`). `Review` has `project_id`, `target_type`, `target_id`, `requested_by`, `assigned_to`, `status`, `notes`. `ReviewComment` has `review_id`, `author_id`, `body`, a JSONB `anchor`, and `parent_comment_id` (threading). `ReviewStatus` enum = `requested / in_progress / approved / changes_requested`. No endpoints or UI consume any of this yet. → **SP-3**.
- **Versioning:** `ProcessVersion` (`backend/app/models/process.py`) already has `version_number` (unique per model), `parent_version_id` (self-FK — a version tree), `status` (`ProcessVersionStatus` = `draft / review / approved`), `notes`, `created_by`, and `bpmn_xml`. A "version" already **is** a full graph snapshot — lanes/nodes/edges all FK `version_id`. Only `getProcessGraph(versionId)` is exposed; there is no list/create/branch/restore endpoint. → **SP-4**.
- **Node types & per-node state:** `NodeType` enum already includes `gateway_parallel`, `gateway_inclusive`, `subprocess`, `event_intermediate` (the palette just doesn't offer them). `ProcessNode.properties` is a free JSONB column, unused — a natural home for per-node UI state. The existing `PATCH /nodes/{id}` accepts name/lane/x/relative_y but **not** `type`. → **SP-2** (type) and **SP-3** (per-node review state).
- **AI grounding:** an in-canvas chat already exists (`POST .../versions/{id}/chat`, service `backend/app/services/map_chat.py`) with anti-fabrication, claim-citation rules. `ClaimLinkKind` already has an `ai_proposed` value, signalling intent to mark AI-originated links distinctly from claim-grounded ones. → **SP-5**.
- **Target editor intent** (`docs/spec/process-reengineering-spec-v1.1.md` §5.1.4): the long-term Properties panel (description, actor/system, level, duration, cost, controls, risks, notes), the AI-assist menu ("generate description", "suggest next step", "validate completeness", "decompose to next level"), and "version history with diff view." These sub-projects are the first concrete slices of that target; we deliberately take focused first cuts rather than the whole §5.1.4 at once.

---

## Cross-cutting constraints (apply to all four)

1. **There is no real authentication.** Every request is the same hard-coded dev user (`docs/how-it-works.md`). This most affects **SP-3** ("assign to", "requested_by"): `@assign` is effectively cosmetic until auth exists. Model the columns honestly, but the UI for assignment must degrade gracefully (free-text/email stub or a deferred assignment) rather than pretend at multi-user identity. Flag this at SP-3 brainstorm.
2. **Provenance is the product.** Every step is supposed to trace to a verbatim quote. This binds three decisions: SP-2 type changes must **keep** a node's claim links (type ≠ provenance); SP-4 branch/restore must **copy** node/edge claim links into the new version; SP-5 AI proposals must be marked `link_kind = ai_proposed` and rendered **visibly distinct** from claim-grounded steps so the consultant never mistakes a model guess for sourced fact.
3. **No background workers.** Claude calls block the HTTP request (no queue, no streaming). SP-5's AI-edit endpoint inherits this; keep the per-call scope small enough to return in one request.
4. **Process discipline.** SP-3/4/5 each run the full pipeline: `superpowers:brainstorming` (resolve the open questions below, one at a time) → spec in `docs/superpowers/specs/` → `superpowers:writing-plans` → `superpowers:subagent-driven-development`. SP-2 may skip straight to a short spec + plan. Lint is advisory (see [[frontend-lint-baseline]]); the binding gates are `tsc --noEmit`, `npm test` (Vitest), and manual verification against `./run-local.sh`.

---

## SP-2 — Node + lane editing

**Goal.** Make the Properties **Type dropdown** functional (change a node's BPMN type) and add a **persisted lane color** picker. Both are currently dead/placeholder controls.

**In scope**
- **Type editing.** Enable the disabled Type dropdown (`properties-panel.tsx`). On change: `PATCH /nodes/{id}` with a new `type`; locally update the node's `type`, recompute `kind` via `nodeKindFromType` and size via `NODE_SIZES`, re-render; record an undo entry.
- **Lane color.** Add a `color` column to `ProcessLane` + `LaneUpdate`; a color picker in the lane rail; persist; replace the client-derived `LANE_PALETTE[index]` default with the stored color (palette as fallback when null).
- **(Optional) Persist lane collapse** — SP-1 ships collapse as session-only; since SP-2 already touches the lane backend, persisting `collapsed` can ride along (add a column + include in `LaneUpdate`). Decide at SP-2 spec.

**Builds on.** `NodeType` enum (all types already valid); `nodeKindFromType` / `NODE_SIZES` (`layout.ts`); existing `PATCH /nodes/{id}` and `PATCH /lanes/{id}`. SP-1 already added `CanvasNode.type`, so the frontend already carries the value the dropdown edits.

**Backend.** Add `type` to the `NodeUpdate` schema + apply it in the node-update route. Add `color` (and optionally `collapsed`) to `ProcessLane` + `LaneUpdate` + a small Alembic migration.

**Open questions for the SP-2 spec**
- May any node become any type (e.g., start-event → task), or do we restrict transitions? (Lean: allow any `NodeType`; it's the consultant's map.)
- When a task→gateway change shrinks the shape, keep `x`/`relative_y` and just re-render (lean yes), or reflow?
- Lane color: free picker vs a fixed swatch set matching `LANE_PALETTE`? (Lean: swatch set + custom, persisted.)

**Out of scope.** The richer §5.1.4 properties (description/actor/duration/cost/controls/risks). Those are a later, larger properties build.

---

## SP-3 — Stakeholder review

**Goal.** Wire the existing `Review`/`ReviewComment` tables into: per-node **Approve / Request change / Assign** (the three disabled buttons in `properties-panel.tsx`), a Review tab that **sends a review request** and shows a **real sign-off meter** + per-node status list, and a **Review-mode** canvas overlay driven by the toggle SP-1 keeps.

**Builds on.** `Review` + `ReviewComment` tables; `ReviewStatus` (`requested/in_progress/approved/changes_requested`); `ProcessVersionStatus` (`draft/review/approved`); `ProcessNode.properties` (candidate store for per-node status) or per-node `Review` rows.

**Backend (new).** Endpoints to: create a review request for a version; set a node's review status (approve / request-change, with optional note); fetch a version's review state (per-node statuses + approved/total counts); assign a reviewer. Likely `target_type` in {`version`, `node`}.

**Frontend.** Enable the Properties review section (3 buttons → real calls); Review tab: "Send review request" (currently disabled), sign-off meter wired to real counts (replacing the hardcoded `0`), per-node status list; **Review-mode overlay**: when the toggle is on, render per-node status badges (approved = green check, changes-requested = amber) and surface approve/request-change in Properties.

**Open questions for the SP-3 brainstorm (resolve first — these shape the data model)**
- **Granularity:** per-node review status (the sign-off meter implies "N of M steps approved") vs per-version approval. Lean: per-node `Review` rows (`target_type="node"`) plus one version-level request; resolve explicitly.
- **Identity (the big constraint):** with no real auth, what does "Assign" mean? Options: stub user list, free-text/email, or defer assignment until auth lands and ship approve/request-change first. Must be decided up front.
- **Comments:** build `ReviewComment` threads (with the JSONB `anchor` → node) now, or ship status + a single note first and thread later? Lean: status + note first.
- Does requesting review flip `ProcessVersion.status` to `review`, and full approval to `approved`? (Lean: yes — it's already modeled.)

**Out of scope.** Email/notifications; real multi-user auth.

---

## SP-4 — Version control

**Goal.** Turn the placeholder Versions tab into a working **history list** with **branch**, **restore**, and (stretch) **diff** — replacing the single read-only HEAD entry and the disabled "+ Branch".

**Builds on.** `ProcessVersion` already models a version tree (`parent_version_id`), a status, and is itself a full graph snapshot (lanes/nodes/edges FK `version_id`). The canvas route is already version-addressed.

**Backend (new).** `GET` versions for a model; `POST` create-version (snapshot the current graph — copy lanes/nodes/edges **and their claim links** into a new `ProcessVersion`, `parent_version_id` = current, in one transaction); `POST` restore (non-destructive: copy a prior version into a new head rather than mutating history); optional `GET` diff(vA, vB).

**Frontend.** Versions tab: real list (HEAD badge from data, not hardcoded), per-version open/restore/branch actions; wire the disabled "+ Branch"; optional diff panel.

**Open questions for the SP-4 brainstorm (resolve first — these define the semantics)**
- **What is a "commit/branch"?** Lean: **snapshot-on-demand** ("Create version" / "Branch") rather than auto-versioning every edit. Confirm.
- **Restore semantics:** restore = create a NEW version that copies the old graph (non-destructive, lean) vs mutate history (rejected — destroys provenance trail).
- **How far on branching?** True branch + **merge** is hard (graph 3-way merge). Lean: linear history + create-version + restore-as-new-version first; **defer merge**. The placeholder copy promises "branching, commits, and merge tooling" — set expectations: first cut delivers history + snapshot + restore, not merge.
- **Diff view** (§5.1.4): added/removed/renamed nodes, edges, lanes between two versions. Medium effort; may be SP-4b.
- **Copy cost:** snapshotting copies the full node/edge/lane set + claim links — server-side, transactional.

**Out of scope (first pass).** Merge / cross-branch conflict resolution; BPMN-XML regeneration per version.

---

## SP-5 — AI edit-this-step

**Goal.** Wire the disabled **"Ask AI to edit this step"** button to a Claude call that proposes edits for the selected node, grounded in that node's claims — proposals the user **accepts or rejects**, never auto-applied.

**Builds on.** The existing map-chat service (`map_chat.py`, `POST .../chat`) and its anti-fabrication/citation rules; `ClaimLinkKind.ai_proposed`; the node↔claim provenance graph as grounding context.

**Backend (new).** `POST .../nodes/{id}/ai-edit` (or extend the chat service) returning **structured proposals** (not freeform prose): e.g. a cleaner label, a description, a flagged gap / suggested next step. Reuse the grounding/guardrail prompt rules.

**Frontend.** Wire the disabled button → call → render proposals → accept (applies as an undo-able edit; AI-created nodes/edges marked `ai_proposed`) / reject.

**Open questions for the SP-5 brainstorm (resolve first)**
- **Capability scope.** §5.1.4 lists many ("generate description", "suggest next step", "validate completeness", "decompose to next level"). Lean: a **focused first cut** — relabel + describe + flag-missing-detail for one node — then expand. Confirm the exact menu.
- **Apply model.** Proposals reviewed then applied (lean) vs auto-apply (rejected — violates the human-in-the-loop, provenance-first ethos).
- **Provenance marking.** AI-proposed steps/links must render visibly distinct (badge/color) and carry `link_kind = ai_proposed`. Non-negotiable.
- **Guardrails.** Reuse map-chat's "don't invent steps the claims don't support; cite claim IDs; say 'the sources don't say' rather than guess."
- **Cost/latency.** Blocking call; keep per-invocation scope to a single node.

**Out of scope.** Full agentic multi-step map authoring; auto-apply; streaming.

---

## Decisions this spec locks (vs. defers)

**Locked now:**
- Build all four for real, in order SP-2 → SP-3 → SP-4 → SP-5.
- SP-2 is small → short spec + plan; SP-3/4/5 each get a full brainstorm → spec → plan → subagent execution.
- Provenance is preserved across every sub-project (links kept on type change, copied on branch, marked `ai_proposed` for AI output).
- Restore is non-destructive (copy to a new head). Merge is deferred out of SP-4's first cut.
- AI edits are propose-then-apply, never auto-apply.

**Deferred to each sub-project's brainstorm** (the "open questions" lists above): review granularity + how assignment works without auth; what a "commit/branch" is and whether to ship diff; the exact AI-edit capability menu; the richer §5.1.4 properties.

The next concrete step after SP-1 finishes is the **SP-2 spec** — it's the only one ready to skip the full brainstorm, and it unblocks SP-5's "apply an AI-suggested type" later.
