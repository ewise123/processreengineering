"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BulkAssignPopover } from "./bulk-assign-popover";
import { toggleSelection, selectAll, clearSelection } from "./triage-selection";
import type { Process, TriageClaim, UUID } from "@/lib/types";

export function ClaimTriagePanel({
  projectId,
  processes,
  claims,
}: {
  projectId: UUID;
  processes: Process[];
  claims: TriageClaim[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  return (
    <div className="space-y-3 rounded border p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          Unassigned claims{" "}
          <span className="text-muted-foreground">({claims.length})</span>
        </h2>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(selectAll(claims.map((c) => c.id)))}
            disabled={claims.length === 0}
          >
            Select all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(clearSelection())} disabled={selected.size === 0}>
            Clear
          </Button>
          <BulkAssignPopover
            projectId={projectId}
            processes={processes}
            claimIds={[...selected] as UUID[]}
            onAssigned={() => setSelected(clearSelection())}
          />
        </div>
      </div>

      <ul className="max-h-[28rem] space-y-1 overflow-auto">
        {claims.map((c) => (
          <li key={c.id}>
            <label className="flex items-start gap-2 rounded p-2 text-sm hover:bg-muted/40">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(c.id)}
                onChange={() => setSelected((prev) => toggleSelection(prev, c.id))}
              />
              <span className="flex-1">
                <span className="text-muted-foreground">[{c.kind}]</span> {c.subject}
              </span>
              {c.source === "manual" && <Badge variant="outline">manual</Badge>}
            </label>
          </li>
        ))}
        {claims.length === 0 && (
          <li className="p-2 text-sm text-muted-foreground">
            Every claim is assigned to at least one process. Nothing to triage.
          </li>
        )}
      </ul>
    </div>
  );
}
