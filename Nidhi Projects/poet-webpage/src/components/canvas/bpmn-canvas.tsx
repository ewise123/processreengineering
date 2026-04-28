"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import { api } from "@/lib/api";
import type { IssueSeverity, UUID } from "@/lib/types";

import { FloatingToolbar, type CanvasTool } from "./floating-toolbar";
import { LaneRail } from "./lane-rail";
import { LANE_HEIGHT } from "./layout";
import { EdgeArrow, NodeShape } from "./shapes";
import type {
  CanvasEdge,
  CanvasLane,
  CanvasNode,
  ResolvedNode,
  Viewport,
} from "./types";
import { useGraphPersistence, type SaveStatus } from "./use-persistence";

const WORLD_WIDTH_MIN = 1700;
const WORLD_RIGHT_PADDING = 240;
const MIN_LANE_HEIGHT = 90;

const LANE_PALETTE = [
  "#dbeafe",
  "#dcfce7",
  "#fef9c3",
  "#fae8ff",
  "#fce7f3",
  "#cffafe",
  "#ffedd5",
  "#e0e7ff",
];

type Drag =
  | { type: "node"; id: string; offX: number; offY: number }
  | { type: "pan"; startX: number; startY: number; tx0: number; ty0: number };

function laneAtY(y: number, lanes: CanvasLane[]): CanvasLane | undefined {
  if (lanes.length === 0) return undefined;
  if (y < lanes[0].y) return lanes[0];
  const last = lanes[lanes.length - 1];
  if (y >= last.y + last.h) return last;
  return lanes.find((l) => y >= l.y && y < l.y + l.h);
}

