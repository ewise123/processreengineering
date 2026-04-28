"use client";

import { X } from "lucide-react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { UUID } from "@/lib/types";

export function IssuesPanel({
  projectId,
  selectedNodeId,
  onClose,
}: {
  projectId: UUID;
  selectedNodeId: UUID | null;
  onClose: () => void;
}) {
  const { data: conflictsPage, isLoading, error } = useQuery({
    queryKey: ["conflicts", projectId],
    queryFn: () => api.listConflicts(projectId, { limit: 500 }),
  });
  const { data: claimsPage } = useQuery({
    queryKey: ["claims", projectId, "page", 0],
    queryFn: () => api.listClaims(projectId, { limit: 500 }),
  });
  const { data: nodeCitations } = useQuery({
    queryKey: ["node-citations", projectId, selectedNodeId],
    queryFn: () =>
      selectedNodeId
        ? api.getNodeCitations(projectId, selectedNodeId)
        : Promise.resolve(null),
    enabled: !!selectedNodeId,
  });

  const claimById = useMemo(() => {
    const m = new Map<string, { subject: string; kind: string }>();
    if (claimsPage)
      for (const c of claimsPage.items)
        m.set(c.id, { subject: c.subject, kind: c.kind });
    return m;
  }, [claimsPage]);

  const selectedClaimIds = useMemo(() => {
    return new Set(nodeCitations?.claims.map((c) => c.id) ?? []);
  }, [nodeCitations]);

  const conflicts = conflictsPage?.items ?? [];
  const highlighted = conflicts.filter(
    (c) => selectedClaimIds.has(c.claim_a_id) || selectedClaimIds.has(c.claim_b_id)
  );
  const others = conflicts.filter(
    (c) => !selectedClaimIds.has(c.claim_a_id) && !selectedClaimIds.has(c.claim_b_id)
  );

  return (
    <div className="flex h-full w-[360px] flex-col border-l bg-white shadow-xl">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Issues
          </p>
          <h2 className="text-sm font-semibold">
            {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
            {highlighted.length > 0 &&
              ` · ${highlighted.length} on selection`}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
          <X size={16} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {isLoading && (
          <p className="px-1 text-sm text-muted-foreground">Loading…</p>
        )}
        {error && (
          <p className="px-1 text-sm text-red-600">
            {(error as Error).message}
          </p>
        )}

        {conflicts.length === 0 && !isLoading && (
          <p className="px-1 text-sm text-muted-foreground">
            No conflicts in this project. Run conflict detection from the
            Conflicts tab to scan.
          </p>
        )}

        {highlighted.length > 0 && (
          <div className="mb-3">
            <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
              On selected node
            </p>
            <ul className="space-y-2">
              {highlighted.map((c) => (
                <ConflictItem
                  key={c.id}
                  conflict={c}
                  claimById={claimById}
                  highlighted
                />
              ))}
            </ul>
          </div>
        )}

        {others.length > 0 && (
          <div>
            {highlighted.length > 0 && (
              <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Project-wide
              </p>
            )}
            <ul className="space-y-2">
              {others.map((c) => (
                <ConflictItem
                  key={c.id}
                  conflict={c}
                  claimById={claimById}
                  highlighted={false}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ConflictItem({
  conflict,
  claimById,
  highlighted,
}: {
  conflict: { id: UUID; claim_a_id: UUID; claim_b_id: UUID; kind: string; resolution_status: string; resolution_notes: string | null };
  claimById: Map<string, { subject: string; kind: string }>;
  highlighted: boolean;
}) {
  const a = claimById.get(conflict.claim_a_id);
  const b = claimById.get(conflict.claim_b_id);
  return (
    <li
      className={`rounded-md border px-3 py-2 text-xs shadow-sm ${highlighted ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"}`}
    >
      <div className="flex items-center gap-2">
        <Badge variant="destructive" className="text-[10px]">
          {conflict.kind.replace(/_/g, " ")}
        </Badge>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
          {conflict.resolution_status}
        </span>
      </div>
      <p className="mt-2 leading-snug">
        <span className="text-slate-500">A: </span>
        {a?.subject ?? <span className="text-muted-foreground">Unknown claim</span>}
      </p>
      <p className="mt-1 leading-snug">
        <span className="text-slate-500">B: </span>
        {b?.subject ?? <span className="text-muted-foreground">Unknown claim</span>}
      </p>
      {conflict.resolution_notes && (
        <p className="mt-2 text-[11px] italic text-slate-600">
          {conflict.resolution_notes}
        </p>
      )}
    </li>
  );
}
