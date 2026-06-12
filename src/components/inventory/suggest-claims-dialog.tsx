"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { isSelected, selectAll, toggleSelection } from "./triage-selection";
import type { ClaimMatchCandidate, UUID } from "@/lib/types";

/** Deselect-preview of AI-suggested claims for one process. Pre-checks every
 * candidate; "Add" links the ticked subset via the existing bulk-assign call. */
export function SuggestClaimsDialog({
  projectId,
  processId,
  processName,
  candidates,
  open,
  onOpenChange,
}: {
  projectId: UUID;
  processId: UUID;
  processName: string;
  candidates: ClaimMatchCandidate[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  // Pre-check all candidates whenever a fresh set arrives.
  useEffect(() => {
    setChosen(selectAll(candidates.map((c) => c.claim_id)));
  }, [candidates]);

  const add = useMutation({
    mutationFn: () =>
      api.assignClaims(projectId, processId, Array.from(chosen) as UUID[]),
    onSuccess: (res) => {
      toast.success(`Added ${res.linked} claim(s) to "${processName}".`);
      qc.invalidateQueries({ queryKey: ["processes", projectId] });
      qc.invalidateQueries({ queryKey: ["unassigned", projectId] });
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(`Add failed: ${e.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Suggested claims for &ldquo;{processName}&rdquo;</DialogTitle>
          <DialogDescription>
            Untick any that don&apos;t belong, then add the rest. Selected claims
            are linked to this process.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 space-y-2 overflow-auto">
          {candidates.map((c) => (
            <li key={c.claim_id} className="rounded border p-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={isSelected(chosen, c.claim_id)}
                  onChange={() => setChosen((prev) => toggleSelection(prev, c.claim_id))}
                />
                <span className="flex-1">
                  <span className="flex items-center gap-2">
                    <Badge variant="outline">{c.kind}</Badge>
                    {c.confidence != null && (
                      <span className="text-xs text-muted-foreground">
                        {(c.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                    {c.in_other_processes && (
                      <span className="text-xs text-amber-600">also in another process</span>
                    )}
                  </span>
                  <span className="mt-0.5 block font-medium">{c.subject}</span>
                  {c.rationale && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {c.rationale}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} disabled={chosen.size === 0 || add.isPending}>
            {add.isPending ? "Adding…" : `Add ${chosen.size} claim${chosen.size === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
