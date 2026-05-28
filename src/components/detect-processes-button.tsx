"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { UUID } from "@/lib/types";

export function DetectProcessesButton({ projectId }: { projectId: UUID }) {
  const router = useRouter();
  const qc = useQueryClient();

  const runsQuery = useQuery({
    queryKey: ["detection-runs", projectId],
    queryFn: () => api.listDetectionRuns(projectId),
  });

  const draft = runsQuery.data?.find((r) => r.status === "draft");
  const accepted = runsQuery.data?.find((r) => r.status === "accepted");

  const detect = useMutation({
    mutationFn: () => api.detectProcesses(projectId),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["detection-runs", projectId] });
      router.push(`/projects/${projectId}/detect/${run.id}`);
    },
    onError: (e: Error) => toast.error(`Detection failed: ${e.message}`),
  });

  const onClick = () => {
    if (draft) {
      router.push(`/projects/${projectId}/detect/${draft.id}`);
      return;
    }
    detect.mutate();
  };

  let label = "Detect processes";
  if (detect.isPending) label = "Detecting…";
  else if (draft) label = `Resume draft (${draft.segment_count} segments)`;
  else if (accepted) label = "Re-detect processes";

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        onClick={onClick}
        disabled={detect.isPending}
      >
        {label}
      </Button>
      {accepted && !draft && (
        <Badge variant="outline">{accepted.segment_count} accepted</Badge>
      )}
    </div>
  );
}
