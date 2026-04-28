"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent,
} from "react";

import { api } from "@/lib/api";
import type { IssueSeverity, UUID } from "@/lib/types";

import { FloatingToolbar, type CanvasTool } from "./floating-toolbar";
import { LaneRail } from "./lane-rail";
import { LANE_HEIGHT } from "./layout";
import {
  PALETTE_DRAG_MIME,
  PALETTE_SHAPES,
  ShapePalette,
} from "./shape-palette";
import { EdgeArrow, NodeShape } from "./shapes";
import type {
  CanvasEdge,
  CanvasLane,
  CanvasNode,
  CanvasNodeKind,
  ResolvedNode,
  Viewport,
} from "./types";
import { useGraphPersistence, type SaveStatus } from "./use-persistence";
import { useUndoStack } from "./use-undo-stack";

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
  | {
      type: "node";
      id: string;
      offX: number;
      offY: number;
      // Captured at drag-start so we can record the inverse for undo.
      origX: number;
      origRelativeY: number;
      origLaneId: UUID | null;
    }
  | { type: "pan"; startX: number; startY: number; tx0: number; ty0: number }
  | {
      type: "connect";
      sourceId: UUID;
      // Live cursor position in world coords for the temp line.
      currX: number;
      currY: number;
    };

function laneAtY(y: number, lanes: CanvasLane[]): CanvasLane | undefined {
  if (lanes.length === 0) return undefined;
  if (y < lanes[0].y) return lanes[0];
  const last = lanes[lanes.length - 1];
  if (y >= last.y + last.h) return last;
  return lanes.find((l) => y >= l.y && y < l.y + l.h);
}

export interface BpmnCanvasHandle {
  /** Calls the API + removes the node (and any edges touching it) from
   * local state without re-fetching the whole graph. */
  deleteNode: (id: UUID) => Promise<void>;
}

interface BpmnCanvasProps {
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
  /** Fires after a node is removed (via panel Delete or keyboard). The page
   * uses this to invalidate dependent queries like issue badges. */
  onNodeDeleted?: (id: UUID) => void;
}

