"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { MoveClaimPopover } from "@/components/detect/move-claim-popover";
import { MergePopover } from "@/components/detect/merge-popover";
import type { ProcessSegment, UUID } from "@/lib/types";

const RENAME_DEBOUNCE_MS = 400;

export function SegmentCard({
  projectId,
  runId,
  segment,
  allSegments,
  unassignedSegment,
  disabled,
}: {
  projectId: UUID;
  runId: UUID;
  segment: ProcessSegment;
  allSegments: ProcessSegment[];
  unassignedSegment: ProcessSegment;
  disabled: boolean;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(segment.name);

  useEffect(() => setName(segment.name), [segment.name]);

  const renameMutation = useMutation({
    mutationFn: (newName: string) =>
      api.updateSegment(projectId, segment.id, { name: newName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
    },
    onError: (e: Error) => toast.error(`Rename failed: ${e.message}`),
  });

  useEffect(() => {
    if (disabled || name === segment.name) return;
    const t = setTimeout(
      () => renameMutation.mutate(name),
      RENAME_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [name]);

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteSegment(projectId, segment.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["detection-run", projectId, runId] });
    },
    onError: (e: Error) => toast.error(`Delete failed: ${e.message}`),
  });

  const low = (segment.confidence ?? 1) < 0.5;
  const candidates = [...allSegments, unassignedSegment];

  return (
    <div
      className={`rounded border p-3 space-y-2 ${low ? "border-amber-400" : ""}`}
    >
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled}
          className="font-medium"
          maxLength={300}
        />
        {segment.confidence != null && (
          <Badge variant={low ? "destructive" : "outline"}>
            {segment.confidence.toFixed(2)}
          </Badge>
        )}
        <Badge variant="secondary">{segment.claim_count}</Badge>
        {!disabled && (
          <MergePopover
            projectId={projectId}
            runId={runId}
            source={segment}
            candidates={candidates}
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || deleteMutation.isPending}
          onClick={() => deleteMutation.mutate()}
        >
          Delete
        </Button>
      </div>
      {segment.description && (
        <p className="text-xs text-muted-foreground">{segment.description}</p>
      )}
      <ul className="space-y-1 max-h-72 overflow-auto">
        {segment.claims.map((cl) => (
          <li
            key={cl.id}
            className="flex items-center justify-between text-sm px-1"
          >
            <span className="truncate">
              <Badge variant="outline" className="mr-2 uppercase text-[10px]">
                {cl.kind}
              </Badge>
              {cl.subject}
            </span>
            {!disabled && (
              <MoveClaimPopover
                projectId={projectId}
                runId={runId}
                claimId={cl.id}
                currentSegmentId={segment.id}
                candidates={candidates}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
