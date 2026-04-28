"use client";

import { useState, type MouseEvent } from "react";

import type { IssueSeverity, UUID } from "@/lib/types";

import type { CanvasEdge, ResolvedNode } from "./types";

const ISSUE_FILL: Record<IssueSeverity, string> = {
  high: "#dc2626",
  medium: "#d97706",
};

export type ConnectSide = "top" | "right" | "bottom" | "left";

interface SimpleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pick orthogonal exit/entry sides based on the relative position of
 * source and target so the arrow always lands ON the target's perimeter
 * (perpendicular to its closest side), instead of disappearing into it.
 * Produces a 3-segment L-shape with one horizontal+one vertical bend.
 */
export type EdgeOrientation = "horizontal" | "vertical";

/** Below this gap on the perpendicular axis, the L-shape collapses to a
 * single straight segment. Picked to match a single grid-cell of slack. */
const SNAP_STRAIGHT_THRESHOLD = 8;

export function buildEdgePath(
  from: SimpleRect,
  to: SimpleRect,
  overrides?: { bendX?: number | null; bendY?: number | null }
): {
  d: string;
  midX: number;
  midY: number;
  orientation: EdgeOrientation;
  /** The two segment endpoints of the draggable middle segment, in the
   * canvas coordinate system. */
  midSegment: { x1: number; y1: number; x2: number; y2: number };
} {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = tc.x - fc.x;
  const dy = tc.y - fc.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  if (horizontal) {
    const naturalExitX = dx >= 0 ? from.x + from.w : from.x;
    const naturalEntryX = dx >= 0 ? to.x : to.x + to.w;
    const exitY = fc.y;
    // Snap-to-straight: when source/target are aligned on the cross axis,
    // the L-shape's two parallel segments collapse into one straight line.
    if (Math.abs(exitY - tc.y) < SNAP_STRAIGHT_THRESHOLD) {
      const y = (exitY + tc.y) / 2;
      return {
        d: `M ${naturalExitX} ${y} L ${naturalEntryX} ${y}`,
        midX: (naturalExitX + naturalEntryX) / 2,
        midY: y,
        orientation: "horizontal",
        midSegment: { x1: naturalExitX, y1: y, x2: naturalEntryX, y2: y },
      };
    }
    const naturalMidX = (naturalExitX + naturalEntryX) / 2;
    const bendX =
      typeof overrides?.bendX === "number"
        ? overrides.bendX
        : naturalMidX;
    // Source exit side flips to face whichever side of source the bend is on,
    // so the path never re-enters source.
    const exitX = bendX >= fc.x ? from.x + from.w : from.x;
    // If the user dragged the bend so it's inside the target's horizontal
    // span, snap entry to top or bottom (whichever the source is on the
    // other side of). Arrow lands perpendicular to that face.
    if (bendX > to.x && bendX < to.x + to.w) {
      const enterFromTop = exitY <= tc.y;
      const entryY = enterFromTop ? to.y : to.y + to.h;
      return {
        d: `M ${exitX} ${exitY} L ${bendX} ${exitY} L ${bendX} ${entryY}`,
        midX: bendX,
        midY: (exitY + entryY) / 2,
        orientation: "horizontal",
        midSegment: { x1: bendX, y1: exitY, x2: bendX, y2: entryY },
      };
    }
    const entryX = bendX < to.x ? to.x : to.x + to.w;
    const entryY = tc.y;
    return {
      d: `M ${exitX} ${exitY} L ${bendX} ${exitY} L ${bendX} ${entryY} L ${entryX} ${entryY}`,
      midX: bendX,
      midY: (exitY + entryY) / 2,
      orientation: "horizontal",
      midSegment: { x1: bendX, y1: exitY, x2: bendX, y2: entryY },
    };
  }
  const naturalExitY = dy >= 0 ? from.y + from.h : from.y;
  const naturalEntryY = dy >= 0 ? to.y : to.y + to.h;
  const exitX = fc.x;
  if (Math.abs(exitX - tc.x) < SNAP_STRAIGHT_THRESHOLD) {
    const x = (exitX + tc.x) / 2;
    return {
      d: `M ${x} ${naturalExitY} L ${x} ${naturalEntryY}`,
      midX: x,
      midY: (naturalExitY + naturalEntryY) / 2,
      orientation: "vertical",
      midSegment: { x1: x, y1: naturalExitY, x2: x, y2: naturalEntryY },
    };
  }
  const naturalMidY = (naturalExitY + naturalEntryY) / 2;
  const bendY =
    typeof overrides?.bendY === "number" ? overrides.bendY : naturalMidY;
  const exitY = bendY >= fc.y ? from.y + from.h : from.y;
  if (bendY > to.y && bendY < to.y + to.h) {
    const enterFromLeft = exitX <= tc.x;
    const entryX = enterFromLeft ? to.x : to.x + to.w;
    return {
      d: `M ${exitX} ${exitY} L ${exitX} ${bendY} L ${entryX} ${bendY}`,
      midX: (exitX + entryX) / 2,
      midY: bendY,
      orientation: "vertical",
      midSegment: { x1: exitX, y1: bendY, x2: entryX, y2: bendY },
    };
  }
  const entryY = bendY < to.y ? to.y : to.y + to.h;
  const entryX = tc.x;
  return {
    d: `M ${exitX} ${exitY} L ${exitX} ${bendY} L ${entryX} ${bendY} L ${entryX} ${entryY}`,
    midX: (exitX + entryX) / 2,
    midY: bendY,
    orientation: "vertical",
    midSegment: { x1: exitX, y1: bendY, x2: entryX, y2: bendY },
  };
}

