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
export function buildEdgePath(
  from: SimpleRect,
  to: SimpleRect
): { d: string; midX: number; midY: number } {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = tc.x - fc.x;
  const dy = tc.y - fc.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  if (horizontal) {
    const exitX = dx >= 0 ? from.x + from.w : from.x;
    const entryX = dx >= 0 ? to.x : to.x + to.w;
    const exitY = fc.y;
    const entryY = tc.y;
    const midX = (exitX + entryX) / 2;
    return {
      d: `M ${exitX} ${exitY} L ${midX} ${exitY} L ${midX} ${entryY} L ${entryX} ${entryY}`,
      midX,
      midY: (exitY + entryY) / 2,
    };
  }
  const exitY = dy >= 0 ? from.y + from.h : from.y;
  const entryY = dy >= 0 ? to.y : to.y + to.h;
  const exitX = fc.x;
  const entryX = tc.x;
  const midY = (exitY + entryY) / 2;
  return {
    d: `M ${exitX} ${exitY} L ${exitX} ${midY} L ${entryX} ${midY} L ${entryX} ${entryY}`,
    midX: (exitX + entryX) / 2,
    midY,
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
      style={{ cursor: "move" }}
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
}: {
  edge: CanvasEdge;
  nodes: ResolvedNode[];
  selected: boolean;
  onClick: (id: string) => void;
  onDoubleClick?: (id: string) => void;
}) {
  const from = nodes.find((n) => n.id === edge.from);
  const to = nodes.find((n) => n.id === edge.to);
  if (!from || !to) return null;

  const { d, midX, midY } = buildEdgePath(from, to);

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
