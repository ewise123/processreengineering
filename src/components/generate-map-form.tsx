"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { api } from "@/lib/api";
import type { UUID } from "@/lib/types";

const LEVELS = [
  { value: "1", label: "L1 — Process Landscape (5–10 phases)" },
  { value: "2", label: "L2 — Cross-Functional (15–25 activities)" },
  { value: "3", label: "L3 — Detailed Operational (30–50 activities)" },
  { value: "4", label: "L4 — Work Instruction (50–80 activities)" },
];

const MAP_TYPES = [
  { value: "any", label: "Either / unspecified" },
  { value: "current_state", label: "Current state — as it is today" },
  { value: "future_state", label: "Future state — as it should work" },
];

export function GenerateMapForm({ projectId }: { projectId: UUID }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState("2");
  const [focus, setFocus] = useState("");
  const [mapType, setMapType] = useState("any");

  const generate = useMutation({
    mutationFn: () =>
      api.generateProcessMap(projectId, {
        name: name.trim(),
        level,
        focus: focus.trim() || null,
        map_type: mapType === "any" ? null : mapType,
      }),
    onSuccess: (res) => {
      toast.success(
        `Generated "${res.process_name}" v${res.lane_count}-lane / ${res.node_count}-node map.`
      );
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
      setOpen(false);
      setName("");
      setFocus("");
      router.push(
        `/projects/${projectId}/maps/${res.model_id}/versions/${res.version_id}`
      );
    },
    onError: (e: Error) => toast.error(`Generation failed: ${e.message}`),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Generate map</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate process map</DialogTitle>
          <DialogDescription>
            Calls Claude with all extracted claims for this project. Takes
            10–60 seconds depending on claim count and level.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="map-name">Process name *</Label>
            <Input
              id="map-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Accounts Payable Process"
              required
              maxLength={300}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="map-level">Level</Label>
            <Select value={level} onValueChange={setLevel}>
              <SelectTrigger id="map-level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="map-focus">Focus (optional)</Label>
            <Input
              id="map-focus"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="Leave blank to consider all claims"
              maxLength={300}
            />
            <p className="text-xs text-muted-foreground">
              If your documents describe multiple processes, name the one you
              want this map to focus on.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="map-type">Map type</Label>
            <Select value={mapType} onValueChange={setMapType}>
              <SelectTrigger id="map-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MAP_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
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
            disabled={generate.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => generate.mutate()}
            disabled={!name.trim() || generate.isPending}
          >
            {generate.isPending ? "Generating…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
