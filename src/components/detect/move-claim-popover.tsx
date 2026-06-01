"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import type { ProcessSegment, UUID } from "@/lib/types";

export function MoveClaimPopover({
  projectId,
  runId,
  claimId,
  currentSegmentId,
  candidates,
}: {
  projectId: UUID;
  runId: UUID;
  claimId: UUID;
  currentSegmentId: UUID;
  candidates: ProcessSegment[];
}) {
  const qc = useQueryClient();
  const move = useMutation({
    mutationFn: (toId: UUID) =>
      api.moveClaimToSegment(projectId, toId, { claim_id: claimId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
    },
    onError: (e: Error) => toast.error(`Move failed: ${e.message}`),
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          Move ↓
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2">
        <p className="text-xs text-muted-foreground mb-2 px-1">Move to…</p>
        <div className="space-y-1 max-h-72 overflow-auto">
          {candidates
            .filter((c) => c.id !== currentSegmentId)
            .map((c) => (
              <button
                key={c.id}
                disabled={move.isPending}
                onClick={() => move.mutate(c.id)}
                className="w-full text-left text-sm px-2 py-1 rounded hover:bg-muted"
              >
                {c.name || "(unnamed)"}
                {c.is_unassigned && (
                  <span className="ml-2 text-muted-foreground text-xs">
                    · unassigned
                  </span>
                )}
              </button>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
