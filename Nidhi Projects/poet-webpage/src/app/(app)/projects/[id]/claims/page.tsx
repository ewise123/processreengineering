"use client";

import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { CLAIM_KINDS } from "@/lib/types";

export default function ClaimsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["claims", id],
    queryFn: () => api.listClaims(id, { limit: 500 }),
  });

  const counts: Record<string, number> = Object.fromEntries(
    CLAIM_KINDS.map((k) => [k, 0])
  );
  if (data) {
    for (const c of data.items) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {CLAIM_KINDS.map((k) => (
          <Badge key={k} variant="outline" className="text-xs">
            {k.replace(/_/g, " ")}: {counts[k] ?? 0}
          </Badge>
        ))}
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
              <TableHead className="w-32">Kind</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="w-24">Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-8">
                  No claims yet. Upload documents and click "Extract claims".
                </TableCell>
              </TableRow>
            )}
            {data.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Badge variant="secondary">{c.kind.replace(/_/g, " ")}</Badge>
                </TableCell>
                <TableCell>{c.subject}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {c.confidence != null ? c.confidence.toFixed(2) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
