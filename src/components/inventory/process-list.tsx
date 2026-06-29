"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { SuggestClaimsDialog } from "./suggest-claims-dialog";
import type { ClaimMatchCandidate, Process, UUID } from "@/lib/types";

export function ProcessList({
  projectId,
  processes,
}: {
  projectId: UUID;
  processes: Process[];
}) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<UUID | null>(null);
  const [editName, setEditName] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["processes", projectId] });
    qc.invalidateQueries({ queryKey: ["unassigned", projectId] });
    qc.invalidateQueries({ queryKey: ["maps", projectId] });
  };

  const create = useMutation({
    mutationFn: (name: string) => api.createProcess(projectId, { name }),
    onSuccess: (_data, name) => {
      setNewName("");
      invalidate();
      toast.success(`Process "${name}" created.`);
    },
    onError: (e: Error) => toast.error(`Create failed: ${e.message}`),
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: UUID; name: string }) =>
      api.updateProcess(projectId, id, { name }),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
      toast.success("Process renamed.");
    },
    onError: (e: Error) => toast.error(`Rename failed: ${e.message}`),
  });

  const archive = useMutation({
    mutationFn: (id: UUID) => api.updateProcess(projectId, id, { status: "archived" }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(`Archive failed: ${e.message}`),
  });

  const [matchFor, setMatchFor] = useState<{
    process: Process;
    candidates: ClaimMatchCandidate[];
  } | null>(null);

  const suggest = useMutation({
    mutationFn: (p: Process) => api.suggestClaimsForProcess(projectId, p.id),
    onSuccess: (data, p) => {
      if (data.candidates.length === 0) {
        toast(`No unlinked claims matched "${p.name}".`);
      } else {
        setMatchFor({ process: p, candidates: data.candidates });
      }
    },
    onError: (e: Error) => toast.error(`Suggest failed: ${e.message}`),
  });

  const active = processes.filter((p) => p.status === "active");

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newName.trim()) create.mutate(newName.trim());
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New process name (e.g. Order to Cash)"
          maxLength={300}
        />
        <Button type="submit" disabled={!newName.trim() || create.isPending}>
          Add process
        </Button>
      </form>

      <ul className="space-y-2">
        {active.map((p) => (
          <li key={p.id} className="flex items-center justify-between rounded border p-3">
            {editingId === p.id ? (
              <form
                className="flex flex-1 gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (editName.trim()) rename.mutate({ id: p.id, name: editName.trim() });
                }}
              >
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus maxLength={300} />
                <Button type="submit" size="sm" disabled={rename.isPending}>Save</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
              </form>
            ) : (
              <>
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {p.claim_count} claim{p.claim_count === 1 ? "" : "s"} · {p.map_count} map{p.map_count === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => suggest.mutate(p)}
                    disabled={suggest.isPending && suggest.variables?.id === p.id}
                  >
                    {suggest.isPending && suggest.variables?.id === p.id
                      ? "Matching…"
                      : "Suggest claims"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingId(p.id);
                      setEditName(p.name);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (window.confirm(`Archive "${p.name}"? Its claim links stay intact; it's hidden from the active list.`)) {
                        archive.mutate(p.id);
                      }
                    }}
                  >
                    Archive
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
        {active.length === 0 && (
          <li className="rounded border border-dashed p-3 text-sm text-muted-foreground">
            No processes yet. Add one above, or use Suggest processes to have AI propose them.
          </li>
        )}
      </ul>

      {matchFor && (
        <SuggestClaimsDialog
          projectId={projectId}
          processId={matchFor.process.id}
          processName={matchFor.process.name}
          candidates={matchFor.candidates}
          open={matchFor !== null}
          onOpenChange={(o) => {
            if (!o) setMatchFor(null);
          }}
        />
      )}
    </div>
  );
}
