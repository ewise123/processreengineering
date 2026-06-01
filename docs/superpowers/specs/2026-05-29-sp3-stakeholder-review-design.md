# SP-3 — Stakeholder Review — Design

_Date: 2026-05-29 · Status: design / approved-pending-review · Sub-project 3 of the Maps-UI roadmap._

Pairs with `docs/superpowers/specs/2026-05-28-maps-ui-roadmap-sp2-sp5.md` (§ "SP-3 — Stakeholder review"). Builds on SP-1 (selection/overlay groundwork, the kept Review-mode toggle) and SP-2 (the now-live Properties panel). Branch: `sp3-stakeholder-review` (stacked on `sp2-node-lane-editing`).

---

## Goal

Wire the **dormant `Review` data model** into three currently-inert surfaces:

1. **Per-node review** in the Properties panel — the disabled **Approve / Request change / @ Assign** buttons.
2. **Review tab** (`right-panel.tsx`) — a real sign-off meter (`approved / total`), real Pending/Changes-requested/Approved buckets, and an enabled **"Send review request"** button.
3. **Review-mode overlay** — when the existing toggle is on, render a per-node status badge on the canvas.

No new tables and **no migration**: the `reviews` / `review_comments` tables already exist (initial schema migration `5f0feeb31d49`, confirmed present in the dev DB). SP-3 is pure wiring + a new endpoint set.

## Decisions locked (confirmed with the user)

