"use client";

import { useSyncExternalStore, type CSSProperties, type DragEvent, type MouseEvent } from "react";

import type { CanvasNodeKind } from "./types";

export type PaletteShape = {
  /** Frontend canvas kind — drives icon + dimensions when dropped. */
  kind: CanvasNodeKind;
  /** Backend NodeType value (what /nodes POST stores). */
  backendType: string;
  label: string;
  defaultName: string;
  w: number;
  h: number;
};

export const PALETTE_SHAPES: PaletteShape[] = [
  {
    kind: "task",
    backendType: "task",
    label: "Task",
    defaultName: "New task",
    w: 170,
    h: 64,
  },
  {
    kind: "gateway",
    backendType: "gateway_exclusive",
    label: "Gateway",
    defaultName: "Decision",
    w: 60,
    h: 60,
  },
  {
    kind: "start",
    backendType: "event_start",
    label: "Start",
    defaultName: "Start",
    w: 50,
    h: 50,
  },
  {
    kind: "end",
    backendType: "event_end",
    label: "End",
    defaultName: "End",
    w: 50,
    h: 50,
  },
];

export const PALETTE_DRAG_MIME = "application/x-poet-shape";

const COLLAPSED_KEY = "canvas.paletteCollapsed";

function readCollapsed(): boolean {
  if (memoryCollapsed !== null) return memoryCollapsed;
  try {
    // Collapsed unless the user has opened it before: the full card sits over
    // the first lane header.
    return window.localStorage.getItem(COLLAPSED_KEY) !== "false";
  } catch {
    return true;
  }
}

// In-memory fallback so the toggle still works when storage is blocked.
let memoryCollapsed: boolean | null = null;
const listeners = new Set<() => void>();

function writeCollapsed(v: boolean) {
  memoryCollapsed = v;
  try {
    window.localStorage.setItem(COLLAPSED_KEY, String(v));
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

const panelStyle: CSSProperties = {
  position: "absolute",
  background: "rgba(255,255,255,0.96)",
  backdropFilter: "blur(10px)",
  WebkitBackdropFilter: "blur(10px)",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  zIndex: 20,
  boxShadow:
    "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
};

/**
 * Shapes to drag onto the map. Expanded, it's a labelled card at the top
 * left. Collapsed, it's a compact icon row at the bottom left, clear of the
 * lane headers (which stay pinned to the left edge while panning).
 */
export function ShapePalette() {
  // Server render and hydration use the default (collapsed); the stored
  // choice takes over on the client without a mismatch.
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => true);
  const toggle = (next: boolean) => writeCollapsed(next);

  const onDragStart = (e: DragEvent, shape: PaletteShape) => {
    e.dataTransfer.setData(PALETTE_DRAG_MIME, shape.kind);
    e.dataTransfer.effectAllowed = "copy";
  };

  const hover = {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      e.currentTarget.style.background = "#f1f5f9";
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      e.currentTarget.style.background = "transparent";
    },
  };

  if (collapsed) {
    return (
      <div
        role="toolbar"
        aria-label="Shapes"
        style={{
          ...panelStyle,
          left: 64,
          bottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: 4,
        }}
      >
        {PALETTE_SHAPES.map((s) => (
          <div
            key={s.kind}
            draggable
            onDragStart={(e) => onDragStart(e, s)}
            title={`Drag onto the map — ${s.label}`}
            aria-label={s.label}
            style={{ ...paletteRowStyle, padding: 6 }}
            {...hover}
          >
            <ShapeIcon kind={s.kind} />
          </div>
        ))}
        <button
          type="button"
          onClick={() => toggle(false)}
          title="Show shape names"
          aria-label="Expand shapes"
          style={toggleStyle}
          {...hover}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path d="M3 7.5L6 4.5l3 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...panelStyle, left: 12, top: 60, width: 148 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 4px 0 10px",
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "#94a3b8",
          }}
        >
          Shapes
        </span>
        <button
          type="button"
          onClick={() => toggle(true)}
          title="Collapse to icons"
          aria-label="Collapse shapes"
          style={toggleStyle}
          {...hover}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path d="M3 4.5L6 7.5l3-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 4px 8px" }}>
        {PALETTE_SHAPES.map((s) => (
          <div
            key={s.kind}
            draggable
            onDragStart={(e) => onDragStart(e, s)}
            title={`Drag to canvas — ${s.label}`}
            style={paletteRowStyle}
            {...hover}
          >
            <ShapeIcon kind={s.kind} />
            <span style={{ fontSize: 11, fontWeight: 500, color: "#334155" }}>
              {s.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const toggleStyle: CSSProperties = {
  width: 24,
  height: 24,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "#64748b",
  cursor: "pointer",
};

const paletteRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 6,
  cursor: "grab",
  userSelect: "none",
};

function ShapeIcon({ kind }: { kind: CanvasNodeKind }) {
  if (kind === "start") {
    return (
      <svg width="22" height="22" viewBox="0 0 22 22">
        <circle cx="11" cy="11" r="8" fill="white" stroke="#16a34a" strokeWidth={2} />
      </svg>
    );
  }
  if (kind === "end") {
    return (
      <svg width="22" height="22" viewBox="0 0 22 22">
        <circle cx="11" cy="11" r="7" fill="white" stroke="#991b1b" strokeWidth={3} />
      </svg>
    );
  }
  if (kind === "gateway") {
    return (
      <svg width="22" height="22" viewBox="0 0 22 22">
        <polygon
          points="11,2 20,11 11,20 2,11"
          fill="white"
          stroke="#475569"
          strokeWidth={1.5}
        />
      </svg>
    );
  }
  return (
    <svg width="26" height="18" viewBox="0 0 26 18">
      <rect
        x="1"
        y="1"
        width="24"
        height="16"
        rx="3"
        fill="white"
        stroke="#475569"
        strokeWidth={1.2}
      />
    </svg>
  );
}
