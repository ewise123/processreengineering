"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type WheelEvent,
} from "react";

import { LaneRail } from "./lane-rail";
import { EdgeArrow, NodeShape } from "./shapes";
import type {
  CanvasEdge,
  CanvasLane,
  CanvasNode,
  Viewport,
} from "./types";

const WORLD_WIDTH = 1700;
const MIN_LANE_HEIGHT = 90;

type Drag =
  | { type: "node"; id: string; offX: number; offY: number }
  | { type: "pan"; startX: number; startY: number; tx0: number; ty0: number };

export function BpmnCanvas({
  initialNodes,
  initialEdges,
  initialLanes,
}: {
  initialNodes: CanvasNode[];
  initialEdges: CanvasEdge[];
  initialLanes: CanvasLane[];
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

  const worldHeight = useMemo(() => {
    const maxBottom = lanes.reduce((m, l) => Math.max(m, l.y + l.h), 0);
    return Math.max(620, maxBottom);
  }, [lanes]);

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

  const onWheel = (e: WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (e.ctrlKey || e.metaKey) {
      const delta = -e.deltaY * 0.002;
      const newScale = Math.max(
        0.3,
        Math.min(2.5, viewport.scale * (1 + delta))
      );
      const wx = (mx - viewport.tx) / viewport.scale;
      const wy = (my - viewport.ty) / viewport.scale;
      setViewport({
        scale: newScale,
        tx: mx - wx * newScale,
        ty: my - wy * newScale,
      });
    } else {
      setViewport({
        ...viewport,
        tx: viewport.tx - e.deltaX,
        ty: viewport.ty - e.deltaY,
      });
    }
  };

  const onNodeMouseDown = (e: MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedId(id);
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const { x, y } = toWorld(e.clientX, e.clientY);
    setDrag({ type: "node", id, offX: x - node.x, offY: y - node.y });
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

  const onMouseMove = (e: MouseEvent) => {
    if (!drag) return;
    if (drag.type === "node") {
      const { x, y } = toWorld(e.clientX, e.clientY);
      setNodes((curr) =>
        curr.map((n) =>
          n.id === drag.id
            ? { ...n, x: x - drag.offX, y: y - drag.offY }
            : n
        )
      );
    } else {
      setViewport({
        ...viewport,
        tx: drag.tx0 + (e.clientX - drag.startX),
        ty: drag.ty0 + (e.clientY - drag.startY),
      });
    }
  };

  const onMouseUp = () => setDrag(null);

  const moveLane = useCallback((laneId: string, targetIdx: number) => {
    setLanes((curr) => {
      const idx = curr.findIndex((l) => l.id === laneId);
      if (idx === -1) return curr;
      const removed = [...curr.slice(0, idx), ...curr.slice(idx + 1)];
      const target = targetIdx > idx ? targetIdx - 1 : targetIdx;
      const reordered = [
        ...removed.slice(0, target),
        curr[idx],
        ...removed.slice(target),
      ];
      let y = 0;
      return reordered.map((l) => {
        const next = { ...l, y };
        y += l.h;
        return next;
      });
    });
  }, []);

  const resizeLane = useCallback((laneId: string, newH: number) => {
    setLanes((curr) => {
      const next = curr.map((l) =>
        l.id === laneId ? { ...l, h: Math.max(MIN_LANE_HEIGHT, newH) } : l
      );
      let y = 0;
      return next.map((l) => {
        const out = { ...l, y };
        y += l.h;
        return out;
      });
    });
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <svg
        ref={svgRef}
        onWheel={onWheel}
        onMouseDown={onSvgMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
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
            width={WORLD_WIDTH + 2000}
            height={worldHeight + 2000}
            fill="url(#poet-grid)"
          />
          {/* Lane backgrounds */}
          {lanes.map((lane) => (
            <g key={lane.id}>
              <rect
                x={0}
                y={lane.y}
                width={WORLD_WIDTH}
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
                x2={WORLD_WIDTH}
                y2={lane.y + lane.h}
                stroke="#e2e8f0"
                strokeDasharray="4 4"
              />
            </g>
          ))}
          {/* Edges */}
          {edges.map((edge) => (
            <EdgeArrow
              key={edge.id}
              edge={edge}
              nodes={nodes}
              selected={selectedId === edge.id}
              onClick={(id) => setSelectedId(id)}
            />
          ))}
          {/* Nodes */}
          {nodes.map((node) => (
            <NodeShape
              key={node.id}
              node={node}
              selected={selectedId === node.id}
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
      />
    </div>
  );
}
