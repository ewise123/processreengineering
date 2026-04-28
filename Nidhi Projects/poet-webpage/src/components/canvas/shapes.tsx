"use client";

import type { MouseEvent } from "react";

import type { IssueSeverity } from "@/lib/types";

import type { CanvasEdge, ResolvedNode } from "./types";

const ISSUE_FILL: Record<IssueSeverity, string> = {
  high: "#dc2626",
  medium: "#d97706",
  low: "#64748b",
};

export function NodeShape({
  node,
  selected,
  issueLevel,
  onMouseDown,
}: {
  node: ResolvedNode;
  selected: boolean;
  issueLevel?: IssueSeverity | null;
  onMouseDown: (e: MouseEvent, id: string) => void;
}) {
  const { kind, x, y, w, h, label, id } = node;
  const isEvent = kind === "start" || kind === "end" || kind === "intermediate";
  const isGateway = kind === "gateway";
  const isTask = !isEvent && !isGateway;

  const issueStroke = issueLevel ? ISSUE_FILL[issueLevel] : null;
  const stroke = selected ? "#0f172a" : (issueStroke ?? "#475569");
  const strokeWidth = selected ? 2.5 : issueLevel ? 2 : 1.2;
  const fill = "#ffffff";

  return (
    <g
      transform={`translate(${x},${y})`}
      style={{ cursor: "move" }}
      onMouseDown={(e) => onMouseDown(e, id)}
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
    </g>
  );
}

export function EdgeArrow({
  edge,
  nodes,
  selected,
  onClick,
}: {
  edge: CanvasEdge;
  nodes: ResolvedNode[];
  selected: boolean;
  onClick: (id: string) => void;
}) {
  const from = nodes.find((n) => n.id === edge.from);
  const to = nodes.find((n) => n.id === edge.to);
  if (!from || !to) return null;

  const fx = from.x + from.w;
  const fy = from.y + from.h / 2;
  const tx = to.x;
  const ty = to.y + to.h / 2;
  const midX = fx + (tx - fx) / 2;
  const d = `M ${fx} ${fy} L ${midX} ${fy} L ${midX} ${ty} L ${tx} ${ty}`;
  const midY = (fy + ty) / 2;

  return (
    <g
      onClick={(e) => {
        e.stopPropagation();
        onClick(edge.id);
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
