"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { groupByBatch } from "./inbox-grouping";
import { api } from "@/lib/api";
import type { ProcessSuggestion, UUID } from "@/lib/types";

/** Reusable per-item accept/reject diff surface, grouped by batch. Phase 2
 * uses it for process_discovery; sp7c reuses it for map_reconcile on the
 * canvas. */
export function SuggestionInbox({
  projectId,
  suggestions,
}: {
  projectId: UUID;
  suggestions: ProcessSuggestion[];
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["suggestions", projectId] });
    qc.invalidateQueries({ queryKey: ["processes", projectId] });
    qc.invalidateQueries({ queryKey: ["unassigned", projectId] });
  };

  const accept = useMutation({
    mutationFn: (id: UUID) => api.acceptSuggestion(projectId, id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Accept failed: ${e.message}`),
  });
  const reject = useMutation({
    mutationFn: (id: UUID) => api.rejectSuggestion(projectId, id),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Reject failed: ${e.message}`),
  });
  const acceptBatch = useMutation({
    mutationFn: (batchId: UUID) => api.acceptSuggestionBatch(projectId, batchId),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Accept all failed: ${e.message}`),
  });

  const batches = groupByBatch(suggestions);
  if (batches.length === 0) return null;

  return (
    <div className="space-y-4">
      {batches.map((batch) => (
        <div key={batch.batchId} className="rounded border">
          <div className="flex items-center justify-between border-b p-2">
            <span className="text-sm font-medium">
              Suggestion batch · {batch.pendingCount} pending
            </span>
            {batch.pendingCount > 0 && (
              <Button
                size="sm"
                onClick={() => acceptBatch.mutate(batch.batchId as UUID)}
                disabled={acceptBatch.isPending}
              >
                Accept all
              </Button>
            )}
          </div>
          <ul className="divide-y">
            {batch.suggestions.map((s) => {
              const name = (s.payload as { name?: string }).name ?? s.op;
              const claimIds = (s.payload as { claim_ids?: string[] }).claim_ids ?? [];
              return (
                <li key={s.id} className="flex items-start justify-between gap-2 p-3">
                  <div className="flex-1">
                    <div className="text-sm font-medium">
                      {s.op === "create_process" ? "Create process: " : "Assign claims to: "}
                      {name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {claimIds.length} claim(s)
                      {s.confidence != null && ` · confidence ${(s.confidence * 100).toFixed(0)}%`}
                    </div>
                    {s.rationale && (
                      <p className="mt-1 text-xs text-muted-foreground">{s.rationale}</p>
                    )}
                  </div>
                  {s.status === "pending" ? (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        onClick={() => accept.mutate(s.id)}
                        disabled={accept.isPending && accept.variables === s.id}
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => reject.mutate(s.id)}
                        disabled={reject.isPending && reject.variables === s.id}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <Badge variant={s.status === "accepted" ? "default" : "secondary"}>
                      {s.status}
                      {s.outcome === "target_gone" ? " (target gone)" : ""}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