export const BpmnCanvas = forwardRef<BpmnCanvasHandle, BpmnCanvasProps>(
function BpmnCanvas({
  projectId,
  modelId,
  versionId,
  initialNodes,
  initialEdges,
  initialLanes,
  issuesByNode,
  onSaveStatusChange,
  onSelectionChange,
  onNodeDeleted,
}, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
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

  const { record, undo, redo, canUndo, canRedo } = useUndoStack();

  const deleteNodeImpl = useCallback(
    async (id: UUID) => {
      await api.deleteNode(projectId, id);
      setNodes((curr) => curr.filter((n) => n.id !== id));
      setEdges((curr) => curr.filter((e) => e.from !== id && e.to !== id));
      setSelectedId((curr) => (curr === id ? null : curr));
      onNodeDeleted?.(id);
    },
    [projectId, onNodeDeleted]
  );

  const deleteEdgeImpl = useCallback(
    async (id: UUID) => {
      const edge = edgesRef.current.find((e) => e.id === id);
      if (!edge) return;
      // currentId tracks whichever UUID the edge has now — across undo/redo
      // cycles, recreating issues a NEW id, so the next delete must use it.
      let currentId = id;
      const remove = (rid: UUID) => {
        setEdges((curr) => curr.filter((e2) => e2.id !== rid));
        setSelectedId((curr) => (curr === rid ? null : curr));
      };
      const recreate = async () => {
        const created = await api.createEdge(projectId, modelId, versionId, {
          source_node_id: edge.from,
          target_node_id: edge.to,
          label: edge.label,
        });
        currentId = created.id;
        setEdges((curr) => [
          ...curr,
          {
            id: currentId,
            from: edge.from,
            to: edge.to,
            label: created.label ?? null,
          },
        ]);
      };
      await api.deleteEdge(projectId, currentId);
      remove(currentId);
      record({
        description: "Delete edge",
        do: async () => {
          await api.deleteEdge(projectId, currentId);
          remove(currentId);
        },
        undo: recreate,
      });
    },
    [projectId, modelId, versionId, record]
  );

  const createEdgeImpl = useCallback(
    async (sourceId: UUID, targetId: UUID) => {
      let currentId: UUID;
      const create = async () => {
        const created = await api.createEdge(projectId, modelId, versionId, {
          source_node_id: sourceId,
          target_node_id: targetId,
        });
        currentId = created.id;
        setEdges((curr) => [
          ...curr,
          {
            id: currentId,
            from: sourceId,
            to: targetId,
            label: created.label ?? null,
          },
        ]);
      };
      await create();
      record({
        description: "Create edge",
        do: create,
        undo: async () => {
          await api.deleteEdge(projectId, currentId);
          setEdges((curr) => curr.filter((e) => e.id !== currentId));
          setSelectedId((curr) => (curr === currentId ? null : curr));
        },
      });
    },
    [projectId, modelId, versionId, record]
  );

  useImperativeHandle(ref, () => ({ deleteNode: deleteNodeImpl }), [
    deleteNodeImpl,
  ]);

  // Keyboard shortcuts: Delete/Backspace to delete; Cmd/Ctrl+Z and
  // Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y) for undo/redo. All of them no-op
  // when the user is typing in an input/textarea/contenteditable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (inEditable) return;

      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) {
          void redo();
        } else {
          void undo();
        }
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        void redo();
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (!selectedId) return;
        if (nodesRef.current.some((n) => n.id === selectedId)) {
          e.preventDefault();
          void deleteNodeImpl(selectedId);
        } else if (edgesRef.current.some((edge) => edge.id === selectedId)) {
          e.preventDefault();
          void deleteEdgeImpl(selectedId);
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [selectedId, deleteNodeImpl, deleteEdgeImpl, undo, redo]);

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

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
        const newScale = Math.max(0.1, Math.min(2.5, v.scale * (1 + delta)));
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
    const stored = nodesRef.current.find((n) => n.id === id);
    if (!resolved || !stored) return;
    const { x, y } = toWorld(e.clientX, e.clientY);
    if (tool === "connect") {
      // Drag from this node — temp line follows the cursor; on mouseup we
      // create an edge if the user is over another node.
      setDrag({ type: "connect", sourceId: id, currX: x, currY: y });
      return;
    }
    setDrag({
      type: "node",
      id,
      offX: x - resolved.x,
      offY: y - resolved.y,
      origX: stored.x,
      origRelativeY: stored.relativeY,
      origLaneId: stored.laneId,
    });
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
      if (drag.type === "connect") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        setDrag({ ...drag, currX: x, currY: y });
        return;
      }
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

    const onUp = (e: globalThis.MouseEvent) => {
      if (drag.type === "connect") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        const target = nodesRef.current.find((n) => {
          // Resolve node Y the same way renderNodes does.
          const lane = n.laneId
            ? lanesRef.current.find((l) => l.id === n.laneId)
            : undefined;
          const ny = lane ? lane.y + n.relativeY : n.relativeY;
          return (
            n.id !== drag.sourceId &&
            x >= n.x &&
            x <= n.x + n.w &&
            y >= ny &&
            y <= ny + n.h
          );
        });
        if (target) {
          const sourceId = drag.sourceId;
          const targetId = target.id;
          const exists = edgesRef.current.some(
            (e2) => e2.from === sourceId && e2.to === targetId
          );
          if (!exists) {
            void createEdgeImpl(sourceId, targetId).catch((err) =>
              console.error("Failed to create edge", err)
            );
          }
        }
        setDrag(null);
        return;
      }
      if (drag.type === "node") {
        const final = nodesRef.current.find((n) => n.id === drag.id);
        if (final) {
          markNode(final.id, {
            x: final.x,
            relative_y: final.relativeY,
            lane_id: final.laneId ?? undefined,
          });
          // Only register an undo entry if the node actually moved —
          // a click without drag should not pollute the history.
          const moved =
            final.x !== drag.origX ||
            final.relativeY !== drag.origRelativeY ||
            final.laneId !== drag.origLaneId;
          if (moved) {
            const newPos = {
              x: final.x,
              relativeY: final.relativeY,
              laneId: final.laneId,
            };
            const oldPos = {
              x: drag.origX,
              relativeY: drag.origRelativeY,
              laneId: drag.origLaneId,
            };
            record({
              description: "Move node",
              do: () => applyNodePositionLocal(drag.id, newPos),
              undo: () => applyNodePositionLocal(drag.id, oldPos),
            });
          }
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
  }, [drag, markNode, record, createEdgeImpl]);

  // Internal helpers that compute the new lane array, set state, mark dirty.
  const onCanvasDragOver = (e: ReactDragEvent<SVGSVGElement>) => {
    if (!e.dataTransfer.types.includes(PALETTE_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onCanvasDrop = async (e: ReactDragEvent<SVGSVGElement>) => {
    const kind = e.dataTransfer.getData(PALETTE_DRAG_MIME) as CanvasNodeKind;
    if (!kind) return;
    e.preventDefault();
    const shape = PALETTE_SHAPES.find((s) => s.kind === kind);
    if (!shape) return;
    const { x, y } = toWorld(e.clientX, e.clientY);
    const dropCenterX = x - shape.w / 2;
    const dropCenterY = y - shape.h / 2;
    const currLanes = lanesRef.current;
    const targetLane =
      laneAtY(dropCenterY + shape.h / 2, currLanes) ?? currLanes[0];
    if (!targetLane) return;
    const maxRel = Math.max(0, targetLane.h - shape.h);
    const rel = Math.max(
      0,
      Math.min(maxRel, dropCenterY - targetLane.y)
    );
    try {
      const created = await api.createNode(projectId, modelId, versionId, {
        type: shape.backendType,
        name: shape.defaultName,
        lane_id: targetLane.id,
        x: dropCenterX,
        relative_y: rel,
      });
      const newNode: CanvasNode = {
        id: created.id,
        kind: shape.kind,
        label: created.name,
        laneId: targetLane.id,
        x: dropCenterX,
        relativeY: rel,
        w: shape.w,
        h: shape.h,
      };
      setNodes((curr) => [...curr, newNode]);
      setSelectedId(newNode.id);
    } catch (err) {
      console.error("Failed to create node from palette", err);
    }
  };

  const fitToWorld = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const padding = 40;
    const usableW = Math.max(1, rect.width - padding * 2);
    const usableH = Math.max(1, rect.height - padding * 2);
    const scale = Math.max(
      0.3,
      Math.min(2.5, Math.min(usableW / worldWidth, usableH / worldHeight))
    );
    setViewport({
      scale,
      tx: (rect.width - worldWidth * scale) / 2,
      ty: (rect.height - worldHeight * scale) / 2,
    });
  }, [worldWidth, worldHeight]);

  // Low-level mutator used by undo/redo callbacks for node moves. Bypasses
  // record() so undo replay does not pollute the history stack.
  const applyNodePositionLocal = useCallback(
    (
      id: UUID,
      pos: { x: number; relativeY: number; laneId: UUID | null }
    ) => {
      setNodes((curr) =>
        curr.map((n) =>
          n.id === id
            ? { ...n, x: pos.x, relativeY: pos.relativeY, laneId: pos.laneId }
            : n
        )
      );
      markNode(id, {
        x: pos.x,
        relative_y: pos.relativeY,
        lane_id: pos.laneId ?? undefined,
      });
    },
    [markNode]
  );

  const recomputeY = (ls: CanvasLane[]): CanvasLane[] => {
    let y = 0;
    return ls.map((l) => {
      const out = { ...l, y };
      y += l.h;
      return out;
    });
  };

  const moveLaneLocal = useCallback(
    (laneId: string, targetIdx: number) => {
      const curr = lanesRef.current;
      const idx = curr.findIndex((l) => l.id === laneId);
      if (idx === -1) return;
      const removed = [...curr.slice(0, idx), ...curr.slice(idx + 1)];
      const target = targetIdx > idx ? targetIdx - 1 : targetIdx;
      const clampedTarget = Math.max(0, Math.min(removed.length, target));
      const reordered = [
        ...removed.slice(0, clampedTarget),
        curr[idx],
        ...removed.slice(clampedTarget),
      ];
      const next = recomputeY(reordered);
      setLanes(next);
      next.forEach((l, i) => {
        const oldIdx = curr.findIndex((c) => c.id === l.id);
        if (oldIdx !== i) markLane(l.id, { order_index: i });
      });
    },
    [markLane]
  );

  const moveLane = useCallback(
    (laneId: string, targetIdx: number) => {
      const curr = lanesRef.current;
      const oldIdx = curr.findIndex((l) => l.id === laneId);
      if (oldIdx === -1) return;
      // moveLaneLocal's targetIdx semantics: after removing the lane, insert
      // at target where target = targetIdx > oldIdx ? targetIdx - 1 : targetIdx.
      // Compute the final landing index from the inputs (lanesRef is stale
      // immediately after setLanes — can't read it back).
      const removedLen = curr.length - 1;
      const adjusted = targetIdx > oldIdx ? targetIdx - 1 : targetIdx;
      const newIdx = Math.max(0, Math.min(removedLen, adjusted));
      if (newIdx === oldIdx) return;
      moveLaneLocal(laneId, targetIdx);
      // To restore: lane is currently at newIdx, needs to reach oldIdx.
      //   moved-down (newIdx > oldIdx): pass oldIdx (no -1 adjustment).
      //   moved-up   (newIdx < oldIdx): pass oldIdx + 1 (target gets -1).
      const undoTargetIdx = newIdx > oldIdx ? oldIdx : oldIdx + 1;
      record({
        description: "Move lane",
        do: () => moveLaneLocal(laneId, targetIdx),
        undo: () => moveLaneLocal(laneId, undoTargetIdx),
      });
    },
    [moveLaneLocal, record]
  );

  const resizeLaneLocal = useCallback(
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

  const resizeLane = useCallback(
    (laneId: string, newH: number) => {
      const old = lanesRef.current.find((l) => l.id === laneId);
      if (!old) return;
      const oldH = old.h;
      const clamped = Math.max(MIN_LANE_HEIGHT, Math.round(newH));
      if (clamped === oldH) return;
      resizeLaneLocal(laneId, clamped);
      record({
        description: "Resize lane",
        do: () => resizeLaneLocal(laneId, clamped),
        undo: () => resizeLaneLocal(laneId, oldH),
      });
    },
    [resizeLaneLocal, record]
  );

  const renameLaneLocal = useCallback(
    (laneId: string, newName: string) => {
      setLanes((curr) =>
        curr.map((l) => (l.id === laneId ? { ...l, label: newName } : l))
      );
      markLane(laneId, { name: newName });
    },
    [markLane]
  );

  const renameLane = useCallback(
    (laneId: string, newName: string) => {
      const old = lanesRef.current.find((l) => l.id === laneId);
      if (!old || old.label === newName) return;
      const oldName = old.label;
      renameLaneLocal(laneId, newName);
      record({
        description: "Rename lane",
        do: () => renameLaneLocal(laneId, newName),
        undo: () => renameLaneLocal(laneId, oldName),
      });
    },
    [renameLaneLocal, record]
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
        onDragOver={onCanvasDragOver}
        onDrop={onCanvasDrop}
        style={{
          width: "100%",
          height: "100%",
          cursor:
            drag?.type === "pan"
              ? "grabbing"
              : tool === "connect"
                ? "crosshair"
                : "default",
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
          {drag?.type === "connect" &&
            (() => {
              const source = renderNodes.find((n) => n.id === drag.sourceId);
              if (!source) return null;
              const fx = source.x + source.w;
              const fy = source.y + source.h / 2;
              const tx = drag.currX;
              const ty = drag.currY;
              // Orthogonal L-shape — same routing rule the persisted edges
              // use, so the preview matches what you'll actually see.
              const midX = fx + (tx - fx) / 2;
              const d = `M ${fx} ${fy} L ${midX} ${fy} L ${midX} ${ty} L ${tx} ${ty}`;
              return (
                <path
                  d={d}
                  fill="none"
                  stroke="#0f172a"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  markerEnd="url(#poet-arrow)"
                  pointerEvents="none"
                />
              );
            })()}
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

      <ShapePalette />

      <FloatingToolbar
        tool={tool}
        onToolChange={setTool}
        viewport={viewport}
        onViewportChange={setViewport}
        onFit={fitToWorld}
        showIssues={showIssues}
        onShowIssuesChange={setShowIssues}
        reviewMode={reviewMode}
        onReviewModeChange={setReviewMode}
        issueCount={issueCount}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => void undo()}
        onRedo={() => void redo()}
      />
    </div>
  );
});
