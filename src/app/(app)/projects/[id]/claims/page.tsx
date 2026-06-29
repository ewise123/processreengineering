"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { CLAIM_KINDS, type Claim, type ClaimImpact } from "@/lib/types";

const PAGE_SIZE = 50;

export default function ClaimsPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Claim | null>(null);
  const [deleting, setDeleting] = useState<Claim | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["claims", id, "page", offset],
    queryFn: () => api.listClaims(id, { limit: PAGE_SIZE, offset }),
  });

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

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["claims", id] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Kind counts on this page (of {total} total):
        </p>
        <AddClaimDialog projectId={id} onSaved={invalidate} />
      </div>
      <div className="flex flex-wrap gap-2">
        {CLAIM_KINDS.map((k) => (
          <Badge key={k} variant="outline" className="text-xs">
            {k.replace(/_/g, " ")}: {counts[k] ?? 0}
          </Badge>
        ))}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="text-sm text-red-600">{(error as Error).message}</p>
      )}

      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Kind</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="w-20">Source</TableHead>
              <TableHead className="w-24">Confidence</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-sm text-muted-foreground py-8"
                >
                  No claims yet. Upload documents and click &quot;Extract
                  claims&quot;, or add one manually.
                </TableCell>
              </TableRow>
            )}
            {data.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Badge variant="secondary">{c.kind.replace(/_/g, " ")}</Badge>
                </TableCell>
                <TableCell>{c.subject}</TableCell>
                <TableCell>
                  <Badge
                    variant={c.source === "manual" ? "default" : "outline"}
                    className="text-[10px]"
                  >
                    {c.source}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {c.confidence != null ? c.confidence.toFixed(2) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(c)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeleting(c)}
                    >
                      Delete
                    </Button>
                  </div>
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

      {editing && (
        <EditClaimDialog
          projectId={id}
          claim={editing}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      )}
      {deleting && (
        <DeleteClaimDialog
          projectId={id}
          claim={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={invalidate}
        />
      )}
    </div>
  );
}

function AddClaimDialog({
  projectId,
  onSaved,
}: {
  projectId: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>(CLAIM_KINDS[0]);
  const [subject, setSubject] = useState("");

  const create = useMutation({
    mutationFn: () =>
      api.createClaim(projectId, { kind, subject: subject.trim() }),
    onSuccess: () => {
      toast.success("Claim added.");
      onSaved();
      setOpen(false);
    },
    onError: (e: Error) => toast.error(`Add failed: ${e.message}`),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setSubject("");
          setKind(CLAIM_KINDS[0]);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>Add claim</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a manual claim</DialogTitle>
          <DialogDescription>
            Manual claims survive re-extraction and are badged as manual.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="claim-kind">Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="claim-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLAIM_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="claim-subject">Subject *</Label>
            <Input
              id="claim-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Invoices over $5k require manager approval"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!subject.trim() || create.isPending}
          >
            {create.isPending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditClaimDialog({
  projectId,
  claim,
  onClose,
  onSaved,
}: {
  projectId: string;
  claim: Claim;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState(claim.kind);
  const [subject, setSubject] = useState(claim.subject);

  const update = useMutation({
    mutationFn: () =>
      api.updateClaim(projectId, claim.id, { kind, subject: subject.trim() }),
    onSuccess: () => {
      toast.success("Claim updated.");
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast.error(`Update failed: ${e.message}`),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit claim</DialogTitle>
          <DialogDescription>
            Update the kind and subject of this claim.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-kind">Kind</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="edit-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CLAIM_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-subject">Subject *</Label>
            <Input
              id="edit-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => update.mutate()}
            disabled={!subject.trim() || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteClaimDialog({
  projectId,
  claim,
  onClose,
  onDeleted,
}: {
  projectId: string;
  claim: Claim;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { data: impact, isLoading } = useQuery<ClaimImpact>({
    queryKey: ["claim-impact", projectId, claim.id],
    queryFn: () => api.getClaimImpact(projectId, claim.id),
  });

  const del = useMutation({
    mutationFn: () => api.deleteClaim(projectId, claim.id),
    onSuccess: () => {
      toast.success("Claim deleted.");
      onDeleted();
      onClose();
    },
    onError: (e: Error) => toast.error(`Delete failed: ${e.message}`),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this claim?</DialogTitle>
          <DialogDescription>
            &ldquo;{claim.subject}&rdquo; — this drops its citations, node links,
            and any conflicts. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="text-sm">
          {isLoading && (
            <p className="text-muted-foreground">Checking affected maps…</p>
          )}
          {impact && impact.maps.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="font-medium text-amber-800">
                Empties node evidence in {impact.maps.length} map
                {impact.maps.length === 1 ? "" : "s"}:
              </p>
              <ul className="mt-1 list-disc pl-5 text-amber-700">
                {impact.maps.map((m) => (
                  <li key={m.model_id}>{m.name}</li>
                ))}
              </ul>
            </div>
          )}
          {impact && impact.maps.length === 0 && (
            <p className="text-muted-foreground">
              No process maps cite this claim.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={del.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => del.mutate()}
            disabled={del.isPending || isLoading}
          >
            {del.isPending ? "Deleting…" : "Delete claim"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
