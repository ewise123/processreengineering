"use client";

import type { CSSProperties, DragEvent } from "react";

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

export function ShapePalette() {
  const onDragStart = (e: DragEvent, shape: PaletteShape) => {
    e.dataTransfer.setData(PALETTE_DRAG_MIME, shape.kind);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        top: 60,
        width: 148,
        background: "rgba(255,255,255,0.96)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        zIndex: 20,
        boxShadow:
          "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "#94a3b8",
          padding: "8px 10px 4px",
        }}
      >
        Shapes
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 4px 8px" }}>
        {PALETTE_SHAPES.map((s) => (
          <div
            key={s.kind}
            draggable
            onDragStart={(e) => onDragStart(e, s)}
            title={`Drag to canvas — ${s.label}`}
            style={paletteRowStyle}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = "#f1f5f9";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = "transparent";
            }}
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
