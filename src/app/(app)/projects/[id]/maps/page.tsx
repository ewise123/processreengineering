"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams, useRouter } from "next/navigation";
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
import { PostAcceptPanel } from "@/components/detect/post-accept-panel";
import { api } from "@/lib/api";

export default function MapsPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["maps", id],
    queryFn: () => api.listProcessMaps(id),
  });

  const params = useSearchParams();
  const router = useRouter();
  const postAcceptRun = params.get("postAcceptRun");

  const dismissPanel = () => {
    const sp = new URLSearchParams(params.toString());
    sp.delete("postAcceptRun");
    router.replace(`/projects/${id}/maps${sp.toString() ? `?${sp}` : ""}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Generated process maps for this project. Each map can have multiple
          versions; clicking opens the latest.
        </p>
        <div className="flex gap-2">
          <NewBlankMapButton projectId={id} />
          <GenerateMapForm projectId={id} />
        </div>
      </div>

      {postAcceptRun && (
        <PostAcceptPanel
          projectId={id}
          runId={postAcceptRun}
          onDismiss={dismissPanel}
        />
      )}

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {error && (
        <p className="text-sm text-red-600">{(error as Error).message}</p>
      )}

      {data && data.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No maps yet</CardTitle>
            <CardDescription>
              Find the processes in your documents — open the Processes tab and
              click Detect processes. You can also generate a single map
              directly with the button above.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {data && data.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.map((m) => {
            const targetHref = m.latest_version_id
              ? `/projects/${id}/maps/${m.id}/versions/${m.latest_version_id}`
              : `/projects/${id}/maps`;
            return (
              <Link key={m.id} href={targetHref} className="block">
                <Card className="h-full hover:border-primary transition">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="line-clamp-1">{m.name}</CardTitle>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline">{m.level}</Badge>
                        {m.latest_source_run_status === "superseded" && (
                          <Badge
                            variant="secondary"
                            title="Generated from a detection run that has since been superseded."
                          >
                            stale
                          </Badge>
                        )}
                      </div>
                    </div>
                    <CardDescription>
                      {m.latest_version_number
                        ? `v${m.latest_version_number} · `
                        : "no version yet · "}
                      created {new Date(m.created_at).toLocaleDateString()}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground">
                      Click to open canvas.
                    </p>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
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
            required — you build it on the canvas.
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
