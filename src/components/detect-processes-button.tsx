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
