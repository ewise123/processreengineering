# Process Detection Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the existing multi-process-detection feature from a button on the Documents tab plus a standalone review route into a first-class **Processes** tab between Conflicts and Maps.

**Architecture:** Frontend-only information-architecture change. A new client page at `/projects/[id]/processes` resolves "the current run" (open draft, else most-recent accepted) from the existing `listDetectionRuns` API and renders one of three states (no-run / draft / accepted) inline — folding in the body of today's `/detect/[runId]` route. The `DetectProcessesButton` is repurposed to trigger detection in place (no navigation), the Documents-tab button is removed, and the old standalone route becomes a redirect. No backend, schema, or API-client changes.

**Tech Stack:** Next.js 16.1 (App Router) · React 19.2 · TanStack Query · shadcn/ui · TypeScript.

**Source spec:** `docs/superpowers/specs/2026-05-28-process-detection-tab-design.md`

---

## Testing note (read first)

This repo has **no frontend test harness** — `package.json` exposes only `dev`/`build`/`start`/`lint`, no `test` script, and no jest/vitest/playwright dependency. Per the spec, **do not stand one up for this work.**

The automated gate after every task is therefore:

```bash
npx tsc --noEmit      # typecheck — must print nothing and exit 0
npm run lint          # eslint — must pass clean
```

A full `npm run build` plus a manual click-through is the final task (Task 6). Each task below substitutes "typecheck + lint clean" for the usual "test passes" gate. Run commands from the repo root: `/home/chagood/workspace/projects/Process Engineering`.

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/components/detect-processes-button.tsx` | Trigger a detection run; gate on claim count; label by state. Knows nothing about page layout — signals success by invalidating the shared `["detection-runs", projectId]` query. | Modify (Task 1) |
| `src/app/(app)/projects/[id]/processes/page.tsx` | The Processes tab. Resolves the current run, selects state A/B/C, owns accept/discard, places the Detect button. The only unit that knows the three-state logic. | Create (Task 2) |
| `src/app/(app)/projects/[id]/layout.tsx` | Project tab bar. | Modify (Task 3) — add tab entry |
| `src/app/(app)/projects/[id]/documents/page.tsx` | Upload + extract claims. | Modify (Task 4) — remove Detect button |
| `src/app/(app)/projects/[id]/detect/[runId]/page.tsx` | Legacy review route. | Modify (Task 5) — replace with redirect |

Task order keeps the app building and behaving sensibly at every commit: the button is repurposed first, then the page that uses it, then the tab that links to the page, then the two removals/retirements.

---

## Task 1: Repurpose `DetectProcessesButton`

Strip navigation out of the button so it triggers detection in place. On success it invalidates the runs query; the parent page re-renders into the draft view. Drop the "Resume draft" label (a draft is now shown inline, never navigated to) and the trailing accepted-count badge (the page header shows status). Keep the claim-count gating.

**Files:**
- Modify: `src/components/detect-processes-button.tsx` (full rewrite of the file)

- [ ] **Step 1: Replace the file contents**

Overwrite `src/components/detect-processes-button.tsx` with:

```tsx
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { UUID } from "@/lib/types";

/**
 * Triggers a detection run for the project. It does not navigate — on success
 * it invalidates the shared ["detection-runs", projectId] query so whichever
 * page renders it (the Processes tab) re-renders into the new draft. The
 * backend rejects a second concurrent draft (409), and the Processes tab hides
 * this button while a draft is open, so this button only ever appears when
 * starting a fresh run (no runs yet) or re-running after an accepted run.
 */
