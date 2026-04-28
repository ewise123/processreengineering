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
import { UploadForm } from "@/components/upload-form";

export default function DocumentsPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["inputs", id],
    queryFn: () => api.listInputs(id, { limit: 200 }),
  });

  const extract = useMutation({
    mutationFn: ({ inputId }: { inputId: string }) =>
      api.extractClaims(id, inputId),
    onSuccess: (res) => {
      toast.success(
        `Extracted ${res.claim_count} claim(s) from input.`
      );
      qc.invalidateQueries({ queryKey: ["claims", id] });
      // Re-extracting wipes prior claims for this input, so any cached
      // conflicts referencing them are now stale.
      qc.invalidateQueries({ queryKey: ["conflicts", id] });
    },
    onError: (e: Error) => toast.error(`Extraction failed: ${e.message}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Upload documents (interviews, SOPs, policies, …) to feed the claim
          extractor and process generator.
        </p>
        <UploadForm projectId={id} />
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
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                  No documents yet. Upload one to get started.
                </TableCell>
              </TableRow>
            )}
            {data.items.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {row.type.replace(/_/g, " ")}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {row.file_size != null ? formatBytes(row.file_size) : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {new Date(row.created_at).toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      row.status !== "parsed" ||
                      (extract.isPending && extract.variables?.inputId === row.id)
                    }
                    onClick={() => extract.mutate({ inputId: row.id })}
                  >
                    {extract.isPending && extract.variables?.inputId === row.id
                      ? "Extracting…"
                      : "Extract claims"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "parsed") return "default";
  if (s === "failed") return "destructive";
  if (s === "parsing") return "secondary";
  return "outline";
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
