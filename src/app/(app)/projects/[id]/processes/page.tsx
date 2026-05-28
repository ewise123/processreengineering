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
    queryKey: ["detection-run", projectId, current?.id ?? null],
    queryFn: () => api.getDetectionRun(projectId, current!.id),
    enabled: !!current,
  });

  const accept = useMutation({
    mutationFn: () => api.acceptDetectionRun(projectId, current!.id),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["detection-runs", projectId] });
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      router.push(`/projects/${projectId}/maps?postAcceptRun=${data.run_id}`);
    },
    onError: (e: Error) => toast.error(`Accept failed: ${e.message}`),
  });

  const discard = useMutation({
    mutationFn: (runId: string) => api.discardDetectionRun(projectId, runId),
    onSuccess: (_data, runId) => {
      qc.invalidateQueries({ queryKey: ["detection-runs", projectId] });
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
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
  // Checked before the run-detail read below: after a discard, `current` can
  // resolve to null while runQuery still holds stale data — landing here first
  // keeps that transient from rendering a half-state.
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
                    discard.mutate(current!.id);
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