export function DetectProcessesButton({ projectId }: { projectId: UUID }) {
  const qc = useQueryClient();

  // Sum claim counts across all inputs to know whether detection is meaningful.
  const inputsQuery = useQuery({
    queryKey: ["inputs", projectId, "page", 0],
    queryFn: () => api.listInputs(projectId, { limit: 100, offset: 0 }),
  });
  const totalClaims =
    inputsQuery.data?.items.reduce((sum, i) => sum + (i.claim_count || 0), 0) ??
    0;
  const hasClaims = totalClaims > 0;

  // Shared cache with the Processes page — same query key, no extra fetch.
  const runsQuery = useQuery({
    queryKey: ["detection-runs", projectId],
    queryFn: () => api.listDetectionRuns(projectId),
  });
  const hasAccepted =
    runsQuery.data?.some((r) => r.status === "accepted") ?? false;

  const detect = useMutation({
    mutationFn: () => api.detectProcesses(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-runs", projectId] });
    },
    onError: (e: Error) => toast.error(`Detection failed: ${e.message}`),
  });

  let label = "Detect processes";
  if (detect.isPending) label = "Detecting…";
  else if (hasAccepted) label = "Re-detect processes";

  const disabled = detect.isPending || !hasClaims;
  const tooltip = !hasClaims
    ? "Extract claims from at least one document before detecting processes."
    : undefined;

  return (
    <Button
      variant="secondary"
      onClick={() => detect.mutate()}
      disabled={disabled}
      title={tooltip}
    >
      {label}
    </Button>
  );
}
```

What changed vs. the previous version: removed `useRouter`, the `router.push` navigation in `onSuccess` and `onClick`, the `draft`-based "Resume draft" branch and label, the `Badge` import and the trailing `{accepted.segment_count} accepted` badge, and the wrapping `<div>`. The component now returns a bare `<Button>`.

- [ ] **Step 2: Typecheck and lint**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: both exit 0 with no errors. (`documents/page.tsx` still imports and renders this button at this point — that's fine; the button still works, it just no longer navigates. Task 4 removes it from Documents.)

- [ ] **Step 3: Commit**

```bash
git add src/components/detect-processes-button.tsx
git commit -m "refactor(detection): detect button triggers in place, no navigation

Drop router.push, the Resume-draft branch, and the accepted-count badge.
On success invalidate the runs query so the host page re-renders. Prep for
the Processes tab.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Create the Processes tab page

The page resolves the current run and renders three states:
- **A (no runs):** explainer + Detect button.
- **B (draft):** the live review — status line, Accept & continue, Discard draft, segment cards, New empty cluster, reasoning/Unassigned aside, single-segment banner. Detect button hidden.
- **C (accepted, no draft):** segments read-only, a note linking to Maps, the Detect button (labelled "Re-detect processes").

This is the body of today's `detect/[runId]/page.tsx`, lifted onto a self-resolving tab. It drops the old page's redundant `<h1>Detected processes</h1>` because the tab bar already labels the page and the layout renders the project title.

**Files:**
- Create: `src/app/(app)/projects/[id]/processes/page.tsx`

- [ ] **Step 1: Create the page**

