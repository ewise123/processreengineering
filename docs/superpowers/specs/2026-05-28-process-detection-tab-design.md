# Process Detection Tab — Design Spec

_Date: 2026-05-28. Author: brainstormed with Claude. Status: approved for planning._

Pairs with `2026-05-28-multi-process-detection-design.md` (the feature this relocates). That spec built the detection backend, endpoints, and review UI. This spec covers a **frontend-only information-architecture change**: promoting the existing detection feature from a button-plus-standalone-route into a first-class project tab.

---

## Goal

Give multi-process detection a real home in the project tab bar — a **Processes** tab between **Conflicts** and **Maps** — instead of a "Detect processes" button bolted onto the Documents tab plus a standalone review route that highlights no tab.

One sentence: relocate an existing, working feature into a proper tab and fold the standalone review route into it. No new data, no new endpoints, no backend changes.

## Non-goals

- No backend changes. Every endpoint, schema, and service stays as built in the prior spec.
- No detection-algorithm changes (clustering, the 70% inheritance heuristic, the claim cap, etc.).
- No run-history index. The tab shows one run at a time (see "Current run resolution"). Historical runs remain reachable indirectly via the stale-map badges already on the Maps tab.
- No changes to the post-accept generation flow on the Maps tab.

---

## Current state (what exists today)

- **Tab bar** (`src/app/(app)/projects/[id]/layout.tsx`): a `TABS` array rendering `Overview · Documents · Claims · Conflicts · Maps`. Active tab is derived from the first path segment after `/projects/[id]` (`currentSlug`).
- **Detection trigger**: `DetectProcessesButton` (`src/components/detect-processes-button.tsx`) rendered on the Documents tab, top-right next to `UploadForm`. It queries `listDetectionRuns` + `listInputs`, gates on claim count, and on click either navigates to an existing draft (`/projects/[id]/detect/[draftId]`) or runs `detectProcesses` and navigates to the new run.
- **Review UI**: a standalone route `src/app/(app)/projects/[id]/detect/[runId]/page.tsx`. It loads `getDetectionRun`, renders segment cards (`SegmentCard`), the `NewEmptyClusterButton`, a reasoning-summary aside, and the Unassigned count. Accept routes to `/projects/[id]/maps?postAcceptRun=<runId>`; discard routes to `/projects/[id]/documents`. Because `detect` is not a tab slug, no tab highlights while the user is on this page.
- **Post-accept generation**: `PostAcceptPanel` (`src/components/detect/post-accept-panel.tsx`) is mounted on the Maps tab when `?postAcceptRun=<runId>` is present. Unchanged by this work.

### Relevant API client methods (all reused as-is)

- `api.listDetectionRuns(projectId)` → `DetectionRunListRow[]`, ordered `created_at` descending (most recent first). Each row has `id`, `status`, `claim_count_at_run`, `segment_count`, `created_at`.
- `api.getDetectionRun(projectId, runId)` → `DetectionRunDetail` (segments, unassigned segment, reasoning summary, status, counts).
- `api.detectProcesses(projectId)` → creates a draft run, returns `DetectionRunDetail`.
- `api.acceptDetectionRun`, `api.discardDetectionRun` — unchanged.

---

## Target design

### Tab bar

Insert one entry into the `TABS` array, between `conflicts` and `maps`:

```ts
{ slug: "processes", label: "Processes" }
```

URL: `/projects/[id]/processes`. The existing `currentSlug` derivation highlights it with no other layout change.

### Current run resolution

The tab shows exactly one run, resolved client-side from `listDetectionRuns` (already most-recent-first):

1. If a run with `status === "draft"` exists, that is the current run. (The backend enforces at most one draft per project, so there is never more than one.)
2. Otherwise, the most recent run with `status === "accepted"` is the current run.
3. Otherwise (no draft, no accepted), there is no current run → empty state.

Once a current run id is resolved, the page fetches `getDetectionRun(projectId, runId)` for the full detail to render.

### Three render states

**State A — no runs yet (no draft, no accepted).**
- A one-line explainer.
- A **Detect processes** button.
- The button is disabled with a tooltip when the project has zero claims (existing gating: sum `claim_count` across `listInputs`). Tooltip: "Extract claims from at least one document before detecting processes."

**State B — a draft exists (the live review).**
This is today's `/detect/[runId]` body, lifted onto the tab:
- Header: `{N} candidates · {M} claims · Run {timestamp} · Status: draft`.
- **Accept & continue** button → `acceptDetectionRun`, then `router.push('/projects/[id]/maps?postAcceptRun=<runId>')` (unchanged handoff).
- **Discard draft** button → `window.confirm` guard, then `discardDetectionRun`, then refresh the runs query so the tab falls back to State A or C. (Note: it no longer navigates to Documents — the user stays on the Processes tab.)
- Segment cards (`SegmentCard` with `disabled={false}`): rename, merge, move-claim, delete.
- `NewEmptyClusterButton`.
- Right aside: reasoning summary (when present) + Unassigned claim count.
- Single-segment warning banner (kept from the current review page): "We found a single process. You can still rename and accept, or skip to direct generation."
- The **Detect processes** button is **not shown** in this state — a second draft cannot be created (backend returns 409), so the user must accept or discard first.

