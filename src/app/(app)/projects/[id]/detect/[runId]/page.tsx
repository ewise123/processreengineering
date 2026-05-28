"use client";

import { useRouter } from "next/navigation";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

export default function DetectionReviewPage() {
  const params = useParams<{ id: string; runId: string }>();
  const projectId = params.id;
  const runId = params.runId;
  const router = useRouter();
  const qc = useQueryClient();

  const runQuery = useQuery({
    queryKey: ["detection-run", projectId, runId],
    queryFn: () => api.getDetectionRun(projectId, runId),
  });

  const accept = useMutation({
    mutationFn: () => api.acceptDetectionRun(projectId, runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-runs", projectId] });
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      router.push(`/projects/${projectId}/maps?postAcceptRun=${runId}`);
    },
    onError: (e: Error) => toast.error(`Accept failed: ${e.message}`),
  });

  if (runQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (runQuery.error) {
    return (
      <p className="text-sm text-red-600">{(runQuery.error as Error).message}</p>
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
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Detected processes
          </h1>
          <p className="text-sm text-muted-foreground">
            {segCount} candidates · {run.claim_count_at_run} claims · Run{" "}
            {created} · Status: {run.status}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="default"
            disabled={!isDraft || accept.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? "Accepting…" : "Accept & continue"}
          </Button>
        </div>
      </div>

      {segCount === 1 && (
        <div className="rounded border border-amber-400 bg-amber-50 p-3 text-sm">
          We found a single process. You can still rename and accept, or skip to
          direct generation.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-4">
          {/* segment cards mounted in Task 21 */}
          <p className="text-sm text-muted-foreground">
            ({segCount} segments — cards rendered in the next task.)
          </p>
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