Create `src/app/(app)/projects/[id]/processes/page.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { SegmentCard } from "@/components/detect/segment-card";
import { NewEmptyClusterButton } from "@/components/detect/new-empty-cluster-button";
import { DetectProcessesButton } from "@/components/detect-processes-button";
import type { DetectionRunListRow } from "@/lib/types";

/**
 * The current run is the open draft if one exists (the backend enforces at most
 * one draft per project), otherwise the most recent accepted run. `runs`
 * arrives most-recent-first from the API, so `.find` picks the latest.
 */
function resolveCurrentRun(
  runs: DetectionRunListRow[] | undefined,
): DetectionRunListRow | null {
  if (!runs) return null;
  const draft = runs.find((r) => r.status === "draft");
  if (draft) return draft;
  return runs.find((r) => r.status === "accepted") ?? null;
}

export default function ProcessesPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const runsQuery = useQuery({
    queryKey: ["detection-runs", projectId],
    queryFn: () => api.listDetectionRuns(projectId),
  });

  const current = resolveCurrentRun(runsQuery.data);

  const runQuery = useQuery({
    queryKey: ["detection-run", projectId, current?.id],
    queryFn: () => api.getDetectionRun(projectId, current!.id),
    enabled: !!current,
  });

  const accept = useMutation({
    mutationFn: () => api.acceptDetectionRun(projectId, current!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-runs", projectId] });
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      router.push(`/projects/${projectId}/maps?postAcceptRun=${current!.id}`);
    },
    onError: (e: Error) => toast.error(`Accept failed: ${e.message}`),
  });

  const discard = useMutation({
    mutationFn: () => api.discardDetectionRun(projectId, current!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-runs", projectId] });
      qc.invalidateQueries({
        queryKey: ["detection-run", projectId, current!.id],
      });
    },
    onError: (e: Error) => toast.error(`Discard failed: ${e.message}`),
  });

  // ---- Runs-list loading / error ----
  if (runsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (runsQuery.error) {
    return (
      <p className="text-sm text-red-600">
        {(runsQuery.error as Error).message}
      </p>
    );
  }

  // ---- State A: no runs ----
  if (!current) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Detect the distinct business processes hiding in this project&apos;s
          claims, review the proposed clusters, then accept them to scope map
          generation per process.
        </p>
        <DetectProcessesButton projectId={projectId} />
      </div>
    );
  }

  // ---- Current run detail loading / error ----
  if (runQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (runQuery.error) {
    return (
      <p className="text-sm text-red-600">
        {(runQuery.error as Error).message}
      </p>
    );
  }
  const run = runQuery.data;
  if (!run) return null;

  const created = new Date(run.created_at).toLocaleString();
  const isDraft = run.status === "draft";
  const segCount = run.segments.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {segCount} candidate{segCount === 1 ? "" : "s"} ·{" "}
          {run.claim_count_at_run} claims · Run {created} · Status: {run.status}
        </p>
        <div className="flex items-center gap-2">
          {isDraft ? (
            <>
              <Button
                variant="ghost"
                disabled={discard.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Discard this detection draft? Segments and memberships will be archived (not deleted), but the run will no longer be active.",
                    )
                  ) {
                    discard.mutate();
                  }
                }}
              >
                {discard.isPending ? "Discarding…" : "Discard draft"}
              </Button>
              <Button
                variant="default"
                disabled={accept.isPending}
                onClick={() => accept.mutate()}
              >
                {accept.isPending ? "Accepting…" : "Accept & continue"}
              </Button>
            </>
          ) : (
            <DetectProcessesButton projectId={projectId} />
          )}
        </div>
      </div>

      {!isDraft && (
        <div className="rounded border bg-muted/40 p-3 text-sm">
          These processes are accepted. Generate maps from them on the{" "}
          <Link
            href={`/projects/${projectId}/maps`}
            className="font-medium underline"
          >
            Maps
          </Link>{" "}
          tab, or re-detect to start over.
        </div>
      )}

      {isDraft && segCount === 1 && (
        <div className="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          We found a single process. You can still rename and accept, or skip to
          direct generation.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-4">
          {run.segments.map((seg) => (
            <SegmentCard
              key={seg.id}
              projectId={projectId}
              runId={run.id}
              segment={seg}
              allSegments={run.segments}
              unassignedSegment={run.unassigned_segment}
              disabled={!isDraft}
            />
          ))}
          {isDraft && (
            <NewEmptyClusterButton projectId={projectId} runId={run.id} />
          )}
        </div>
        <aside className="space-y-4">
          {run.reasoning_summary && (
            <div className="rounded border p-3">
              <h2 className="text-sm font-semibold mb-2">Why these splits?</h2>
              <p className="text-xs text-muted-foreground whitespace-pre-line">
                {run.reasoning_summary}
              </p>
            </div>
          )}
          <div className="rounded border p-3">
            <h2 className="text-sm font-semibold">Unassigned</h2>
            <p className="text-xs text-muted-foreground">
              {run.unassigned_segment.claim_count} claim
              {run.unassigned_segment.claim_count === 1 ? "" : "s"}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
```

Notes for the implementer:
- The `detection-run` query key (`["detection-run", projectId, runId]`) is the exact key `SegmentCard`, `NewEmptyClusterButton`, `MergePopover`, and `MoveClaimPopover` already invalidate after edits — so renames/merges/moves/deletes refresh this page with no extra wiring.
- `current!.id` inside the mutations is safe: the mutations are only reachable from the State-B render branch, which only renders when `current` (and `run`) exist.
- Do **not** add an `<h1>` — the project layout already renders the project title and the tab bar labels this "Processes".

