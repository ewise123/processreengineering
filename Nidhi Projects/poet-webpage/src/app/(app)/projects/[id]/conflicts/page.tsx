"use client";

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
    },
    onError: (e: Error) => toast.error(`Detection failed: ${e.message}`),
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
              <TableHead>Reason</TableHead>
              <TableHead className="w-24">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
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
                    {c.resolution_notes ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{c.resolution_status}</Badge>
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
