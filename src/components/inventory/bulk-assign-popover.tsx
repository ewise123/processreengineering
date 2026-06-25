"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import type { Process, UUID } from "@/lib/types";

/** Assign the given claim ids to one or more processes (multi-select).
 * Each chosen process gets a bulk assign call. */
export function BulkAssignPopover({
  projectId,
  processes,
  claimIds,
  onAssigned,
}: {
  projectId: UUID;
  processes: Process[];
  claimIds: UUID[];
  onAssigned: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<UUID>>(new Set());

  const assign = useMutation({
    mutationFn: async () => {
      for (const pid of chosen) {
        await api.assignClaims(projectId, pid, claimIds);
      }
    },
    onSuccess: () => {
      toast.success(`Assigned ${claimIds.length} claim(s) to ${chosen.size} process(es).`);
      qc.invalidateQueries({ queryKey: ["processes", projectId] });
      qc.invalidateQueries({ queryKey: ["unassigned", projectId] });
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      setChosen(new Set());
      setOpen(false);
      onAssigned();
    },
    onError: (e: Error) => toast.error(`Assign failed: ${e.message}`),
  });

  const active = processes.filter((p) => p.status === "active");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" disabled={claimIds.length === 0}>
          Assign {claimIds.length} selected…
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2">
        <p className="text-xs text-muted-foreground">Assign to one or more processes:</p>
        <ul className="max-h-56 space-y-1 overflow-auto">
          {active.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={chosen.has(p.id)}
                  onChange={() => {
                    setChosen((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    });
                  }}
                />
                {p.name}
              </label>
            </li>
          ))}
          {active.length === 0 && (
            <li className="text-xs text-muted-foreground">No active processes. Add one first.</li>
          )}
        </ul>
        <Button
          size="sm"
          className="w-full"
          disabled={chosen.size === 0 || assign.isPending}
          onClick={() => assign.mutate()}
        >
          {assign.isPending ? "Assigning…" : "Assign"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
