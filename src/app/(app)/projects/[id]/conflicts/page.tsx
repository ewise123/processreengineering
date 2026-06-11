"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import type { ClaimConflict } from "@/lib/types";

export default function ConflictsPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const { data: claims } = useQuery({
    queryKey: ["claims", id],
    queryFn: () => api.listClaims(id, { limit: 500 }),
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ["conflicts", id],
    queryFn: () => api.listConflicts(id, { limit: 500 }),
  });

  const detect = useMutation({
    mutationFn: () => api.detectConflicts(id),
    onSuccess: (res) => {
      toast.success(
        `Scanned ${res.claim_count} claim(s) — ${res.new_conflict_count} new conflict(s).`
      );
      qc.invalidateQueries({ queryKey: ["conflicts", id] });
      // Defensive: ensures the Claims tab refetches even if the user navigates
      // back during the long detection round-trip. Detection itself doesn't
      // mutate claims, but co-invalidating prevents any stale render.
      qc.invalidateQueries({ queryKey: ["claims", id] });
    },
    onError: (e: Error) => toast.error(`Detection failed: ${e.message}`),
  });

  const resolve = useMutation({
    mutationFn: (vars: {
      conflictId: string;
      resolution_status: string;
      resolution_notes: string | null;
    }) =>
      api.resolveConflict(id, vars.conflictId, {
        resolution_status: vars.resolution_status,
        resolution_notes: vars.resolution_notes,
      }),
    onSuccess: () => {
      toast.success("Conflict updated.");
      qc.invalidateQueries({ queryKey: ["conflicts", id] });
    },
    onError: (e: Error) => toast.error(`Update failed: ${e.message}`),
  });

  const claimById = new Map(claims?.items.map((c) => [c.id, c]) ?? []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Contradictions found across claims. Run detection after extracting
          claims from new documents.
        </p>
        <Button onClick={() => detect.mutate()} disabled={detect.isPending}>
          {detect.isPending ? "Scanning…" : "Run detection"}
        </Button>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {error && (
        <p className="text-sm text-red-600">{(error as Error).message}</p>
      )}

      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Kind</TableHead>
              <TableHead>Claim A</TableHead>
              <TableHead>Claim B</TableHead>
              <TableHead>Reason (AI)</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-80">Resolution</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                  No conflicts. Run detection once you have claims.
                </TableCell>
              </TableRow>
            )}
            {data.items.map((c) => {
              const a = claimById.get(c.claim_a_id);
              const b = claimById.get(c.claim_b_id);
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    <Badge variant="destructive">
                      {c.kind.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {a ? a.subject : <span className="text-muted-foreground">{c.claim_a_id.slice(0, 8)}…</span>}
                  </TableCell>
                  <TableCell className="text-sm">
                    {b ? b.subject : <span className="text-muted-foreground">{c.claim_b_id.slice(0, 8)}…</span>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {c.detection_reason ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.resolution_status}</Badge>
                  </TableCell>
                  <TableCell>
                    <ResolutionControls
                      conflict={c}
                      pending={resolve.isPending}
                      onSubmit={(resolution_status, resolution_notes) =>
                        resolve.mutate({
                          conflictId: c.id,
                          resolution_status,
                          resolution_notes,
                        })
                      }
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ResolutionControls({
  conflict,
  pending,
  onSubmit,
}: {
  conflict: ClaimConflict;
  pending: boolean;
  onSubmit: (status: string, notes: string | null) => void;
}) {
  const [notes, setNotes] = useState(conflict.resolution_notes ?? "");
  const isOpen = conflict.resolution_status === "detected";
  return (
    <div className="flex flex-col gap-1.5">
      <input
        aria-label="Resolution notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Resolution notes (optional)"
        className="w-full rounded-md border border-slate-200 px-2 py-1 text-xs focus:border-slate-500 focus:outline-none"
      />
      <div className="flex gap-1">
        {isOpen ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onSubmit("resolved", notes.trim() || null)}
            >
              Resolve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onSubmit("dismissed", notes.trim() || null)}
            >
              Dismiss
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => onSubmit("detected", notes.trim() || null)}
          >
            Reopen
          </Button>
        )}
      </div>
    </div>
  );
}