**State C — accepted run, no open draft.**
- The latest accepted run's segments rendered **read-only** (`SegmentCard` with `disabled={true}` — the prop already exists and suppresses edit affordances).
- Header shows `Status: accepted` and the counts.
- A **Re-detect processes** button (same component/behavior as the Detect button; label reads "Re-detect processes" when an accepted run exists). Running it creates a new draft → tab re-renders into State B.
- A short line linking to the **Maps** tab to generate from these segments (the per-segment generation lives there via `PostAcceptPanel` / the generate dialog's "From detected process" dropdown).

### Detect button behavior change

`DetectProcessesButton` is repurposed for in-tab use:

- **Remove navigation.** On a successful `detectProcesses`, invalidate `["detection-runs", projectId]` (and `["detection-run", projectId, runId]` if cached). The tab re-renders into State B from the freshly-created draft. No `router.push`.
- **Keep** the claim-count gating and disabled tooltip.
- **Labels:** `Detect processes` (no runs) / `Detecting…` (pending) / `Re-detect processes` (an accepted run exists). The old **"Resume draft (N segments)"** label is removed — a draft is now shown inline rather than navigated to, so there is nothing to "resume."
- Visibility is controlled by the page: shown in States A and C, hidden in State B.

### What is removed / retired

- **Documents tab**: remove the `DetectProcessesButton` import and render from `documents/page.tsx`. Documents returns to upload/extract only.
- **Standalone route** `detect/[runId]/page.tsx`: its body moves into the Processes tab page. The route is replaced with a redirect to `/projects/[id]/processes` (guards bookmarks and any in-flight session) rather than a hard delete.

### What stays exactly as built

- Backend: all endpoints, schemas, services, the at-most-one-draft invariant, the claim cap.
- `SegmentCard`, `NewEmptyClusterButton`, `MergePopover`, `MoveClaimPopover`, `PostAcceptPanel`.
- The accept handoff to `/maps?postAcceptRun=<runId>` and everything the Maps tab does with it.

---

## Component / file inventory

| File | Change |
| --- | --- |
| `src/app/(app)/projects/[id]/layout.tsx` | Add `{ slug: "processes", label: "Processes" }` to `TABS` between `conflicts` and `maps`. |
| `src/app/(app)/projects/[id]/processes/page.tsx` | **New.** The live-view tab page. Resolves current run, renders States A/B/C, owns accept/discard mutations and the Detect button placement. |
| `src/components/detect-processes-button.tsx` | Drop `router.push`; invalidate runs query on success; keep gating; adjust labels (remove "Resume draft"). |
| `src/app/(app)/projects/[id]/documents/page.tsx` | Remove `DetectProcessesButton` import + render. |
| `src/app/(app)/projects/[id]/detect/[runId]/page.tsx` | Replace body with a client redirect to `/projects/[id]/processes`. |

No new API client methods, types, or backend files.

### Boundaries

- **`processes/page.tsx`** owns: run resolution, state selection (A/B/C), accept/discard mutations, header, aside, and orchestration of child components. It is the only new unit and the only place that knows the three-state logic.
- **`detect-processes-button.tsx`** owns: claim-count gating and the detect mutation. It exposes a single prop (`projectId`) and signals success by invalidating the shared `["detection-runs", projectId]` query — it does not know about page state. The page decides whether to render it.
- The review child components (`SegmentCard` et al.) are unchanged and already take a `disabled` prop, so State C (read-only) needs no new component work.

---

## Error handling and edge cases

- **Zero claims**: Detect disabled + tooltip (States A and C).
- **Draft open**: Detect hidden; the only paths forward are Accept or Discard, backed by the backend 409 if a second detect were somehow attempted.
- **Detection failure** (e.g. claim-cap exceeded, model error): surfaced via the existing `toast.error` in the button's mutation `onError`. No change to error copy.
- **Loading / fetch error** of the run detail: mirror the current review page — a muted "Loading…" line and a red error line.
- **Discard while on the tab**: after discard, the runs query refetches; the tab falls back to State C (if an accepted run remains) or State A (if not). The user stays on `/processes`.
- **Multiple accepted runs over time**: only the most recent accepted run is shown. Earlier runs' maps are still flagged stale on the Maps tab, so no history is silently dropped.

---

## Testing

- **Backend**: untouched. The existing `pytest` suite (detection service + API tests) stays green as a regression guard — run it to prove nothing in the relocation reached across the boundary.
- **TypeScript / build / lint**: `npx tsc --noEmit`, `npm run build`, and `npm run lint` (eslint) must all be clean — these are the primary automated gates for a frontend-only change. (The repo's `package.json` exposes `dev`/`build`/`start`/`lint`; there is no `test` script.)
- **Frontend unit tests**: the repo has no frontend test harness at the time of writing. Planning will confirm; if one exists, add coverage for the three-state resolution logic (a pure function `resolveCurrentRun(runs)` is a good extraction point). If none exists, do **not** stand one up as part of this work — note the gap and rely on the manual checklist.
- **Manual verification checklist**:
  1. Tab appears between Conflicts and Maps; highlights correctly when active.
  2. Empty project (no claims): Detect disabled with tooltip.
  3. Project with claims, no runs: Detect enabled → click → tab shows the draft (State B) without navigating away.
  4. Draft state: rename / merge / move / delete a segment; new empty cluster; Detect button hidden.
  5. Discard draft → confirm → stays on Processes, falls back to State A or C.
  6. Accept → routes to Maps with `?postAcceptRun=`; PostAcceptPanel drives generation.
  7. Accepted-only state: segments read-only; Re-detect button present; link to Maps works.
  8. Old `/projects/[id]/detect/<runId>` URL redirects to `/projects/[id]/processes`.
  9. Documents tab no longer shows the Detect button.

---

## Open questions

None. Scope is settled: frontend-only, three states, label "Processes", slug `processes`, standalone route retired via redirect.