| Decision | Choice |
|---|---|
| Granularity | **Per-node `Review` rows** (`target_type="process_node"`) + one **version-level** `Review` (`target_type="process_version"`) for the request. Sign-off meter = approved nodes / total nodes. |
| Assignment (no real auth) | **Defer Assign.** Ship Approve + Request-change (work fine single-user). `@ Assign` stays visibly disabled with a "needs multi-user accounts" tooltip. `assigned_to` column stays modeled, unused. |
| Comments | **Status + single optional note** (stored on the `Review` row's `notes`). No threaded `ReviewComment` UI in this cut. |
| Version status | **Auto-transition.** Sending a request flips `ProcessVersion.status` draft→review; all nodes approved (and total > 0) → approved. |
| Request-change note | **Optional** (not required). |
| Overlay scope | **Nodes only** (no edge/lane review treatment). |
| Undo | Review actions are **not** on the canvas undo stack — they're workflow decisions persisted via react-query mutations, not graph edits. |

---

## Architecture & data flow

The whole feature hangs off **one page-level "review state" query**. The version page fetches review state via react-query (keyed `["review", projectId, modelId, versionId]`), exactly mirroring how `issuesByNode` already flows to the canvas and right panel. That single query feeds: the Review-tab meter + buckets, the per-node badge overlay, and the Properties-panel status. Review actions are react-query **mutations that invalidate `["review", …]`**, so one refetch keeps every surface consistent. This deliberately avoids threading review state into the canvas's complex local edit/undo state.

### Reusing the `Review` model (`backend/app/models/workflow.py`)

`Review` columns already present: `project_id`, `target_type` (String 40), `target_id` (UUID, **not** an FK), `requested_by` (User FK, nullable), `assigned_to` (User FK, nullable), `status` (String 30, default `ReviewStatus.REQUESTED`), `notes` (Text, nullable). Enums (`backend/app/enums.py`): `ReviewStatus` = requested / in_progress / approved / changes_requested; `ReviewTargetType` = process_model / process_version / process_node / process_edge; `ProcessVersionStatus` = draft / review / approved.

Two uses:
- **Per-node decision** — one `Review` per reviewed node: `target_type="process_node"`, `target_id=node.id`, `status ∈ {approved, changes_requested}`, `notes` optional, `requested_by`=current dev user. **Upsert** (one row per node, updated in place — represents *current* status; no per-node history in this cut). **Pending = the absence of a row** (no eager creation).
- **Version request** — one `Review`: `target_type="process_version"`, `target_id=version.id`, `status` (`requested` on send, `approved` when fully signed off).

`target_id` is not an FK, so a deleted node would orphan its review. Two guards: (a) the rollup query scopes per-node statuses to the version's *current* node IDs (orphans never counted); (b) `delete_node` also deletes that node's `process_node` review rows.

### Lifecycle (auto-transition)

- **Send request** → upsert version `Review` = `requested`; set `ProcessVersion.status` = `review`.
- **Per-node Approve / Request-change** work anytime (independent of whether a request was sent).
- **All nodes approved** (and `total > 0`) → version `Review` = `approved` and `ProcessVersion.status` = `approved`. A single change-request does **not** reject the whole map; the version stays `review` until every node is green. If a previously-complete map gains a new/un-approved node, the next recompute drops it back out of `approved` (status → `review` if a request exists, else left as-is).

---

## Backend

No migration. New router `backend/app/api/v2/reviews.py` (`APIRouter(prefix="/projects/{project_id}", tags=["reviews"])`), registered in `backend/app/api/v2/__init__.py`. New schemas in `backend/app/schemas/review.py`. Mirror the existing `process_maps.py` route conventions (`Depends(get_project_or_404)`, `Depends(get_db)`, `get_current_user`).

### Schemas (`backend/app/schemas/review.py`)

```python
class NodeReviewUpdate(BaseModel):
    status: str = Field(pattern=r"^(approved|changes_requested)$")
    note: str | None = Field(default=None, max_length=2000)

class NodeReviewRead(BaseModel):
    node_id: UUID
    status: str
    note: str | None

class ReviewCounts(BaseModel):
    approved: int
    changes_requested: int
    pending: int
    total: int

class ReviewStateRead(BaseModel):
    version_id: UUID
    version_status: str          # ProcessVersion.status
    request_status: str | None   # version-level Review.status, or null if never requested
    nodes: list[NodeReviewRead]   # only nodes that have a decision (pending omitted)
    counts: ReviewCounts
```

### Endpoints

1. **`GET /projects/{project_id}/process-maps/{model_id}/versions/{version_id}/review`** → `ReviewStateRead`.
   - Validate version belongs to model belongs to project (same checks as `get_process_graph`).
   - Load the version's node IDs. Load `process_node` reviews with `target_id IN node_ids`. Load the `process_version` review for `target_id=version_id` (→ `request_status`).
   - `counts.total` = node count; `approved`/`changes_requested` from the reviews; `pending` = total − approved − changes_requested. `nodes` = the decided ones.

2. **`PATCH /projects/{project_id}/nodes/{node_id}/review`** (body `NodeReviewUpdate`) → `NodeReviewRead`.
   - Look up node (404 if missing) → `version_id`. Verify node's project via the existing `_check_node_in_project` helper.
   - Upsert the `process_node` `Review` (find by `target_type`+`target_id`; create or update `status`/`notes`/`requested_by`).
   - Call `_recompute_version_status(db, version_id)`.

3. **`POST /projects/{project_id}/process-maps/{model_id}/versions/{version_id}/review/request`** → `ReviewStateRead`.
   - Upsert the `process_version` `Review` with `status="requested"`, `requested_by`=dev user.
   - Set `ProcessVersion.status="review"`. Return the full state (same builder as #1).

### Helper

```python
def _recompute_version_status(db, version_id):
    # total nodes for version; count process_node reviews (in current node set) with status=approved
    # if total > 0 and approved == total:
    #     version.status = "approved"; upsert version-level Review status = "approved"
    # elif a version-level Review exists (a request was sent):
    #     version.status = "review"
    # commit
```

### Node-delete cleanup (`update`/`delete_node` in `process_maps.py`)

In `delete_node`, after deleting the node, also `DELETE FROM reviews WHERE target_type='process_node' AND target_id=node_id` so orphaned decisions don't linger. (Small, idempotent.)

---

## Frontend

### Types (`src/lib/types.ts`)

```ts
export type ReviewDecision = "approved" | "changes_requested";
export interface NodeReview { node_id: UUID; status: ReviewDecision; note: string | null; }
export interface ReviewCounts { approved: number; changes_requested: number; pending: number; total: number; }
export interface ReviewState {
  version_id: UUID; version_status: string; request_status: string | null;
  nodes: NodeReview[]; counts: ReviewCounts;
}
export interface NodeReviewUpdate { status: ReviewDecision; note?: string; }
```

### API client (`src/lib/api.ts`) — following the existing `request<T>` pattern

```ts
getReviewState: (projectId, modelId, versionId) =>
  request<ReviewState>(`/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/review`),
setNodeReview: (projectId, nodeId, body: NodeReviewUpdate) =>
  request<NodeReview>(`/api/v2/projects/${projectId}/nodes/${nodeId}/review`, { method: "PATCH", json: body }),
requestReview: (projectId, modelId, versionId) =>
  request<ReviewState>(`/api/v2/projects/${projectId}/process-maps/${modelId}/versions/${versionId}/review/request`, { method: "POST" }),
```

### Pure helper + Vitest (`src/components/canvas/review-summary.ts` + `.test.ts`)

The Review tab needs node lists per bucket (not just counts). Extract the pure bucketing so it's unit-testable:
```ts
export type ReviewByNode = Record<string, ReviewDecision>;
export function reviewByNodeMap(reviews: NodeReview[]): ReviewByNode { … }
export function bucketNodes(
  nodes: { id: string; name: string }[], byNode: ReviewByNode
): { approved: Node[]; changesRequested: Node[]; pending: Node[] } { … }
```
Vitest: a node with `approved`/`changes_requested`/no entry lands in the right bucket; counts add to total; empty inputs → all-empty.

### Version page (`…/versions/[versionId]/page.tsx`)

- Add `useQuery(["review", projectId, modelId, versionId], () => api.getReviewState(...))`, enabled when graph data is loaded.
- Build `reviewByNode` from `reviewState.nodes`.
- Two mutations: `setNodeReview` and `requestReview`, both `onSuccess` → `invalidateQueries(["review", …])`.
- Pass down: `reviewByNode` → `BpmnCanvas`; `reviewState` + bucketed nodes + `onSendRequest` → Review tab; selected node's status + `onApprove`/`onRequestChange` → `PropertiesPanel`.

### Properties panel (`properties-panel.tsx`, lines 320-348)

New prop, e.g. `review?: { status: ReviewDecision | null; onApprove: () => void; onRequestChange: (note?: string) => void; }`.
- Replace "Not yet assigned." with the live status line: "Approved" (emerald) / "Changes requested" (amber) / "Not yet reviewed".
- **Approve** → `review.onApprove()` (1 click). **Request change** → reveals a small optional `<textarea>` + a submit button → `review.onRequestChange(note || undefined)`. Disable both when `!review` (e.g. multi-select). **@ Assign** stays `disabled` with `title="Assigning reviewers needs multi-user accounts (coming later)"`.

### Review tab (`right-panel.tsx`, `ReviewTab` lines 562-617)

- New props: `reviewState: ReviewState | undefined`, `onSendRequest: () => void`, plus the existing `nodes`/`onFocusNode`.
- Meter: `approved = reviewState?.counts.approved ?? 0`, `total = reviewState?.counts.total ?? nodes.length`. Drop the hardcoded `0`.
- Buckets: use `bucketNodes(nodes, reviewByNode)` for the three lists + counts (Changes requested / Pending / Approved). Drop the footer "isn't persisted yet" disclaimer.
- "Send review request" button: enable when `total > 0`; `onClick={onSendRequest}`; show the request/version status (e.g. a small "Status: review" pill) when present.

### Review-mode overlay (`bpmn-canvas.tsx` + `shapes.tsx`)

- `BpmnCanvas` gains a `reviewByNode?: ReviewByNode` prop. The `reviewMode` state already exists (line 199, currently unused).
- When `reviewMode` is on, `NodeShape` renders a small badge at the node's top-right corner: green check for `approved`, amber "!" for `changes_requested`, nothing for pending. Pass the per-node decision into the rendered node (alongside the existing issue-severity plumbing). Edges/lanes get no treatment.

---

## Testing strategy

Binding gates: `npx tsc --noEmit`, `npm test` (Vitest), `npm run build`, backend `pytest`, manual via `./run-local.sh`. Lint advisory (see `[[frontend-lint-baseline]]`).

- **Backend pytest** (extend the SP-2 `_seed_map` pattern, now with ≥2 nodes): request flips version→review; approving the only/last node flips version→approved; a change-request keeps version in review; `GET review` rollup counts (approved/changes_requested/pending/total); invalid status → 422; a deleted node's review is gone and excluded from counts.
- **Vitest**: `review-summary.test.ts` for `reviewByNodeMap` + `bucketNodes`.
- **Manual** (`./run-local.sh`): select a node → Approve → meter ticks up, badge shows in review mode; Request change with a note → amber, note persists; Send review request → version shows `review`; approve all nodes → version shows `approved`; reload → all state persists; @ Assign stays disabled with tooltip.

---

## File-by-file change list

**Backend** (no migration)
- `backend/app/schemas/review.py` (new) — `NodeReviewUpdate`, `NodeReviewRead`, `ReviewCounts`, `ReviewStateRead`.
- `backend/app/api/v2/reviews.py` (new) — GET review state, PATCH node review, POST request; `_recompute_version_status` helper.
- `backend/app/api/v2/__init__.py` — register the reviews router.
- `backend/app/api/v2/process_maps.py` — `delete_node` deletes the node's `process_node` reviews.
- `backend/tests/test_stakeholder_review.py` (new) — pytest.

**Frontend**
- `src/lib/types.ts` — review types.
- `src/lib/api.ts` — `getReviewState`, `setNodeReview`, `requestReview`.
- `src/components/canvas/review-summary.ts` (new) + `review-summary.test.ts` (new) — pure bucketing + Vitest.
- `src/components/canvas/properties-panel.tsx` — live status + Approve/Request-change wired; Assign disabled w/ tooltip.
- `src/components/canvas/right-panel.tsx` — `ReviewTab` real meter/buckets/send.
- `src/components/canvas/shapes.tsx` — per-node review badge.
- `src/components/canvas/bpmn-canvas.tsx` — `reviewByNode` prop → node render under `reviewMode`.
- `src/app/(canvas)/projects/[id]/maps/[modelId]/versions/[versionId]/page.tsx` — review query + mutations + prop threading.

## Out of scope (deferred)

Threaded `ReviewComment` UI; real assignment/identity + a user-list endpoint; notifications/email; edge or lane review; per-node review history/audit trail; multi-version review rollups.
