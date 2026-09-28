"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
} from "react";

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
    // Collapsed unless the user has opened it before.
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

/** How long the palette takes to open and close. */
const OPEN_MS = 180;
const CLOSE_MS = 140;

// Keyframes for the open/close animation. The card is anchored at the
// bottom, so revealing it from the bottom edge up reads as "growing upward".
const PALETTE_CSS = `
@keyframes poet-palette-open {
  from { clip-path: inset(100% 0 0 0 round 10px); }
  to { clip-path: inset(0 0 0 0 round 10px); }
}
@keyframes poet-palette-close {
  from { clip-path: inset(0 0 0 0 round 10px); }
  to { clip-path: inset(100% 0 0 0 round 10px); }
}
@keyframes poet-palette-row {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
@keyframes poet-palette-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
.poet-palette-opening { animation: poet-palette-open ${OPEN_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.poet-palette-closing { animation: poet-palette-close ${CLOSE_MS}ms cubic-bezier(0.4, 0, 1, 1) both; }
.poet-palette-opening .poet-palette-row { animation: poet-palette-row 160ms ease-out both; }
.poet-palette-row-in { animation: poet-palette-fade 120ms ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .poet-palette-opening, .poet-palette-closing,
  .poet-palette-opening .poet-palette-row, .poet-palette-row-in { animation: none; }
}
`;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Shapes to drag onto the map. It always lives at the bottom left, clear of
 * the lane headers (which stay pinned to the left edge while panning).
 * Collapsed, it's a row of icons; expanded, the same card grows upward into
 * a labelled column, keeping its bottom edge where it was.
 */
export function ShapePalette({
  onAddShape,
}: {
  /** Click (rather than drag) a shape: add it at the centre of the view. */
  onAddShape?: (shape: PaletteShape) => void;
} = {}) {
  // Server render and hydration use the default (collapsed); the stored
  // choice takes over on the client without a mismatch.
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => true);
  // "opening" plays once when expanding; "closing" plays before the card
  // switches back to the icon row. Null once settled (a reload shows the
  // stored state without animating).
  const [motion, setMotion] = useState<"opening" | "closing" | "row-in" | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const expand = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setMotion("opening");
    writeCollapsed(false);
  };
  const collapse = () => {
    if (prefersReducedMotion()) {
      setMotion(null);
      writeCollapsed(true);
      return;
    }
    setMotion("closing");
    closeTimer.current = setTimeout(() => {
      setMotion("row-in");
      writeCollapsed(true);
    }, CLOSE_MS);
  };

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

  const shapeProps = (s: PaletteShape) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => onDragStart(e, s),
    onClick: () => onAddShape?.(s),
    title: `Click to add, or drag onto the map — ${s.label}`,
    ...hover,
  });

  const cardStyle: CSSProperties = { ...panelStyle, left: 64, bottom: 16 };

  if (collapsed) {
    return (
      <>
        <style>{PALETTE_CSS}</style>
        <div
          role="toolbar"
          aria-label="Shapes"
          className={motion === "row-in" ? "poet-palette-row-in" : undefined}
          onAnimationEnd={() => setMotion(null)}
          style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 2, padding: 4 }}
        >
          {PALETTE_SHAPES.map((s) => (
            <div
              key={s.kind}
              {...shapeProps(s)}
              aria-label={s.label}
              style={{ ...paletteRowStyle, padding: 6 }}
            >
              <ShapeIcon kind={s.kind} />
            </div>
          ))}
          <button
            type="button"
            onClick={expand}
            onMouseDown={(e) => e.preventDefault()}
            title="Show shape names"
            aria-label="Expand shapes"
            aria-expanded={false}
            style={toggleStyle}
            {...hover}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path d="M3 7.5L6 4.5l3 3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{PALETTE_CSS}</style>
      <div
        role="toolbar"
        aria-label="Shapes"
        aria-orientation="vertical"
        className={
          motion === "opening"
            ? "poet-palette-opening"
            : motion === "closing"
              ? "poet-palette-closing"
              : undefined
        }
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget && motion === "opening") setMotion(null);
        }}
        style={{ ...cardStyle, width: 148 }}
      >
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
            onClick={collapse}
            onMouseDown={(e) => e.preventDefault()}
            title="Collapse to icons"
            aria-label="Collapse shapes"
            aria-expanded
            style={toggleStyle}
            {...hover}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path d="M3 4.5L6 7.5l3-3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 4px 6px" }}>
          {PALETTE_SHAPES.map((s, i) => (
            <div
              key={s.kind}
              {...shapeProps(s)}
              aria-label={s.label}
              className="poet-palette-row"
              // Rows arrive bottom-first, following the card as it grows up.
              style={{ ...paletteRowStyle, animationDelay: `${(PALETTE_SHAPES.length - 1 - i) * 25}ms` }}
            >
              <ShapeIcon kind={s.kind} />
              <span style={{ fontSize: 12, fontWeight: 500, color: "#334155" }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>
    </>
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
