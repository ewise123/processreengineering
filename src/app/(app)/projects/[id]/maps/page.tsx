"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { GenerateMapForm } from "@/components/generate-map-form";
import { api } from "@/lib/api";
import type { ProcessModel, UUID } from "@/lib/types";

export default function MapsPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const mapsQuery = useQuery({
    queryKey: ["maps", id],
    queryFn: () => api.listProcessMaps(id),
  });
  const processesQuery = useQuery({
    queryKey: ["processes", id],
    queryFn: () => api.listProcesses(id),
  });

  const attach = useMutation({
    mutationFn: ({ modelId, processId }: { modelId: UUID; processId: UUID | null }) =>
      api.attachMapToProcess(id, modelId, processId),
    onSuccess: () => {
      toast.success("Map re-linked.");
      qc.invalidateQueries({ queryKey: ["maps", id] });
    },
    onError: (e: Error) => toast.error(`Attach failed: ${e.message}`),
  });

  const maps = mapsQuery.data ?? [];
  const processes = (processesQuery.data ?? []).filter((p) => p.status === "active");

  // Group maps: one bucket per process_id, plus an "unlinked" bucket.
  const byProcess = new Map<string, ProcessModel[]>();
  const unlinked: ProcessModel[] = [];
  for (const m of maps) {
    if (m.process_id) {
      const arr = byProcess.get(m.process_id) ?? [];
      arr.push(m);
      byProcess.set(m.process_id, arr);
    } else {
      unlinked.push(m);
    }
  }

  const renderCard = (m: ProcessModel) => {
    const targetHref = m.latest_version_id
      ? `/projects/${id}/maps/${m.id}/versions/${m.latest_version_id}`
      : `/projects/${id}/maps`;
    const unreconciled = m.unreconciled_claim_count ?? 0;
    return (
      <Card key={m.id} className="h-full">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="line-clamp-1">{m.name}</CardTitle>
            <div className="flex items-center gap-1">
              <Badge variant="outline">{m.level}</Badge>
              {unreconciled > 0 && (
                <Badge
                  variant="secondary"
                  title="Claims assigned to this process but not yet cited by any node in the latest version."
                >
                  {unreconciled} unreconciled
                </Badge>
              )}
            </div>
          </div>
          <CardDescription>
            {m.latest_version_number ? `v${m.latest_version_number} · ` : "no version yet · "}
            created {new Date(m.created_at).toLocaleDateString()}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={targetHref} className="text-xs text-primary underline">
            Open canvas
          </Link>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Process maps, grouped by the process they belong to. Generate a new map
          scoped to a process, or attach an unlinked map below.
        </p>
        <div className="flex items-center gap-2">
          <NewBlankMapButton projectId={id} />
          <GenerateMapForm projectId={id} />
        </div>
      </div>

      {mapsQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {mapsQuery.error && <p className="text-sm text-red-600">{(mapsQuery.error as Error).message}</p>}
      {processesQuery.error && (
        <p className="text-sm text-red-600">{(processesQuery.error as Error).message}</p>
      )}

      {!mapsQuery.isLoading && maps.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No maps yet</CardTitle>
            <CardDescription>
              Create processes on the Processes tab, then generate a map scoped to one
              with the button above.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {processes.map((p) => {
        const group = byProcess.get(p.id) ?? [];
        if (group.length === 0) return null;
        return (
          <section key={p.id} className="space-y-2">
            <h2 className="text-sm font-semibold">{p.name}</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {group.map(renderCard)}
            </div>
          </section>
        );
      })}

      {unlinked.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Unlinked maps</h2>
          <p className="text-xs text-muted-foreground">
            These maps are not attached to a process (e.g. migrated from the old
            detection model). Attach each to a process to group it.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {unlinked.map((m) => (
              <div key={m.id} className="space-y-2">
                {renderCard(m)}
                <Select
                  disabled={attach.isPending}
                  onValueChange={(value) =>
                    attach.mutate({ modelId: m.id, processId: value as UUID })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Attach to process…" />
                  </SelectTrigger>
                  <SelectContent>
                    {processes.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const BLANK_LEVELS = [
  { value: "1", label: "L1 — Process Landscape" },
  { value: "2", label: "L2 — Cross-Functional" },
  { value: "3", label: "L3 — Detailed Operational" },
  { value: "4", label: "L4 — Work Instruction" },
];

function NewBlankMapButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState("2");

  const create = useMutation({
    mutationFn: () =>
      api.createBlankMap(projectId, { name: name.trim(), level }),
    onSuccess: (res) => {
      toast.success(`Created blank map "${res.name}".`);
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      setOpen(false);
      setName("");
      router.push(
        `/projects/${projectId}/maps/${res.model_id}/versions/${res.version_id}`
      );
    },
    onError: (e: Error) => toast.error(`Create failed: ${e.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">New blank map</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New blank map</DialogTitle>
          <DialogDescription>
            Creates an empty map with Start and End nodes. No AI, no claims
            required — you build it on the canvas. It starts unlinked; attach it
            to a process from the Unlinked maps section.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="blank-name">Name *</Label>
            <Input
              id="blank-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Order to Cash"
              maxLength={300}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="blank-level">Level</Label>
            <Select value={level} onValueChange={setLevel}>
              <SelectTrigger id="blank-level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BLANK_LEVELS.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            disabled={!name.trim() || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
