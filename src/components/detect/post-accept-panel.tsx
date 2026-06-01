"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import type { ProcessSegment, UUID } from "@/lib/types";

const LEVELS = [
  { value: "1", label: "L1" },
  { value: "2", label: "L2" },
  { value: "3", label: "L3" },
  { value: "4", label: "L4" },
];
const MAP_TYPES = [
  { value: "any", label: "Either / unspecified" },
  { value: "current_state", label: "Current state" },
  { value: "future_state", label: "Future state" },
];

export function PostAcceptPanel({
  projectId,
  runId,
  onDismiss,
}: {
  projectId: UUID;
  runId: UUID;
  onDismiss: () => void;
}) {
  const qc = useQueryClient();
  const runQuery = useQuery({
    queryKey: ["detection-run", projectId, runId],
    queryFn: () => api.getDetectionRun(projectId, runId),
  });

  const [defaultLevel, setDefaultLevel] = useState("2");
  const [mapType, setMapType] = useState("current_state");
  const [perSegLevel, setPerSegLevel] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, "idle" | "running" | "done" | "failed">>({});

  if (!runQuery.data) return null;
  const segments = runQuery.data.segments.filter((s) => !s.is_unassigned);

  const levelFor = (id: UUID) => perSegLevel[id] || defaultLevel;

  const generateOne = async (seg: ProcessSegment) => {
    setStatus((s) => ({ ...s, [seg.id]: "running" }));
    try {
      await api.generateProcessMap(projectId, {
        name: seg.name,
        level: levelFor(seg.id),
        map_type: mapType === "any" ? null : mapType,
        segment_id: seg.id,
      });
      setStatus((s) => ({ ...s, [seg.id]: "done" }));
      qc.invalidateQueries({ queryKey: ["maps", projectId] });
    } catch (e) {
      setStatus((s) => ({ ...s, [seg.id]: "failed" }));
      toast.error(
        `Generate failed for ${seg.name}: ${(e as Error).message}`,
      );
    }
  };

  const generateAll = async () => {
    for (const seg of segments) {
      if (status[seg.id] === "done" || status[seg.id] === "running") continue;
      // eslint-disable-next-line no-await-in-loop
      await generateOne(seg);
    }
  };

  const allDone = segments.length > 0 && segments.every((s) => status[s.id] === "done");

  return (
    <div className="rounded border p-4 space-y-3 bg-card">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">
          Generate maps from {segments.length} accepted process
          {segments.length === 1 ? "" : "es"}
        </h2>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Skip — generate manually
        </Button>
      </div>

      <div className="flex items-center gap-3 text-sm">
        <span>Default level:</span>
        <Select value={defaultLevel} onValueChange={setDefaultLevel}>
          <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
          <SelectContent>
            {LEVELS.map((l) => (
              <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span>Map type:</span>
        <Select value={mapType} onValueChange={setMapType}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {MAP_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ul className="space-y-2">
        {segments.map((seg) => (
          <li
            key={seg.id}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="truncate flex-1">{seg.name}</span>
            <Select
              value={levelFor(seg.id)}
              onValueChange={(v) =>
                setPerSegLevel((p) => ({ ...p, [seg.id]: v }))
              }
            >
              <SelectTrigger className="w-20"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => (
                  <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant={status[seg.id] === "done" ? "outline" : "default"}
              disabled={status[seg.id] === "running" || status[seg.id] === "done"}
              onClick={() => generateOne(seg)}
            >
              {status[seg.id] === "running"
                ? "Generating…"
                : status[seg.id] === "done"
                  ? "Done"
                  : status[seg.id] === "failed"
                    ? "Retry"
                    : "Generate now"}
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex justify-end gap-2">
        <Button variant="default" onClick={generateAll} disabled={allDone}>
          Generate all in sequence
        </Button>
      </div>
    </div>
  );
}