export function sidePoint(rect: SimpleRect, side: ConnectSide) {
  switch (side) {
    case "top":
      return { x: rect.x + rect.w / 2, y: rect.y };
    case "right":
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
    case "bottom":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    case "left":
      return { x: rect.x, y: rect.y + rect.h / 2 };
  }
}

export function NodeShape({
  node,
  selected,
  issueLevel,
  showHandles,
  onMouseDown,
  onStartConnect,
}: {
  node: ResolvedNode;
  selected: boolean;
  issueLevel?: IssueSeverity | null;
  /** When true, hover handles are always rendered (e.g. while the connect
   * tool is active). Otherwise they appear on hover or when selected. */
  showHandles?: boolean;
  onMouseDown: (e: MouseEvent, id: string) => void;
  onStartConnect?: (e: MouseEvent, sourceId: UUID, side: ConnectSide) => void;
}) {
  const { kind, x, y, w, h, label, id } = node;
  const isEvent = kind === "start" || kind === "end" || kind === "intermediate";
  const isGateway = kind === "gateway";
  const isTask = !isEvent && !isGateway;

  const issueStroke = issueLevel ? ISSUE_FILL[issueLevel] : null;
  const stroke = selected ? "#0f172a" : (issueStroke ?? "#475569");
  const strokeWidth = selected ? 2.5 : issueLevel ? 2 : 1.2;
  const fill = "#ffffff";

  const [hover, setHover] = useState(false);
  const handlesVisible =
    !!onStartConnect && (hover || selected || showHandles);

  return (
    <g
      transform={`translate(${x},${y})`}
      style={{ cursor: showHandles ? "crosshair" : "move" }}
      onMouseDown={(e) => onMouseDown(e, id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-node-id={id}
    >
      {isEvent && (
        <>
          <circle
            cx={w / 2}
            cy={h / 2}
            r={w / 2}
            fill={fill}
            stroke={
              kind === "start"
                ? "#16a34a"
                : kind === "end"
                  ? "#991b1b"
                  : "#475569"
            }
            strokeWidth={kind === "end" ? 3.5 : 2}
          />
          {selected && (
            <circle
              cx={w / 2}
              cy={h / 2}
              r={w / 2 + 4}
              fill="none"
              stroke="#0f172a"
              strokeDasharray="3 3"
              strokeWidth={1.2}
            />
          )}
        </>
      )}
      {isGateway && (
        <>
          <polygon
            points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <text
            x={w / 2}
            y={h / 2 + 4}
            textAnchor="middle"
            fontSize="14"
            fill="#475569"
            fontWeight="700"
          >
            ×
          </text>
        </>
      )}
      {isTask && (
        <>
          <rect
            width={w}
            height={h}
            rx={8}
            ry={8}
            fill={fill}
            stroke={stroke}
            strokeWidth={strokeWidth}
          />
          <foreignObject x={6} y={10} width={w - 12} height={h - 16}>
            <div
              style={{
                fontSize: 11,
                lineHeight: 1.25,
                color: "#0f172a",
                fontWeight: 500,
                textAlign: "center",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                padding: "0 2px",
                fontFamily: "inherit",
              }}
            >
              {label}
            </div>
          </foreignObject>
        </>
      )}
      {(isEvent || isGateway) && (
        <foreignObject x={-40} y={h + 2} width={w + 80} height={40}>
          <div
            style={{
              fontSize: 10.5,
              color: "#334155",
              textAlign: "center",
              lineHeight: 1.2,
              fontWeight: 500,
              fontFamily: "inherit",
            }}
          >
            {label}
          </div>
        </foreignObject>
      )}
      {issueLevel && (
        <g transform={`translate(${w - 8}, -8)`} style={{ pointerEvents: "none" }}>
          <circle
            r={9}
            fill={ISSUE_FILL[issueLevel]}
            stroke="#fff"
            strokeWidth={2}
          />
          <text
            textAnchor="middle"
            y={4}
            fontSize="11"
            fontWeight="700"
            fill="#fff"
          >
            !
          </text>
        </g>
      )}
      {handlesVisible && (
        <>
          <ConnectHandle cx={w / 2} cy={0} onMouseDown={(e) => onStartConnect!(e, id, "top")} />
          <ConnectHandle cx={w} cy={h / 2} onMouseDown={(e) => onStartConnect!(e, id, "right")} />
          <ConnectHandle cx={w / 2} cy={h} onMouseDown={(e) => onStartConnect!(e, id, "bottom")} />
          <ConnectHandle cx={0} cy={h / 2} onMouseDown={(e) => onStartConnect!(e, id, "left")} />
        </>
      )}
    </g>
  );
}

function ConnectHandle({
  cx,
  cy,
  onMouseDown,
}: {
  cx: number;
  cy: number;
  onMouseDown: (e: MouseEvent) => void;
}) {
  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill="#0f172a"
      stroke="#fff"
      strokeWidth={1.5}
      style={{ cursor: "crosshair" }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onMouseDown(e);
      }}
    />
  );
}

