"use client";

import { useEffect, useState } from "react";
import { Progress } from "@/components/ui/progress";
import type { InputRow } from "@/lib/types";

interface Props {
  row: InputRow;
}

export function ExtractionProgressCell({ row }: Props) {
  // Re-render once per second while extracting so the elapsed/ETA stays fresh
  // between polls.
  const [, force] = useState(0);
  useEffect(() => {
    if (row.status !== "extracting") return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [row.status]);

  if (row.status !== "extracting") {
    return <span className="text-muted-foreground">—</span>;
  }

  const total = Math.max(row.chunks_total, 1);
  const done = Math.min(row.chunks_processed, total);
  const pct = Math.round((done / total) * 100);

  const startedAt = row.extraction_started_at
    ? new Date(row.extraction_started_at).getTime()
    : null;
  const elapsedMs = startedAt ? Date.now() - startedAt : null;

  let etaText = "";
  if (elapsedMs && done > 0 && done < total) {
    const msPerChunk = elapsedMs / done;
    const remainingMs = msPerChunk * (total - done);
    etaText = ` · ~${formatDuration(remainingMs)} left`;
  }
  const elapsedText = elapsedMs ? formatDuration(elapsedMs) : "";

  return (
    <div className="space-y-1 min-w-32">
      <div className="text-xs tabular-nums">
        {done} / {total} chunks ({pct}%)
      </div>
      <Progress value={pct} className="h-1.5" />
      {elapsedText && (
        <div className="text-[10px] text-muted-foreground tabular-nums">
          {elapsedText}
          {etaText}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
