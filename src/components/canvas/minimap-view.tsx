"use client";

import { Map as MapIcon, X } from "lucide-react";
import { useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";

import { THEME } from "./canvas-theme";
import {
  centreOn,
  fromMinimap,
  minimapLayout,
  toMinimap,
  union,
  viewRect,
  type MinimapLayout,
} from "./minimap";
import { contentBounds, type Viewport } from "./viewport-math";

const WIDTH = 200;
const OPEN_KEY = "canvas.minimapOpen";

// Shown unless the user has hidden it. In-memory fallback for blocked storage.
let memoryOpen: boolean | null = null;
const listeners = new Set<() => void>();
function readOpen(): boolean {
  if (memoryOpen !== null) return memoryOpen;
  try {
    return window.localStorage.getItem(OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}
function writeOpen(v: boolean) {
  memoryOpen = v;
  try {
    window.localStorage.setItem(OPEN_KEY, String(v));
  } catch {
    // Storage unavailable: the in-memory value covers this page view.
  }
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const cardStyle = {
  position: "absolute" as const,
  bottom: 68,
  zIndex: 20,
  background: "rgba(255,255,255,0.96)",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  boxShadow: "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
};

/**
 * The whole map in miniature, bottom right, with the part on screen
 * outlined. Click or drag in it to move the view; zoom stays the same.
 */
export function MinimapView({
  lanes,
  nodes,
  viewport,
  visible,
  right,
  onViewport,
}: {
  lanes: { id: string; y: number; h: number; color: string }[];
  nodes: { id: string; x: number; y: number; w: number; h: number }[];
  viewport: Viewport;
  /** The visible canvas in pixels (panels excluded). */
  visible: { w: number; h: number };
  /** Distance from the canvas's right edge (clears panels). */
  right: number;
  onViewport: (v: Viewport) => void;
}) {
  const open = useSyncExternalStore(subscribe, readOpen, () => true);
  // While dragging, keep the layout from the mousedown: the outline moving
  // would otherwise grow the world box and rescale the map under the cursor.
  const [frozen, setFrozen] = useState<MinimapLayout | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        aria-label="Show minimap"
        title="Show minimap"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => writeOpen(true)}
        style={{
          ...cardStyle,
          right,
          width: 36,
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#475569",
          cursor: "pointer",
        }}
      >
        <MapIcon size={16} />
      </button>
    );
  }

  const content = contentBounds(nodes, lanes);
  const view = viewRect(viewport, visible);
  const world = content ? union(content, view) : view;
  const live = minimapLayout(world, WIDTH);
  const layout = frozen ?? live;
  const outline = toMinimap(layout, view);

  const moveTo = (e: { clientX: number; clientY: number }, el: Element, l: MinimapLayout) => {
    const r = el.getBoundingClientRect();
    onViewport(centreOn(viewport, fromMinimap(l, { x: e.clientX - r.left, y: e.clientY - r.top }), visible));
  };

  const onMouseDown = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    setFrozen(live);
    moveTo(e, el, live);
    const onMove = (ev: MouseEvent) => moveTo(ev, el, live);
    const onUp = () => {
      setFrozen(null);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <div style={{ ...cardStyle, right, width: WIDTH, padding: 0, overflow: "hidden" }}>
      <svg
        role="img"
        aria-label="Minimap — click or drag to move the view"
        width={WIDTH}
        height={layout.h}
        onMouseDown={onMouseDown}
        style={{ display: "block", cursor: "pointer" }}
      >
        {lanes.map((l) => {
          const r = toMinimap(layout, { x: world.x, y: l.y, w: world.w, h: l.h });
          return (
            <rect key={l.id} x={0} y={r.y} width={WIDTH} height={r.h} fill={l.color} opacity={0.3} />
          );
        })}
        {nodes.map((n) => {
          const r = toMinimap(layout, n);
          return (
            <rect
              key={n.id}
              x={r.x}
              y={r.y}
              width={Math.max(1.5, r.w)}
              height={Math.max(1.5, r.h)}
              rx={1}
              fill="#94a3b8"
            />
          );
        })}
        <rect
          data-testid="minimap-view"
          x={outline.x}
          y={outline.y}
          width={outline.w}
          height={outline.h}
          fill="rgba(37, 99, 235, 0.08)"
          stroke={THEME.selection}
          strokeWidth={1.25}
          rx={2}
        />
      </svg>
      <button
        type="button"
        aria-label="Hide minimap"
        title="Hide minimap"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => writeOpen(false)}
        style={{
          position: "absolute",
          top: 3,
          right: 3,
          width: 18,
          height: 18,
          border: "none",
          borderRadius: 4,
          background: "rgba(255,255,255,0.85)",
          color: "#64748b",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          padding: 0,
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