- [ ] **Step 2: Typecheck and lint**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: both exit 0. The page is reachable by direct URL (`/projects/<id>/processes`) even though no tab links to it yet.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/projects/[id]/processes/page.tsx"
git commit -m "feat(detection): Processes tab page with three render states

Resolves the current run (draft, else latest accepted) from listDetectionRuns
and renders no-run / draft / accepted states inline. Folds in the body of the
standalone detect/[runId] review route.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add the Processes tab to the project layout

Insert the tab between Conflicts and Maps.

**Files:**
- Modify: `src/app/(app)/projects/[id]/layout.tsx:9-15` (the `TABS` array)

- [ ] **Step 1: Add the tab entry**

In `src/app/(app)/projects/[id]/layout.tsx`, change the `TABS` array from:

```tsx
const TABS = [
  { slug: "", label: "Overview" },
  { slug: "documents", label: "Documents" },
  { slug: "claims", label: "Claims" },
  { slug: "conflicts", label: "Conflicts" },
  { slug: "maps", label: "Maps" },
] as const;
```

to:

```tsx
const TABS = [
  { slug: "", label: "Overview" },
  { slug: "documents", label: "Documents" },
  { slug: "claims", label: "Claims" },
  { slug: "conflicts", label: "Conflicts" },
  { slug: "processes", label: "Processes" },
  { slug: "maps", label: "Maps" },
] as const;
```

No other change to the layout — `currentSlug` already derives the active tab from the first path segment, so `/projects/[id]/processes` highlights correctly.

- [ ] **Step 2: Typecheck and lint**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/projects/[id]/layout.tsx"
git commit -m "feat(detection): add Processes tab between Conflicts and Maps

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Remove the Detect button from the Documents tab

Documents returns to upload/extract only. Detection now lives solely on the Processes tab.

**Files:**
- Modify: `src/app/(app)/projects/[id]/documents/page.tsx:27` (import) and `:84-88` (render)

- [ ] **Step 1: Remove the import**

In `src/app/(app)/projects/[id]/documents/page.tsx`, delete this line (currently line 27):

```tsx
import { DetectProcessesButton } from "@/components/detect-processes-button";
```

- [ ] **Step 2: Remove the button from the header actions**

Change the header actions block (currently lines 84-88) from:

```tsx
        <div className="flex items-center gap-2">
          <DetectProcessesButton projectId={id} />
          <UploadForm projectId={id} />
        </div>
```

to:

```tsx
        <div className="flex items-center gap-2">
          <UploadForm projectId={id} />
        </div>
```

(Keep the wrapping `<div>` — the parent `<div className="flex items-center justify-between">` relies on two children to push Upload to the right.)

- [ ] **Step 3: Typecheck and lint**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: both exit 0, with no "unused import" error (the import was removed in Step 1).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/projects/[id]/documents/page.tsx"
git commit -m "refactor(detection): remove Detect button from Documents tab

Detection now lives on the Processes tab; Documents is upload/extract only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Retire the standalone review route via redirect

Replace the body of `detect/[runId]/page.tsx` with a server-side redirect to `/projects/[id]/processes`. This guards bookmarks and any in-flight session without a content flash. The `[runId]` segment stays so the old URL pattern still matches and redirects.

**Files:**
- Modify: `src/app/(app)/projects/[id]/detect/[runId]/page.tsx` (full rewrite)

- [ ] **Step 1: Replace the file with a redirect**

Overwrite `src/app/(app)/projects/[id]/detect/[runId]/page.tsx` with:

