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

export function MergePopover({
  projectId,
  runId,
  source,
  candidates,
}: {
  projectId: UUID;
  runId: UUID;
  source: ProcessSegment;
  candidates: ProcessSegment[];
}) {
  const qc = useQueryClient();
  const merge = useMutation({
    mutationFn: (intoId: UUID) =>
      api.mergeSegment(projectId, source.id, { into_segment_id: intoId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
    },
    onError: (e: Error) => toast.error(`Merge failed: ${e.message}`),
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          Merge
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2">
        <p className="text-xs text-muted-foreground mb-2 px-1">Merge into…</p>
        <div className="space-y-1 max-h-72 overflow-auto">
          {candidates
            .filter((c) => c.id !== source.id && !c.is_unassigned)
            .map((c) => (
              <button
                key={c.id}
                disabled={merge.isPending}
                onClick={() => merge.mutate(c.id)}
                className="w-full text-left text-sm px-2 py-1 rounded hover:bg-muted"
              >
                {c.name || "(unnamed)"}
              </button>
            ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
