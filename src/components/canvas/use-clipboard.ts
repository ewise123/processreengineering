import { useCallback, useMemo, useRef } from "react";

import type { UUID } from "@/lib/types";
import type { CanvasNodeKind } from "./types";

export interface ClipboardNode {
  oldId: UUID;
  type: string;
  kind: CanvasNodeKind;
  label: string;
  laneId: UUID | null;
  x: number;
  relativeY: number;
  w: number;
  h: number;
}

export interface ClipboardEdge {
  fromOldId: UUID;
  toOldId: UUID;
  label: string | null;
}

export interface ClipboardSnapshot {
  nodes: ClipboardNode[];
  edges: ClipboardEdge[];
}

/** In-memory, same-tab clipboard for canvas nodes + the edges between them.
 * Returns a STABLE object so consumers' useCallbacks stay referentially stable. */
export function useClipboard() {
  const ref = useRef<ClipboardSnapshot | null>(null);
  const copy = useCallback((snapshot: ClipboardSnapshot) => {
    ref.current = snapshot.nodes.length > 0 ? snapshot : null;
  }, []);
  const get = useCallback(() => ref.current, []);
  const hasContent = useCallback(
    () => !!ref.current && ref.current.nodes.length > 0,
    []
  );
  return useMemo(() => ({ copy, get, hasContent }), [copy, get, hasContent]);
}
