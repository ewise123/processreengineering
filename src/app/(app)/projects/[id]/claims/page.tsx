"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
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
import { CLAIM_KINDS } from "@/lib/types";

const PAGE_SIZE = 50;

export default function ClaimsPage() {
  const { id } = useParams<{ id: string }>();
  const [offset, setOffset] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ["claims", id, "page", offset],
    queryFn: () => api.listClaims(id, { limit: PAGE_SIZE, offset }),
  });

  // Kind counts: derived from this page only — we surface that in the label
  const counts: Record<string, number> = Object.fromEntries(
    CLAIM_KINDS.map((k) => [k, 0])
  );
  if (data) {
    for (const c of data.items) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }

  const total = data?.total ?? 0;
  const start = total === 0 ? 0 : offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Kind counts on this page (of {total} total):
      </p>
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
                  No claims yet. Upload documents and click &quot;Extract claims&quot;.
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

      {data && total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground tabular-nums">
            {start}–{end} of {total}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={!hasPrev}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={!hasNext}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
