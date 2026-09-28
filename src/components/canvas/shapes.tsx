"use client";

import { useState, type MouseEvent } from "react";

import type { IssueSeverity, UUID } from "@/lib/types";

import { MARKER, NODE_SHADOW_FILTER, THEME } from "./canvas-theme";
import type { ConnectSide, EdgeOrientation } from "./edge-path";
import type { EdgeRoute } from "./edge-routes";
import { roundedPath } from "./rounded-path";
import type { CanvasEdge, ResolvedNode } from "./types";

const ISSUE_FILL: Record<IssueSeverity, string> = {
  high: "#dc2626",
  medium: "#d97706",
};

// Routing lives in ./edge-path (pure, tested); re-exported so existing
// imports from "./shapes" keep working.
export {
  buildEdgePath,
  buildPinnedEdgePath,
  sidePoint,
  SNAP_STRAIGHT_THRESHOLD,
  type ConnectSide,
  type EdgeOrientation,
  type VerticalSide,
} from "./edge-path";

/** An edge renders as a backtrack loop when it is explicitly a rework edge OR
 * when both anchor faces are pinned (which routes through buildPinnedEdgePath).
 * Keeps styling and routing from ever disagreeing. */
export function isReworkEdge(
  edge: Pick<CanvasEdge, "kind" | "sourceSide" | "targetSide">
): boolean {
  return edge.kind === "rework" || (!!edge.sourceSide && !!edge.targetSide);
}

/** Gap between a node's side and its connect handle. */
const HANDLE_OFFSET = 12;