export function EdgeArrow({
  edge,
  nodes,
  selected,
  onClick,
  onDoubleClick,
  onStartBendDrag,
}: {
  edge: CanvasEdge;
  nodes: ResolvedNode[];
  selected: boolean;
  onClick: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  /** Fires when the user grabs the middle segment of a selected edge. */
  onStartBendDrag?: (
    e: MouseEvent,
    edgeId: UUID,
    orientation: EdgeOrientation
  ) => void;
}) {
  const from = nodes.find((n) => n.id === edge.from);
  const to = nodes.find((n) => n.id === edge.to);
  if (!from || !to) return null;

  const { d, midX, midY, orientation, midSegment } = buildEdgePath(from, to, {
    bendX: edge.bendX,
    bendY: edge.bendY,
  });

  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        onClick(edge.id);
      }}
      onDoubleClick={(e) => {
        if (!onDoubleClick) return;
        e.stopPropagation();
        onDoubleClick(edge.id);
      }}
      style={{ cursor: "pointer" }}
    >
      <path
        d={d}
        fill="none"
        stroke={selected ? "#0f172a" : "#94a3b8"}
        strokeWidth={selected ? 2.5 : 1.5}
        markerEnd="url(#poet-arrow)"
      />
      {/* Hit-area for click */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
      {selected && onStartBendDrag && (
        // Wider, draggable hit-area on the middle segment only — perpendicular
        // drag reshapes the orthogonal route.
        <line
          x1={midSegment.x1}
          y1={midSegment.y1}
          x2={midSegment.x2}
          y2={midSegment.y2}
          stroke="transparent"
          strokeWidth={14}
          style={{
            cursor: orientation === "horizontal" ? "ew-resize" : "ns-resize",
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onStartBendDrag(e, edge.id, orientation);
          }}
        />
      )}
      {edge.label && (
        <g>
          <rect
            x={midX - 14}
            y={midY - 8}
            width={28}
            height={14}
            rx={3}
            fill="#fff"
            stroke="#e2e8f0"
          />
          <text
            x={midX}
            y={midY + 2}
            textAnchor="middle"
            fontSize="10"
            fill="#64748b"
            fontWeight="500"
          >
            {edge.label}
          </text>
        </g>
      )}
    </g>
  );
}
