"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { LaneUpdate, NodeUpdate, UUID } from "@/lib/types";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

const FLUSH_DELAY_MS = 500;
const SAVED_DISPLAY_MS = 1500;

/**
 * Tracks dirty per-entity edits (nodes, lanes) and flushes them to the
 * backend on a debounce. Errors surface via `status` and `error`.
 */
export function useGraphPersistence({ projectId }: { projectId: UUID }) {
  const dirtyNodesRef = useRef<Map<UUID, NodeUpdate>>(new Map());
  const dirtyLanesRef = useRef<Map<UUID, LaneUpdate>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<unknown> | null>(null);

  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const flush = useCallback(async () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (inFlightRef.current) {
      await inFlightRef.current.catch(() => {});
    }
    const nodes = Array.from(dirtyNodesRef.current.entries());
    const lanes = Array.from(dirtyLanesRef.current.entries());
    if (nodes.length === 0 && lanes.length === 0) return;

    dirtyNodesRef.current.clear();
    dirtyLanesRef.current.clear();
    setStatus("saving");
    setError(null);

    const work = Promise.all([
      ...nodes.map(([id, body]) => api.updateNode(projectId, id, body)),
      ...lanes.map(([id, body]) => api.updateLane(projectId, id, body)),
    ]);
    inFlightRef.current = work;

    try {
      await work;
      setStatus("saved");
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setStatus("idle"), SAVED_DISPLAY_MS);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = null;
    }
  }, [projectId]);

  const scheduleFlush = useCallback(() => {
    setStatus("dirty");
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      flush();
    }, FLUSH_DELAY_MS);
  }, [flush]);

  const markNode = useCallback(
    (id: UUID, update: NodeUpdate) => {
      const prev = dirtyNodesRef.current.get(id) ?? {};
      dirtyNodesRef.current.set(id, { ...prev, ...update });
      scheduleFlush();
    },
    [scheduleFlush]
  );

  const markLane = useCallback(
    (id: UUID, update: LaneUpdate) => {
      const prev = dirtyLanesRef.current.get(id) ?? {};
      dirtyLanesRef.current.set(id, { ...prev, ...update });
      scheduleFlush();
    },
    [scheduleFlush]
  );

  // Best-effort flush before leaving the page.
  useEffect(() => {
    const handler = () => {
      if (
        dirtyNodesRef.current.size > 0 ||
        dirtyLanesRef.current.size > 0
      ) {
        // Fire-and-forget; navigator.sendBeacon would be ideal but our PATCH
        // endpoints aren't beacon-compatible. Best we can do is trigger flush.
        flush();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [flush]);

  return { status, error, markNode, markLane, flush };
}