export function NodeShape({
  node,
  selected,
  issueLevel,
  reviewBadge,
  showHandles,
  onMouseDown,
  onContextMenu,
  onStartConnect,
  onDoubleClick,
  onOpenSubprocess,
  hideLabel,
}: {
  node: ResolvedNode;
  selected: boolean;
  issueLevel?: IssueSeverity | null;
  reviewBadge?: "approved" | "changes_requested" | null;
  /** When true, hover handles are always rendered (e.g. while the connect
   * tool is active). Otherwise they appear on hover or when selected. */
  showHandles?: boolean;
  onMouseDown: (e: MouseEvent, id: string) => void;
  onContextMenu?: (e: MouseEvent, id: string) => void;
  onStartConnect?: (e: MouseEvent, sourceId: UUID, side: ConnectSide) => void;
  onDoubleClick?: (id: string) => void;
  /** Drill into this step's sub-process (the "+" badge). */
  onOpenSubprocess?: (childModelId: UUID) => void;
  /** Hide the name while the on-canvas name box covers it. */
  hideLabel?: boolean;
}) {
  const { kind, x, y, w, h, label, id } = node;
  const isEvent = kind === "start" || kind === "end" || kind === "intermediate";
  const isGateway = kind === "gateway";
  const isTask = !isEvent && !isGateway;

  const [hover, setHover] = useState(false);
  const handlesVisible =
    !!onStartConnect && (hover || selected || showHandles);

  // Border colour, by precedence: issue flag > AI-proposed > hover > resting.
  // Selection is drawn as a separate outer ring, so it never changes the
  // shape's own border or size.
  const issueStroke = issueLevel ? ISSUE_FILL[issueLevel] : null;
  const proposed = node.aiProposed === true && !issueStroke;
  const border = issueStroke ?? (proposed ? THEME.proposed : hover ? "#94a3b8" : THEME.nodeBorder);
  const borderWidth = issueStroke || proposed ? 1.5 : THEME.nodeBorderWidth;
  const borderDash = proposed ? THEME.proposedDash : undefined;
  const shadow = `url(#${NODE_SHADOW_FILTER})`;

  return (
    <g
      transform={`translate(${x},${y})`}
      style={{ cursor: showHandles ? "crosshair" : "move" }}
      onMouseDown={(e) => onMouseDown(e, id)}
      onContextMenu={(e) => onContextMenu?.(e, id)}
      onDoubleClick={() => onDoubleClick?.(id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-node-id={id}
    >
      {handlesVisible && (
        // Invisible margin under the shape that keeps the node "hovered" while
        // the pointer crosses the gap to a handle. Drawn first so the shape
        // stays on top and still takes its own drags; a press in the gap is
        // swallowed so it neither drags the node nor starts a marquee.
        <rect
          x={-HANDLE_OFFSET - 7}
          y={-HANDLE_OFFSET - 7}
          width={w + (HANDLE_OFFSET + 7) * 2}
          height={h + (HANDLE_OFFSET + 7) * 2}
          fill="transparent"
          style={{ cursor: "default" }}
          onMouseDown={(e) => e.stopPropagation()}
        />
      )}
      {isEvent && (
        <>
          {selected && <SelectionRing kind="circle" w={w} h={h} />}
          <circle
            cx={w / 2}
            cy={h / 2}
            r={w / 2}
            fill={kind === "start" ? THEME.startFill : kind === "end" ? THEME.endFill : THEME.nodeFill}
            stroke={
              // Events keep their start/end colours; only an issue or an AI
              // proposal overrides them.
              issueStroke ??
              (proposed
                ? THEME.proposed
                : kind === "start"
                  ? THEME.startStroke
                  : kind === "end"
                    ? THEME.endStroke
                    : THEME.intermediateStroke)
            }
            strokeWidth={kind === "end" ? 3 : 2}
            strokeDasharray={borderDash}
          />
          {kind === "intermediate" && (
            <circle cx={w / 2} cy={h / 2} r={w / 2 - 4} fill="none" stroke={THEME.intermediateStroke} strokeWidth={1.25} />
          )}
        </>
      )}
      {isGateway && (
        <>
          {selected && <SelectionRing kind="diamond" w={w} h={h} />}
          <polygon
            points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`}
            fill={THEME.nodeFill}
            stroke={border}
            strokeWidth={borderWidth + 0.25}
            strokeDasharray={borderDash}
            strokeLinejoin="round"
            filter={shadow}
          />
          <GatewayGlyph type={node.type} cx={w / 2} cy={h / 2} />
        </>
      )}
      {isTask && (
        <>
          {selected && <SelectionRing kind="rect" w={w} h={h} />}
          <rect
            width={w}
            height={h}
            rx={THEME.nodeRadius}
            ry={THEME.nodeRadius}
            fill={THEME.nodeFill}
            stroke={border}
            strokeWidth={borderWidth}
            strokeDasharray={borderDash}
            filter={shadow}
          />
          {node.aiProposed && (
            <text x={w - 13} y={15} fontSize="11" fill={THEME.proposed} aria-label="AI proposed">
              ✦
            </text>
          )}
          {node.childModelId && (
            <g
              transform={`translate(${w / 2 - 7}, ${h - 15})`}
              aria-label="Open sub-process"
              role="button"
              style={{ cursor: "pointer" }}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (node.childModelId) onOpenSubprocess?.(node.childModelId);
              }}
            >
              <title>Open sub-process</title>
              <rect width={14} height={12} rx={3} fill="#fff" stroke={THEME.subtleText} strokeWidth={1} />
              <line x1={7} y1={3} x2={7} y2={9} stroke={THEME.subtleText} strokeWidth={1.25} strokeLinecap="round" />
              <line x1={4} y1={6} x2={10} y2={6} stroke={THEME.subtleText} strokeWidth={1.25} strokeLinecap="round" />
            </g>
          )}
          {!hideLabel && <foreignObject x={8} y={6} width={w - 16} height={h - (node.childModelId ? 20 : 12)}>
            <div
              style={{
                fontSize: THEME.nodeFontSize,
                lineHeight: 1.3,
                color: THEME.text,
                fontWeight: 500,
                textAlign: "center",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                fontFamily: "inherit",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  overflowWrap: "anywhere",
                }}
              >
                {label}
              </span>
            </div>
          </foreignObject>}
        </>
      )}
      {isEvent && !hideLabel && (
        <foreignObject x={-50} y={h + 4} width={w + 100} height={40}>
          <div
            style={{
              fontSize: THEME.eventFontSize,
              color: THEME.mutedText,
              textAlign: "center",
              lineHeight: 1.25,
              fontWeight: 500,
              fontFamily: "inherit",
            }}
          >
            {label}
          </div>
        </foreignObject>
      )}
      {isGateway && !hideLabel && (
        // Beside the upper-right edge of the diamond, clear of the branches
        // that leave from its corners.
        <foreignObject x={w * 0.75 + 4} y={-26} width={160} height={30}>
          <div
            style={{
              fontSize: THEME.eventFontSize,
              color: THEME.mutedText,
              lineHeight: 1.25,
              fontWeight: 500,
              fontFamily: "inherit",
              display: "flex",
              alignItems: "flex-end",
              height: "100%",
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
      {reviewBadge && (
        <g transform={`translate(8, -8)`} style={{ pointerEvents: "none" }}>
          <circle
            r={9}
            fill={reviewBadge === "approved" ? "#10b981" : "#f59e0b"}
            stroke="#fff"
            strokeWidth={2}
          />
          <text textAnchor="middle" y={4} fontSize="11" fontWeight="700" fill="#fff">
            {reviewBadge === "approved" ? "✓" : "!"}
          </text>
        </g>
      )}
      {node.evidenceStale && (
        <g transform={`translate(${w - 8}, ${h + 8})`} style={{ pointerEvents: "none" }}>
          <circle r={8} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
          <text textAnchor="middle" y={3.5} fontSize="10" fontWeight="700" fill="#fff">
            !
          </text>
          <title>Evidence stale — refresh from claims</title>
        </g>
      )}
      {handlesVisible && (
        <>
          {/* Sit just outside the shape, so they never cover the arrowheads
            landing on its sides. Which handle you grab still sets the side. */}
          <ConnectHandle cx={w / 2} cy={-HANDLE_OFFSET} onMouseDown={(e) => onStartConnect!(e, id, "top")} />
          <ConnectHandle cx={w + HANDLE_OFFSET} cy={h / 2} onMouseDown={(e) => onStartConnect!(e, id, "right")} />
          <ConnectHandle cx={w / 2} cy={h + HANDLE_OFFSET} onMouseDown={(e) => onStartConnect!(e, id, "bottom")} />
          <ConnectHandle cx={-HANDLE_OFFSET} cy={h / 2} onMouseDown={(e) => onStartConnect!(e, id, "left")} />
        </>
      )}
    </g>
  );
}

/** Outer ring + soft halo around a selected node. Drawn outside the shape so
 * selecting never changes the shape's own border or size. */
function SelectionRing({ kind, w, h }: { kind: "rect" | "circle" | "diamond"; w: number; h: number }) {
  const gap = 3.5;
  const ring = (strokeWidth: number, stroke: string) => {
    const common = { fill: "none", stroke, strokeWidth, pointerEvents: "none" as const };
    if (kind === "circle") return <circle cx={w / 2} cy={h / 2} r={w / 2 + gap} {...common} />;
    if (kind === "diamond") {
      const g = gap * 1.4;
      return (
        <polygon
          points={`${w / 2},${-g} ${w + g},${h / 2} ${w / 2},${h + g} ${-g},${h / 2}`}
          strokeLinejoin="round"
          {...common}
        />
      );
    }
    return (
      <rect
        x={-gap}
        y={-gap}
        width={w + gap * 2}
        height={h + gap * 2}
        rx={THEME.nodeRadius + gap}
        {...common}
      />
    );
  };
  return (
    <>
      {ring(7, THEME.selectionHalo)}
      {ring(2, THEME.selection)}
    </>
  );
}

/** BPMN gateway marker: × exclusive, + parallel, ○ inclusive. */
function GatewayGlyph({ type, cx, cy }: { type: string; cx: number; cy: number }) {
  const s = 7;
  const stroke = { stroke: THEME.subtleText, strokeWidth: 2.25, strokeLinecap: "round" as const, fill: "none" };
  if (type === "gateway_parallel") {
    return <path d={`M ${cx - s} ${cy} H ${cx + s} M ${cx} ${cy - s} V ${cy + s}`} {...stroke} pointerEvents="none" />;
  }
  if (type === "gateway_inclusive") {
    return <circle cx={cx} cy={cy} r={s} {...stroke} pointerEvents="none" />;
  }
  const d = s * 0.8;
  return (
    <path
      d={`M ${cx - d} ${cy - d} L ${cx + d} ${cy + d} M ${cx + d} ${cy - d} L ${cx - d} ${cy + d}`}
      {...stroke}
      pointerEvents="none"
    />
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
      r={4.5}
      fill="#fff"
      stroke={THEME.selection}
      strokeWidth={1.5}
      style={{ cursor: "crosshair" }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onMouseDown(e);
      }}
    />
  );
}

/** Rough width of 11px/600 label text, for sizing the pill without a DOM
 * measurement on every render. */
function pillWidth(text: string, min = 28): number {
  return Math.max(min, Math.round(text.length * 6.3 + 16));
}

export function EdgeArrow({
  edge,
  route,
  proposed,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  onStartBendDrag,
}: {
  edge: CanvasEdge;
  /** Precomputed by `computeEdgeRoutes`, which places every connector with
   * its neighbours in view (shared sides, gateway corners). */
  route: EdgeRoute;
  /** True when either end is an AI-proposed step. */
  proposed: boolean;
  selected: boolean;
  onClick: (id: string) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (e: MouseEvent, id: string) => void;
  /** Fires when the user grabs the middle segment of a selected edge. */
  onStartBendDrag?: (
    e: MouseEvent,
    edgeId: UUID,
    orientation: EdgeOrientation
  ) => void;
}) {
  const [hover, setHover] = useState(false);
  const isRework = isReworkEdge(edge);
  const { orientation, midSegment, labelAt } = route;
  const d = roundedPath(route.points);

  const stroke = selected
    ? THEME.selection
    : isRework
      ? THEME.rework
      : proposed
        ? THEME.proposed
        : THEME.edge;
  const marker = selected
    ? MARKER.selected
    : isRework
      ? MARKER.rework
      : proposed
        ? MARKER.proposed
        : MARKER.default;
  const dash = isRework ? THEME.reworkDash : !selected && proposed ? THEME.proposedDash : undefined;

  const labelW = edge.label ? pillWidth(edge.label) : 0;
  const conditionText = edge.condition ? `[${edge.condition}]` : null;

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
      onContextMenu={(e) => onContextMenu?.(e, edge.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ cursor: "pointer" }}
      data-edge-id={edge.id}
    >
      {(hover || selected) && (
        <path
          d={d}
          fill="none"
          stroke={selected ? THEME.selectionHalo : THEME.edgeHover}
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth={selected ? THEME.edgeSelectedWidth : THEME.edgeWidth}
        strokeDasharray={dash}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={`url(#${marker})`}
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
        <g pointerEvents="none">
          <rect
            x={labelAt.x - labelW / 2}
            y={labelAt.y - 9}
            width={labelW}
            height={18}
            rx={9}
            fill="#fff"
            stroke={selected ? THEME.selection : THEME.labelBorder}
          />
          <text
            x={labelAt.x}
            y={labelAt.y + 3.8}
            textAnchor="middle"
            fontSize="11"
            fill={THEME.labelText}
            fontWeight="600"
          >
            {edge.label}
          </text>
        </g>
      )}
      {conditionText &&
        (() => {
          // Gateway-branch guard, e.g. "amount < $10,000" — bracketed amber
          // italic so it reads as a condition, not a plain edge label. Stacked
          // below the label when both are present.
          const boxW = Math.max(28, Math.round(conditionText.length * 5.8 + 16));
          const cy = edge.label ? labelAt.y + 21 : labelAt.y;
          return (
            <g pointerEvents="none">
              <rect
                x={labelAt.x - boxW / 2}
                y={cy - 9}
                width={boxW}
                height={18}
                rx={9}
                fill={THEME.conditionFill}
                stroke={THEME.conditionBorder}
              />
              <text
                x={labelAt.x}
                y={cy + 3.5}
                textAnchor="middle"
                fontSize="10.5"
                fontStyle="italic"
                fill={THEME.conditionText}
                fontWeight="500"
              >
                {conditionText}
              </text>
            </g>
          );
        })()}
    </g>
  );
}