export function BpmnCanvas({
  projectId,
  modelId,
  versionId,
  initialNodes,
  initialEdges,
  initialLanes,
  issuesByNode,
  onSaveStatusChange,
  onSelectionChange,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  initialNodes: CanvasNode[];
  initialEdges: CanvasEdge[];
  initialLanes: CanvasLane[];
  issuesByNode?: Record<string, IssueSeverity>;
  onSaveStatusChange?: (status: SaveStatus, error: string | null) => void;
  onSelectionChange?: (
    selected:
      | {
          id: string;
          kind: "node" | "edge";
          name?: string;
          nodeKind?: string;
          laneId?: string | null;
        }
      | null
  ) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [nodes, setNodes] = useState(initialNodes);
  const [edges] = useState(initialEdges);
  const [lanes, setLanes] = useState(initialLanes);
  const [viewport, setViewport] = useState<Viewport>({
    tx: 60,
    ty: 60,
    scale: 1,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [showIssues, setShowIssues] = useState(true);
  const [reviewMode, setReviewMode] = useState(false);

  const issuesMap = issuesByNode ?? {};
  const issueCount = Object.keys(issuesMap).length;

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;

  const { status, error, markNode, markLane, flush } = useGraphPersistence({
    projectId,
  });

  // Notify parent of save state transitions for UI indicator.
  useEffect(() => {
    onSaveStatusChange?.(status, error);
  }, [status, error, onSaveStatusChange]);

  // Notify parent of selection so it can drive side panels.
  useEffect(() => {
    if (!onSelectionChange) return;
    if (selectedId == null) {
      onSelectionChange(null);
      return;
    }
    const node = nodesRef.current.find((n) => n.id === selectedId);
    if (node) {
      onSelectionChange({
        id: selectedId,
        kind: "node",
        name: node.label,
        nodeKind: node.kind,
        laneId: node.laneId,
      });
      return;
    }
    onSelectionChange({ id: selectedId, kind: "edge" });
  }, [selectedId, onSelectionChange]);

  const worldWidth = useMemo(() => {
    const maxX = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0);
    return Math.max(WORLD_WIDTH_MIN, maxX + WORLD_RIGHT_PADDING);
  }, [nodes]);

  const worldHeight = useMemo(() => {
    const maxBottom = lanes.reduce((m, l) => Math.max(m, l.y + l.h), 0);
    return Math.max(620, maxBottom);
  }, [lanes]);

  const renderNodes: ResolvedNode[] = useMemo(() => {
    const laneMap = new Map(lanes.map((l) => [l.id, l]));
    return nodes.map((n) => {
      const lane = n.laneId ? laneMap.get(n.laneId) : undefined;
      const y = lane ? lane.y + n.relativeY : n.relativeY;
      const { relativeY: _ignore, ...rest } = n;
      void _ignore;
      return { ...rest, y };
    });
  }, [nodes, lanes]);

  const toWorld = useCallback(
    (sx: number, sy: number) => {
      if (!svgRef.current) return { x: 0, y: 0 };
      const rect = svgRef.current.getBoundingClientRect();
      return {
        x: (sx - rect.left - viewport.tx) / viewport.scale,
        y: (sy - rect.top - viewport.ty) / viewport.scale,
      };
    },
    [viewport]
  );

  // Native wheel handler with passive:false so Cmd/Ctrl+wheel zooms the canvas.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const v = viewportRef.current;
      if (e.ctrlKey || e.metaKey) {
        const delta = -e.deltaY * 0.002;
        const newScale = Math.max(0.3, Math.min(2.5, v.scale * (1 + delta)));
        const wx = (mx - v.tx) / v.scale;
        const wy = (my - v.ty) / v.scale;
        setViewport({
          scale: newScale,
          tx: mx - wx * newScale,
          ty: my - wy * newScale,
        });
      } else {
        setViewport({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY });
      }
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, []);

  const onNodeMouseDown = (e: MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedId(id);
    const resolved = renderNodes.find((n) => n.id === id);
    if (!resolved) return;
    const { x, y } = toWorld(e.clientX, e.clientY);
    setDrag({ type: "node", id, offX: x - resolved.x, offY: y - resolved.y });
  };

  const onSvgMouseDown = (e: MouseEvent<SVGSVGElement>) => {
    const target = e.target as SVGElement;
    const isBg =
      target === svgRef.current ||
      (target.tagName === "rect" && target.getAttribute("data-bg") === "1");
    if (!isBg) return;
    setSelectedId(null);
    setDrag({
      type: "pan",
      startX: e.clientX,
      startY: e.clientY,
      tx0: viewport.tx,
      ty0: viewport.ty,
    });
  };

  // Drag is tracked at the *document* level so motion across the lane-rail
  // HTML overlay (or out of the SVG entirely) doesn't interrupt the drag.
  useEffect(() => {
    if (!drag) return;

    const screenToWorld = (sx: number, sy: number) => {
      if (!svgRef.current) return { x: 0, y: 0 };
      const rect = svgRef.current.getBoundingClientRect();
      const v = viewportRef.current;
      return {
        x: (sx - rect.left - v.tx) / v.scale,
        y: (sy - rect.top - v.ty) / v.scale,
      };
    };

    const onMove = (e: globalThis.MouseEvent) => {
      if (drag.type === "node") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        const newX = x - drag.offX;
        const newAbsY = y - drag.offY;
        const currLanes = lanesRef.current;
        setNodes((curr) =>
          curr.map((n) => {
            if (n.id !== drag.id) return n;
            const targetLane =
              laneAtY(newAbsY + n.h / 2, currLanes) ??
              (n.laneId
                ? currLanes.find((l) => l.id === n.laneId)
                : currLanes[0]);
            if (!targetLane) {
              return { ...n, x: newX };
            }
            const maxRel = Math.max(0, targetLane.h - n.h);
            const rel = Math.max(
              0,
              Math.min(maxRel, newAbsY - targetLane.y)
            );
            return {
              ...n,
              x: newX,
              laneId: targetLane.id,
              relativeY: rel,
            };
          })
        );
      } else {
        const v = viewportRef.current;
        setViewport({
          ...v,
          tx: drag.tx0 + (e.clientX - drag.startX),
          ty: drag.ty0 + (e.clientY - drag.startY),
        });
      }
    };

    const onUp = () => {
      if (drag.type === "node") {
        const final = nodesRef.current.find((n) => n.id === drag.id);
        if (final) {
          markNode(final.id, {
            x: final.x,
            relative_y: final.relativeY,
            lane_id: final.laneId ?? undefined,
          });
        }
      }
      setDrag(null);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [drag, markNode]);

  // Internal helpers that compute the new lane array, set state, mark dirty.
  const recomputeY = (ls: CanvasLane[]): CanvasLane[] => {
    let y = 0;
    return ls.map((l) => {
      const out = { ...l, y };
      y += l.h;
      return out;
    });
  };

  const moveLane = useCallback(
    (laneId: string, targetIdx: number) => {
      const curr = lanesRef.current;
      const idx = curr.findIndex((l) => l.id === laneId);
      if (idx === -1) return;
      const removed = [...curr.slice(0, idx), ...curr.slice(idx + 1)];
      const target = targetIdx > idx ? targetIdx - 1 : targetIdx;
      const reordered = [
        ...removed.slice(0, target),
        curr[idx],
        ...removed.slice(target),
      ];
      const next = recomputeY(reordered);
      setLanes(next);
      // Mark every lane whose index changed (defensive: just re-PATCH them all)
      next.forEach((l, i) => {
        const oldIdx = curr.findIndex((c) => c.id === l.id);
        if (oldIdx !== i) markLane(l.id, { order_index: i });
      });
    },
    [markLane]
  );

  const resizeLane = useCallback(
    (laneId: string, newH: number) => {
      const curr = lanesRef.current;
      const idx = curr.findIndex((l) => l.id === laneId);
      if (idx === -1) return;
      const clamped = Math.max(MIN_LANE_HEIGHT, Math.round(newH));
      const next = recomputeY(
        curr.map((l) => (l.id === laneId ? { ...l, h: clamped } : l))
      );
      setLanes(next);
      markLane(laneId, { height_px: clamped });
    },
    [markLane]
  );

  const renameLane = useCallback(
    (laneId: string, newName: string) => {
      setLanes((curr) =>
        curr.map((l) => (l.id === laneId ? { ...l, label: newName } : l))
      );
      markLane(laneId, { name: newName });
    },
    [markLane]
  );

  const addLaneAt = useCallback(
    async (atIndex: number) => {
      // Flush pending lane patches before mutating the lane set so we don't
      // commit stale order_index updates against shifted IDs.
      await flush();
      try {
        const created = await api.createLane(projectId, modelId, versionId, {
          name: "New lane",
          order_index: atIndex,
          height_px: LANE_HEIGHT,
        });
        const newLane: CanvasLane = {
          id: created.id,
          label: created.name,
          color: LANE_PALETTE[atIndex % LANE_PALETTE.length],
          y: 0,
          h: created.height_px,
        };
        // Read the latest lanes AFTER await so concurrent UI edits aren't
        // overwritten with a stale snapshot.
        const curr = lanesRef.current;
        const inserted = [
          ...curr.slice(0, atIndex),
          newLane,
          ...curr.slice(atIndex),
        ];
        setLanes(recomputeY(inserted));
        // Server now atomically shifts later lanes' order_index inside the
        // create transaction, so no follow-up PATCH calls are needed.
      } catch (e) {
        console.error("Failed to add lane", e);
      }
    },
    [projectId, modelId, versionId, flush]
  );

  const deleteLane = useCallback(
    async (laneId: string) => {
      if (lanesRef.current.length <= 1) return;
      // Flush pending PATCHes so we don't fire a 404 against a deleted lane.
      await flush();
      try {
        await api.deleteLane(projectId, laneId);
        const latest = lanesRef.current;
        const remaining = latest.filter((l) => l.id !== laneId);
        if (remaining.length === 0) return;
        const fallback = remaining[0];
        setLanes(recomputeY(remaining));
        // Mirror server-side reassignment so the UI stays consistent without
        // refetching the graph.
        setNodes((nodesNow) =>
          nodesNow.map((n) =>
            n.laneId === laneId
              ? { ...n, laneId: fallback.id, relativeY: 0 }
              : n
          )
        );
        // Server resequences remaining lanes' order_index in the same
        // transaction, so no follow-up PATCH calls are needed.
      } catch (e) {
        console.error("Failed to delete lane", e);
      }
    },
    [projectId, flush]
  );

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <svg
        ref={svgRef}
        onMouseDown={onSvgMouseDown}
        style={{
          width: "100%",
          height: "100%",
          cursor: drag?.type === "pan" ? "grabbing" : "default",
          userSelect: "none",
        }}
      >
        <defs>
          <marker
            id="poet-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
          </marker>
          <pattern
            id="poet-grid"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="1" fill="#e2e8f0" />
          </pattern>
        </defs>

        <rect data-bg="1" width="100%" height="100%" fill="#fafbfc" />

        <g
          transform={`translate(${viewport.tx},${viewport.ty}) scale(${viewport.scale})`}
        >
          <rect
            data-bg="1"
            x={-1000}
            y={-1000}
            width={worldWidth + 2000}
            height={worldHeight + 2000}
            fill="url(#poet-grid)"
          />
          {lanes.map((lane) => (
            <g key={lane.id}>
              <rect
                data-bg="1"
                x={0}
                y={lane.y}
                width={worldWidth}
                height={lane.h}
                fill={lane.color}
                opacity={0.35}
              />
              <rect
                x={0}
                y={lane.y}
                width={44}
                height={lane.h}
                fill={lane.color}
                opacity={0.7}
              />
              <line
                x1={0}
                y1={lane.y + lane.h}
                x2={worldWidth}
                y2={lane.y + lane.h}
                stroke="#e2e8f0"
                strokeDasharray="4 4"
              />
            </g>
          ))}
          {edges.map((edge) => (
            <EdgeArrow
              key={edge.id}
              edge={edge}
              nodes={renderNodes}
              selected={selectedId === edge.id}
              onClick={(id) => setSelectedId(id)}
            />
          ))}
          {renderNodes.map((node) => (
            <NodeShape
              key={node.id}
              node={node}
              selected={selectedId === node.id}
              issueLevel={showIssues ? issuesMap[node.id] ?? null : null}
              onMouseDown={onNodeMouseDown}
            />
          ))}
        </g>
      </svg>

      <LaneRail
        lanes={lanes}
        viewport={viewport}
        onMoveLane={moveLane}
        onResizeLane={resizeLane}
        onRenameLane={renameLane}
        onAddLaneAt={addLaneAt}
        onDeleteLane={deleteLane}
      />

      <FloatingToolbar
        tool={tool}
        onToolChange={setTool}
        viewport={viewport}
        onViewportChange={setViewport}
        showIssues={showIssues}
        onShowIssuesChange={setShowIssues}
        reviewMode={reviewMode}
        onReviewModeChange={setReviewMode}
        issueCount={issueCount}
      />
    </div>
  );
}