```tsx
import { redirect } from "next/navigation";

/**
 * The detection review UI moved onto the Processes tab. This legacy route
 * (and any bookmarks to it) redirects there. In Next.js 16, `params` is a
 * Promise and must be awaited.
 */
export default async function DetectRunRedirect({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/processes`);
}
```

Important: this is a **server** component (no `"use client"`), and in Next.js 16 `params` is a `Promise` that must be `await`ed — destructuring it synchronously will fail typecheck/build. The `runId` is intentionally unused (we always land on the tab, which self-resolves the current run); naming it in the type but not destructuring it avoids an unused-variable lint error.

- [ ] **Step 2: Typecheck and lint**

Run:
```bash
npx tsc --noEmit && npm run lint
```
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/projects/[id]/detect/[runId]/page.tsx"
git commit -m "refactor(detection): redirect legacy /detect/[runId] to Processes tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full build + manual verification

No code changes — this task proves the whole change holds together and exercises every state by hand (the only end-to-end coverage available without a frontend test harness).

**Files:** none.

- [ ] **Step 1: Full production build**

Run:
```bash
npm run build
```
Expected: build succeeds. Confirm the route list it prints includes `/projects/[id]/processes` and still lists `/projects/[id]/detect/[runId]` (now the redirect). No type errors.

- [ ] **Step 2: Start the stack and walk the checklist**

Bring the app up (`./run-local.sh` if not already running; backend on :8000, frontend on :3000) and verify, against a project that has extracted claims:

1. The tab bar shows **Overview · Documents · Claims · Conflicts · Processes · Maps**, in that order. Clicking **Processes** highlights it.
2. On a project with **no claims**, the Processes tab shows the explainer and a **disabled** "Detect processes" button; hovering shows the "Extract claims from at least one document…" tooltip.
3. On a project **with claims and no runs**, the button is enabled. Click it → after the round-trip the tab shows the **draft** (segment cards, Accept & continue, Discard draft, New empty cluster) **without navigating away from `/processes`**. The Detect button is gone while the draft is shown.
4. In the draft: rename a segment (debounced), merge two, move a claim, delete a segment, add a new empty cluster — each refreshes the cards. The reasoning summary and Unassigned count render in the right aside.
5. Click **Discard draft** → confirm → you stay on `/processes`; it falls back to the accepted state (if one exists) or the no-runs state.
6. Re-detect, then click **Accept & continue** → you land on `/projects/[id]/maps?postAcceptRun=<runId>` and the post-accept generation panel appears.
7. Return to **Processes** with an accepted run and no draft: segments render **read-only** (no rename input enabled, no Merge/Move/Delete affordances), the "These processes are accepted… Maps tab" note shows, and a **Re-detect processes** button is present and works.
8. Visit a legacy URL `/projects/<id>/detect/<any-run-id>` directly → it redirects to `/projects/<id>/processes`.
9. The **Documents** tab no longer shows a Detect button — only Upload.

- [ ] **Step 3: Record results**

If every check passes, the feature is complete. If any check fails, fix forward (typically in `processes/page.tsx` or `detect-processes-button.tsx`), re-run Step 1, and re-verify the affected checks before considering the plan done. There is no commit in this task unless a fix was needed.

---

## Self-review notes

- **Spec coverage:** tab insertion (Task 3), three states + current-run resolution (Task 2), button repurpose incl. dropped "Resume draft" label (Task 1), Documents removal (Task 4), redirect retirement (Task 5), accept→Maps handoff preserved (Task 2 `accept` mutation), read-only State C via `disabled` prop (Task 2), no backend change (none present), test gates = tsc/lint/build + manual (Task 6). All spec sections map to a task.
- **No new types/methods:** every API call (`listDetectionRuns`, `getDetectionRun`, `detectProcesses`, `acceptDetectionRun`, `discardDetectionRun`, `listInputs`) and type (`DetectionRunListRow`, `DetectionRunDetail`, `ProcessSegment`, `UUID`) already exists in `src/lib/api.ts` / `src/lib/types.ts`. Child components (`SegmentCard`, `NewEmptyClusterButton`) are used with their existing prop shapes.
- **Query-key consistency:** the page reads/invalidates `["detection-runs", projectId]` and `["detection-run", projectId, runId]` — the same keys the button and the segment child-components use, so caches stay coherent with no extra fetches.
