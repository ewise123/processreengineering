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

import { toast } from "sonner";

import { api } from "@/lib/api";
import type { IssueSeverity, UUID } from "@/lib/types";

import { CanvasContextMenu, type ContextMenuItem } from "./canvas-context-menu";
import { FloatingToolbar, type CanvasTool } from "./floating-toolbar";
import { LaneRail } from "./lane-rail";
import { LANE_HEIGHT, LANE_PALETTE, nodeKindFromType } from "./layout";
import { sizeForNodeType } from "./node-type";
import { placeProposedStep } from "./ai-edit";
import { edgeFocusCenter } from "./edge-focus";
import { normalizeMarquee, nodesInMarquee, edgesInMarquee } from "./selection";
import {
  PALETTE_DRAG_MIME,
  PALETTE_SHAPES,
  ShapePalette,
} from "./shape-palette";
import {
  buildEdgePath,
  EdgeArrow,
  NodeShape,
  sidePoint,
  type ConnectSide,
  type EdgeOrientation,
} from "./shapes";
import type {
  CanvasEdge,
  CanvasLane,
  CanvasNode,
  CanvasNodeKind,
  ResolvedNode,
  Viewport,
} from "./types";
import { useClipboard } from "./use-clipboard";
import { useGraphPersistence, type SaveStatus } from "./use-persistence";
import { useUndoStack } from "./use-undo-stack";

const WORLD_WIDTH_MIN = 1700;
const WORLD_RIGHT_PADDING = 240;
const MIN_LANE_HEIGHT = 90;
const COLLAPSED_LANE_HEIGHT = 28;

const PASTE_OFFSET = 24;

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
const ZOOM_STEP = 1.2;

type Drag =
  | {
      type: "node";
      id: string; // the grabbed node
      offX: number;
      offY: number;
      members: Array<{
        id: string;
        origX: number;
        origAbsY: number;
        origRelativeY: number;
        origLaneId: UUID | null;
      }>;
    }
  | { type: "pan"; startX: number; startY: number; tx0: number; ty0: number }
  | {
      type: "connect";
      sourceId: UUID;
      sourceSide: ConnectSide;
      // Live cursor position in world coords for the temp line.
      currX: number;
      currY: number;
    }
  | {
      type: "edgeBend";
      edgeId: UUID;
      orientation: EdgeOrientation;
      // The persisted bend value before the drag started, so we can record
      // an undo entry that snaps back to it.
      origBend: number | null;
    }
  | {
      type: "marquee";
      startX: number; // world coords
      startY: number;
      currX: number;
      currY: number;
      additive: boolean; // Shift held at start → add to existing selection
    };

/** Orthogonal preview path from a node-side anchor toward an arbitrary
 * cursor point. The first segment extends perpendicular to the source side
 * so the preview clearly shows which side the connection will exit. */
function buildPreviewToCursor(
  source: { x: number; y: number; w: number; h: number },
  sourceSide: ConnectSide,
  cx: number,
  cy: number
): string {
  const start = sidePoint(source, sourceSide);
  const isHorizontal = sourceSide === "left" || sourceSide === "right";
  if (isHorizontal) {
    const midX = (start.x + cx) / 2;
    return `M ${start.x} ${start.y} L ${midX} ${start.y} L ${midX} ${cy} L ${cx} ${cy}`;
  }
  const midY = (start.y + cy) / 2;
  return `M ${start.x} ${start.y} L ${start.x} ${midY} L ${cx} ${midY} L ${cx} ${cy}`;
}

function laneAtY(y: number, lanes: CanvasLane[]): CanvasLane | undefined {
  if (lanes.length === 0) return undefined;
  if (y < lanes[0].y) return lanes[0];
  const last = lanes[lanes.length - 1];
  if (y >= last.y + last.h) return last;
  return lanes.find((l) => y >= l.y && y < l.y + l.h);
}

export type CanvasSelection =
  | { kind: "none" }
  | { kind: "node"; id: UUID; name?: string; nodeKind?: string; type?: string; laneId?: UUID | null; description?: string }
  | { kind: "edge"; id: UUID }
  | { kind: "multi"; nodeIds: UUID[]; edgeIds: UUID[] };

export interface BpmnCanvasHandle {
  /** Calls the API + removes the node (and any edges touching it) from
   * local state without re-fetching the whole graph. */
  deleteNode: (id: UUID) => Promise<void>;
  /** Apply a node-level edit (label, lane assignment, description) from
   * outside the canvas (e.g. the Properties panel). Records an undo entry. */
  updateNode: (
    id: UUID,
    patch: { name?: string; laneId?: UUID; type?: string; description?: string }
  ) => Promise<void>;
  /** Insert an AI-proposed downstream step (node + edge) via the apply
   * endpoint, select it, and record a replayable undo entry. */
  addProposedStep: (args: {
    sourceId: UUID;
    name: string;
    type: string;
    citedClaimIds: UUID[];
    edgeLabel?: string | null;
  }) => Promise<void>;
  /** Select a node (drives Properties panel + chat context) from outside
   * the canvas, e.g. clicking a node link in the Issues tab. */
  selectNode: (id: UUID) => void;
  /** Clear the current selection (used by the chat context tab's ✕). */
  clearSelection: () => void;
  /** Remove a single object id from the current selection (chat context ✕). */
  deselectId: (id: UUID) => void;
  /** Pan/zoom to an object by id, select it, and flash it briefly. Handles
   * both nodes and edges (used by chat mention links). */
  navigateTo: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  /** Delete every selected node and edge (node deletes are non-undoable). */
  deleteSelection: () => Promise<void>;
  /** Copy the current selection to the in-memory clipboard. */
  copySelection: () => void;
  /** Reassign every selected node to a lane (grouped undo). */
  moveSelectionToLane: (laneId: UUID) => void;
}

interface BpmnCanvasProps {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  initialNodes: CanvasNode[];
  initialEdges: CanvasEdge[];
  initialLanes: CanvasLane[];
  issuesByNode?: Record<string, IssueSeverity>;
  reviewByNode?: Record<string, "approved" | "changes_requested">;
  onSaveStatusChange?: (status: SaveStatus, error: string | null) => void;
  onSelectionChange?: (selected: CanvasSelection) => void;
  /** Fires after a node is removed (via panel Delete or keyboard). The page
   * uses this to invalidate dependent queries like issue badges. */
  onNodeDeleted?: (id: UUID) => void;
  onCountsChange?: (counts: { lanes: number; nodes: number; edges: number }) => void;
  /** Called when the user clicks the "Properties" pill on a selected node. */
  onOpenProperties?: () => void;
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
  reviewByNode,
  onSaveStatusChange,
  onSelectionChange,
  onNodeDeleted,
  onCountsChange,
  onOpenProperties,
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [showIssues, setShowIssues] = useState(true);
  const [reviewMode, setReviewMode] = useState(false);
  const [editingEdgeId, setEditingEdgeId] = useState<UUID | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);

  const issuesMap = issuesByNode ?? {};
  const issueCount = Object.keys(issuesMap).length;
  const reviewMap = reviewByNode ?? {};

  const { record, undo, redo, canUndo, canRedo } = useUndoStack();
  const clipboard = useClipboard();

  const selectOnly = useCallback((id: string) => setSelectedIds(new Set([id])), []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setSelection = useCallback((ids: string[], additive: boolean) => {
    setSelectedIds((curr) => {
      const next = additive ? new Set(curr) : new Set<string>();
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);
  const deselect = useCallback((id: string) => {
    setSelectedIds((curr) => {
      if (!curr.has(id)) return curr;
      const next = new Set(curr);
      next.delete(id);
      return next;
    });
  }, []);

  const deleteNodeImpl = useCallback(
    async (id: UUID) => {
      await api.deleteNode(projectId, id);
      setNodes((curr) => curr.filter((n) => n.id !== id));
      setEdges((curr) => curr.filter((e) => e.from !== id && e.to !== id));
      deselect(id);
      onNodeDeleted?.(id);
    },
    [projectId, onNodeDeleted, deselect]
  );

  const applyNodeEditLocal = useCallback(
    async (
      id: UUID,
      next: { name: string; laneId: UUID | null; relativeY: number; description?: string }
    ) => {
      setNodes((curr) =>
        curr.map((n) =>
          n.id === id
            ? {
                ...n,
                label: next.name,
                laneId: next.laneId,
                relativeY: next.relativeY,
                ...(next.description !== undefined ? { description: next.description } : {}),
              }
            : n
        )
      );
      await api.updateNode(projectId, id, {
        name: next.name,
        lane_id: next.laneId ?? undefined,
        relative_y: next.relativeY,
        ...(next.description !== undefined ? { description: next.description } : {}),
      });
    },
    [projectId]
  );

  const applyNodeTypeLocal = useCallback(
    async (id: UUID, newType: string) => {
      const kind = nodeKindFromType(newType);
      const size = sizeForNodeType(newType);
      setNodes((curr) =>
        curr.map((n) =>
          n.id === id
            ? { ...n, type: newType, kind, w: size.w, h: size.h }
            : n
        )
      );
      await api.updateNode(projectId, id, { type: newType });
    },
    [projectId]
  );

  const updateNodeImpl = useCallback(
    async (
      id: UUID,
      patch: { name?: string; laneId?: UUID; type?: string; description?: string }
    ) => {
      const old = nodesRef.current.find((n) => n.id === id);
      if (!old) return;
      if (patch.type !== undefined && patch.type !== old.type) {
        const newType = patch.type;
        const oldType = old.type;
        await applyNodeTypeLocal(id, newType);
        record({
          description: "Change node type",
          do: () => applyNodeTypeLocal(id, newType),
          undo: () => applyNodeTypeLocal(id, oldType),
        });
        return;
      }
      if (
        patch.description !== undefined &&
        patch.name === undefined &&
        patch.laneId === undefined
      ) {
        const oldDescription = old.description;
        const newDescription = patch.description;
        const base = { name: old.label, laneId: old.laneId, relativeY: old.relativeY };
        await applyNodeEditLocal(id, { ...base, description: newDescription });
        record({
          description: "Edit description",
          do: () => applyNodeEditLocal(id, { ...base, description: newDescription }),
          undo: () => applyNodeEditLocal(id, { ...base, description: oldDescription }),
        });
        return;
      }
      const oldName = old.label;
      const oldLaneId = old.laneId;
      const oldRelativeY = old.relativeY;
      const newName = patch.name !== undefined ? patch.name : oldName;
      const laneChanged =
        patch.laneId !== undefined && patch.laneId !== oldLaneId;
      const newLaneId = laneChanged ? patch.laneId! : oldLaneId;
      // When the user moves the node to a different lane via the dropdown,
      // anchor it at relativeY=0 of the new lane so it stays visible there.
      const newRelativeY = laneChanged ? 0 : oldRelativeY;
      if (newName === oldName && !laneChanged) return;
      const next = {
        name: newName,
        laneId: newLaneId,
        relativeY: newRelativeY,
      };
      const prev = {
        name: oldName,
        laneId: oldLaneId,
        relativeY: oldRelativeY,
      };
      await applyNodeEditLocal(id, next);
      record({
        description: laneChanged ? "Move node to lane" : "Rename node",
        do: () => applyNodeEditLocal(id, next),
        undo: () => applyNodeEditLocal(id, prev),
      });
    },
    [applyNodeEditLocal, applyNodeTypeLocal, record]
  );

  const addProposedStep = useCallback(
    async (args: {
      sourceId: UUID;
      name: string;
      type: string;
      citedClaimIds: UUID[];
      edgeLabel?: string | null;
    }) => {
      const source = nodesRef.current.find((n) => n.id === args.sourceId);
      if (!source) return;
      const lane = source.laneId;
      if (!lane) {
        toast.error("Can't place a step from a node with no lane.");
        return;
      }
      const pos = placeProposedStep({ x: source.x, relativeY: source.relativeY, w: source.w });
      try {
        const res = await api.applyProposedStep(projectId, modelId, versionId, {
          source_node_id: args.sourceId,
          name: args.name,
          type: args.type,
          lane_id: lane,
          x: pos.x,
          relative_y: pos.relativeY,
          edge_label: args.edgeLabel ?? null,
          cited_claim_ids: args.citedClaimIds,
        });
        const size = sizeForNodeType(res.node.type);
        const newNode: CanvasNode = {
          id: res.node.id,
          type: res.node.type,
          kind: nodeKindFromType(res.node.type),
          label: res.node.name,
          laneId: lane,
          x: pos.x,
          relativeY: pos.relativeY,
          w: size.w,
          h: size.h,
          aiProposed: true,
        };
        const newEdge: CanvasEdge = {
          id: res.edge.id,
          from: res.edge.source_node_id,
          to: res.edge.target_node_id,
          label: res.edge.label,
        };
        setNodes((curr) => [...curr, newNode]);
        setEdges((curr) => [...curr, newEdge]);
        selectOnly(newNode.id);
        // Replayable undo/redo. `undo` deletes via the API (local + edge
        // cascade); `redo` re-creates through the apply endpoint and refreshes
        // the captured ids (a fresh row each time) so a subsequent undo still
        // targets live rows rather than the deleted ones.
        let liveNode = newNode;
        let liveEdge = newEdge;
        const stepBody = {
          source_node_id: args.sourceId,
          name: args.name,
          type: args.type,
          lane_id: lane,
          x: pos.x,
          relative_y: pos.relativeY,
          edge_label: args.edgeLabel ?? null,
          cited_claim_ids: args.citedClaimIds,
        };
        record({
          description: "Add AI-proposed step",
          do: async () => {
            try {
              const again = await api.applyProposedStep(projectId, modelId, versionId, stepBody);
              liveNode = { ...newNode, id: again.node.id };
              liveEdge = {
                id: again.edge.id,
                from: again.edge.source_node_id,
                to: again.edge.target_node_id,
                label: again.edge.label,
              };
              setNodes((curr) => [...curr, liveNode]);
              setEdges((curr) => [...curr, liveEdge]);
              selectOnly(liveNode.id);
            } catch (err) {
              console.error("Failed to redo AI-proposed step", err);
              toast.error("Couldn't redo the suggested step — please try again.");
              throw err;
            }
          },
          undo: () => deleteNodeImpl(liveNode.id),
        });
      } catch (err) {
        console.error("Failed to apply proposed step", err);
        toast.error("Couldn't add the suggested step — please try again.");
      }
    },
    [projectId, modelId, versionId, record, deleteNodeImpl, selectOnly]
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
        deselect(rid);
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
    [projectId, modelId, versionId, record, deselect]
  );

  const deleteSelectionImpl = useCallback(async () => {
    const ids = [...selectedIdsRef.current];
    if (ids.length === 0) return;
    const nodeIds = ids.filter((id) => nodesRef.current.some((n) => n.id === id));
    const edgeIds = ids.filter((id) => edgesRef.current.some((e) => e.id === id));
    // Nodes first: deleteNodeImpl also strips their touching edges locally.
    for (const id of nodeIds) {
      await deleteNodeImpl(id);
    }
    // Then any still-present standalone edges (skip ones a node delete removed).
    for (const id of edgeIds) {
      if (edgesRef.current.some((e) => e.id === id)) {
        await deleteEdgeImpl(id);
      }
    }
  }, [deleteNodeImpl, deleteEdgeImpl]);

  const updateEdgeLabelLocal = useCallback(
    async (id: UUID, label: string | null) => {
      const updated = await api.updateEdge(projectId, id, { label });
      setEdges((curr) =>
        curr.map((e) =>
          e.id === id ? { ...e, label: updated.label ?? null } : e
        )
      );
    },
    [projectId]
  );

  const commitEdgeLabel = useCallback(
    async (id: UUID, raw: string) => {
      const trimmed = raw.trim();
      const newLabel = trimmed === "" ? null : trimmed;
      const existing = edgesRef.current.find((e) => e.id === id);
      if (!existing) return;
      const oldLabel = existing.label;
      if (oldLabel === newLabel) return;
      await updateEdgeLabelLocal(id, newLabel);
      record({
        description: "Edit edge label",
        do: () => updateEdgeLabelLocal(id, newLabel),
        undo: () => updateEdgeLabelLocal(id, oldLabel),
      });
    },
    [updateEdgeLabelLocal, record]
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
          deselect(currentId);
        },
      });
    },
    [projectId, modelId, versionId, record, deselect]
  );

  // Recenter the viewport on a node so it's actually visible after a remote
  // selection (e.g. clicking a node in the Issues tab).
  const focusNodeInViewport = useCallback((id: UUID) => {
    const node = nodesRef.current.find((n) => n.id === id);
    if (!node) return;
    const lane = displayLanesRef.current.find((l) => l.id === node.laneId);
    const nodeAbsY = lane ? lane.y + node.relativeY : node.relativeY;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const v = viewportRef.current;
    const cx = node.x + node.w / 2;
    const cy = nodeAbsY + node.h / 2;
    setViewport({
      scale: v.scale,
      tx: rect.width / 2 - cx * v.scale,
      ty: rect.height / 2 - cy * v.scale,
    });
  }, []);

  const [flashId, setFlashId] = useState<UUID | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((id: UUID) => {
    setFlashId(id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId(null), 1400);
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const focusEdgeInViewport = useCallback((id: UUID) => {
    const edge = edgesRef.current.find((e) => e.id === id);
    if (!edge) return;
    const center = edgeFocusCenter(
      { from: edge.from, to: edge.to },
      nodesRef.current,
      displayLanesRef.current
    );
    const svg = svgRef.current;
    if (!center || !svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const v = viewportRef.current;
    setViewport({
      scale: v.scale,
      tx: rect.width / 2 - center.cx * v.scale,
      ty: rect.height / 2 - center.cy * v.scale,
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      deleteNode: deleteNodeImpl,
      updateNode: updateNodeImpl,
      addProposedStep,
      selectNode: (id) => {
        setSelectedIds(new Set([id]));
        focusNodeInViewport(id);
      },
      clearSelection,
      deselectId: (id) =>
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      navigateTo: (refTarget) => {
        setSelectedIds(new Set([refTarget.id]));
        if (refTarget.kind === "edge") focusEdgeInViewport(refTarget.id);
        else focusNodeInViewport(refTarget.id);
        flash(refTarget.id);
      },
      deleteSelection: deleteSelectionImpl,
      copySelection: copySelectionImpl,
      moveSelectionToLane: moveSelectionToLaneImpl,
    }),
    [deleteNodeImpl, updateNodeImpl, addProposedStep, focusNodeInViewport, focusEdgeInViewport, flash, clearSelection, deleteSelectionImpl]
  );

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

      if (e.code === "Space") {
        e.preventDefault(); // stop the page from scrolling
        spaceHeld.current = true;
        return;
      }

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
      if (mod && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        copySelectionImpl();
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        void pasteClipboardImpl();
        return;
      }

      if (!mod) {
        if (e.key === "v" || e.key === "V") { setTool("select"); return; }
        if (e.key === "h" || e.key === "H") { setTool("pan"); return; }
        if (e.key === "c" || e.key === "C") { setTool("connect"); return; }
        if (e.key === "Escape") {
          if (contextMenuRef.current) {
            setContextMenu(null);
            return;
          }
          setTool("select");
          clearSelection();
          return;
        }
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedIdsRef.current.size === 0) return;
        e.preventDefault();
        void deleteSelectionImpl();
      }
    };
    const upHandler = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceHeld.current = false;
    };
    document.addEventListener("keydown", handler);
    document.addEventListener("keyup", upHandler);
    return () => {
      document.removeEventListener("keydown", handler);
      document.removeEventListener("keyup", upHandler);
    };
  }, [deleteSelectionImpl, undo, redo, clearSelection]);

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const spaceHeld = useRef(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const contextMenuRef = useRef(contextMenu);
  contextMenuRef.current = contextMenu;

  const { status, error, markNode, markLane, flush } = useGraphPersistence({
    projectId,
  });

  // Lane collapse is view state, seeded from each lane's persisted `collapsed`
  // flag and persisted back via markLane on toggle. Kept out of the undo stack.
  const [collapsedLaneIds, setCollapsedLaneIds] = useState<Set<string>>(
    () => new Set(initialLanes.filter((l) => l.collapsed).map((l) => l.id))
  );
  const collapsedLaneIdsRef = useRef(collapsedLaneIds);
  collapsedLaneIdsRef.current = collapsedLaneIds;

  const toggleLaneCollapse = useCallback(
    (laneId: string) => {
      const willCollapse = !collapsedLaneIdsRef.current.has(laneId);
      setCollapsedLaneIds((curr) => {
        const next = new Set(curr);
        if (willCollapse) next.add(laneId);
        else next.delete(laneId);
        return next;
      });
      markLane(laneId, { collapsed: willCollapse });
    },
    [markLane]
  );

  // Notify parent of save state transitions for UI indicator.
  useEffect(() => {
    onSaveStatusChange?.(status, error);
  }, [status, error, onSaveStatusChange]);

  // Notify parent of selection so it can drive side panels.
  useEffect(() => {
    if (!onSelectionChange) return;
    const ids = [...selectedIds];
    if (ids.length === 0) {
      onSelectionChange({ kind: "none" });
      return;
    }
    if (ids.length === 1) {
      const id = ids[0];
      const node = nodesRef.current.find((n) => n.id === id);
      if (node) {
        onSelectionChange({
          kind: "node",
          id,
          name: node.label,
          nodeKind: node.kind,
          type: node.type,
          laneId: node.laneId,
          description: node.description,
        });
      } else {
        onSelectionChange({ kind: "edge", id });
      }
      return;
    }
    const nodeIds = ids.filter((id) => nodesRef.current.some((n) => n.id === id));
    const edgeIds = ids.filter((id) => edgesRef.current.some((e) => e.id === id));
    onSelectionChange({ kind: "multi", nodeIds, edgeIds });
  }, [selectedIds, onSelectionChange]);

  useEffect(() => {
    onCountsChange?.({
      lanes: lanes.length,
      nodes: nodes.length,
      edges: edges.length,
    });
  }, [lanes.length, nodes.length, edges.length, onCountsChange]);

  const worldWidth = useMemo(() => {
    const maxX = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0);
    return Math.max(WORLD_WIDTH_MIN, maxX + WORLD_RIGHT_PADDING);
  }, [nodes]);

  // Lane geometry as shown on screen: collapsed lanes shrink to a thin strip.
  // The real `lanes` (true heights) are kept for persistence; only display
  // geometry changes, so expanding restores the stored height.
  const displayLanes = useMemo(() => {
    let y = 0;
    return lanes.map((l) => {
      const h = collapsedLaneIds.has(l.id) ? COLLAPSED_LANE_HEIGHT : l.h;
      const out = { ...l, y, h };
      y += h;
      return out;
    });
  }, [lanes, collapsedLaneIds]);

  const displayLanesRef = useRef(displayLanes);
  displayLanesRef.current = displayLanes;

  const worldHeight = useMemo(() => {
    const maxBottom = displayLanes.reduce((m, l) => Math.max(m, l.y + l.h), 0);
    return Math.max(620, maxBottom);
  }, [displayLanes]);

  const renderNodes: ResolvedNode[] = useMemo(() => {
    const laneMap = new Map(displayLanes.map((l) => [l.id, l]));
    return nodes
      .filter((n) => !(n.laneId && collapsedLaneIds.has(n.laneId)))
      .map((n) => {
        const lane = n.laneId ? laneMap.get(n.laneId) : undefined;
        const y = lane ? lane.y + n.relativeY : n.relativeY;
        const { relativeY: _ignore, ...rest } = n;
        void _ignore;
        return { ...rest, y };
      });
  }, [nodes, displayLanes, collapsedLaneIds]);

  const renderNodesRef = useRef(renderNodes);
  renderNodesRef.current = renderNodes;

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
        const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * (1 + delta)));
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
    if (e.button === 1 || spaceHeld.current) {
      e.preventDefault();
      setDrag({
        type: "pan",
        startX: e.clientX,
        startY: e.clientY,
        tx0: viewportRef.current.tx,
        ty0: viewportRef.current.ty,
      });
      return;
    }
    if (e.button !== 0) return;
    setContextMenu(null);
    e.stopPropagation();
    if (tool === "pan") {
      // Hand mode: dragging a node pans the canvas instead of moving it.
      setDrag({
        type: "pan",
        startX: e.clientX,
        startY: e.clientY,
        tx0: viewportRef.current.tx,
        ty0: viewportRef.current.ty,
      });
      return;
    }
    if (tool === "select" && e.shiftKey) {
      // Shift-click (Select tool) toggles this node in the selection without
      // starting a drag. In Connect mode, fall through so body-drag still connects.
      toggleSelection(id);
      return;
    }
    const isGroupDrag =
      selectedIdsRef.current.has(id) && selectedIdsRef.current.size > 1;
    // Defer selection change for a node that's already part of a multi-selection:
    // a drag moves the whole group (kept selected), a click collapses it on mouseup.
    if (!isGroupDrag) selectOnly(id);
    const resolved = renderNodes.find((n) => n.id === id);
    const stored = nodesRef.current.find((n) => n.id === id);
    if (!resolved || !stored) return;
    const { x, y } = toWorld(e.clientX, e.clientY);
    if (tool === "connect") {
      // Body-drag in connect mode picks the source side from where the user
      // grabbed: closest of top/right/bottom/left to the click point.
      const cx = resolved.x + resolved.w / 2;
      const cy = resolved.y + resolved.h / 2;
      const dx = x - cx;
      const dy = y - cy;
      const side: ConnectSide =
        Math.abs(dx) > Math.abs(dy)
          ? dx >= 0
            ? "right"
            : "left"
          : dy >= 0
            ? "bottom"
            : "top";
      setDrag({ type: "connect", sourceId: id, sourceSide: side, currX: x, currY: y });
      return;
    }
    const groupIds = isGroupDrag
      ? [...selectedIdsRef.current].filter((sid) => {
          const n = nodesRef.current.find((nn) => nn.id === sid);
          return !!n && !(n.laneId && collapsedLaneIds.has(n.laneId));
        })
      : [id];
    const laneById = new Map(displayLanesRef.current.map((l) => [l.id, l]));
    const members = groupIds
      .map((sid) => {
        const sn = nodesRef.current.find((n) => n.id === sid);
        if (!sn) return null;
        const lane = sn.laneId ? laneById.get(sn.laneId) : undefined;
        const origAbsY = (lane ? lane.y : 0) + sn.relativeY;
        return {
          id: sid,
          origX: sn.x,
          origAbsY,
          origRelativeY: sn.relativeY,
          origLaneId: sn.laneId,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    setDrag({ type: "node", id, offX: x - resolved.x, offY: y - resolved.y, members });
  };

  const onStartBendDrag = useCallback(
    (e: MouseEvent, edgeId: UUID, orientation: EdgeOrientation) => {
      e.stopPropagation();
      const edge = edgesRef.current.find((ed) => ed.id === edgeId);
      if (!edge) return;
      const origBend =
        orientation === "horizontal"
          ? edge.bendX ?? null
          : edge.bendY ?? null;
      setDrag({ type: "edgeBend", edgeId, orientation, origBend });
    },
    []
  );

  const applyEdgeBendLocal = useCallback(
    async (
      id: UUID,
      orientation: EdgeOrientation,
      value: number | null
    ) => {
      setEdges((curr) =>
        curr.map((e) =>
          e.id === id
            ? {
                ...e,
                ...(orientation === "horizontal"
                  ? { bendX: value }
                  : { bendY: value }),
              }
            : e
        )
      );
      await api.updateEdge(
        projectId,
        id,
        orientation === "horizontal"
          ? { bend_x: value }
          : { bend_y: value }
      );
    },
    [projectId]
  );

  const onStartConnect = useCallback(
    (e: MouseEvent, sourceId: UUID, side: ConnectSide) => {
      e.stopPropagation();
      selectOnly(sourceId);
      const { x, y } = toWorld(e.clientX, e.clientY);
      setDrag({ type: "connect", sourceId, sourceSide: side, currX: x, currY: y });
    },
    [toWorld, selectOnly]
  );

  const onSvgMouseDown = (e: MouseEvent<SVGSVGElement>) => {
    if (e.button === 1 || spaceHeld.current) {
      e.preventDefault();
      setDrag({
        type: "pan",
        startX: e.clientX,
        startY: e.clientY,
        tx0: viewportRef.current.tx,
        ty0: viewportRef.current.ty,
      });
      return;
    }
    if (e.button !== 0) return;
    setContextMenu(null);
    const target = e.target as SVGElement;
    const isBg =
      target === svgRef.current ||
      (target.tagName === "rect" && target.getAttribute("data-bg") === "1");
    if (!isBg) return;
    if (tool === "pan") {
      setDrag({
        type: "pan",
        startX: e.clientX,
        startY: e.clientY,
        tx0: viewport.tx,
        ty0: viewport.ty,
      });
      return;
    }
    // Select tool: start a marquee. A non-moving marquee clears selection on up.
    const { x, y } = toWorld(e.clientX, e.clientY);
    setDrag({ type: "marquee", startX: x, startY: y, currX: x, currY: y, additive: e.shiftKey });
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
      if (drag.type === "marquee") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        setDrag({ ...drag, currX: x, currY: y });
        return;
      }
      if (drag.type === "connect") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        setDrag({ ...drag, currX: x, currY: y });
        return;
      }
      if (drag.type === "edgeBend") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        const value = drag.orientation === "horizontal" ? x : y;
        setEdges((curr) =>
          curr.map((ed) =>
            ed.id === drag.edgeId
              ? {
                  ...ed,
                  ...(drag.orientation === "horizontal"
                    ? { bendX: value }
                    : { bendY: value }),
                }
              : ed
          )
        );
        return;
      }
      if (drag.type === "node") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        const grabbed = drag.members.find((m) => m.id === drag.id);
        if (!grabbed) return;
        const deltaX = x - drag.offX - grabbed.origX;
        const deltaY = y - drag.offY - grabbed.origAbsY;
        const currLanes = displayLanesRef.current;
        setNodes((curr) =>
          curr.map((n) => {
            const m = drag.members.find((mm) => mm.id === n.id);
            if (!m) return n;
            const newX = m.origX + deltaX;
            const targetAbsY = m.origAbsY + deltaY;
            const targetLane =
              laneAtY(targetAbsY + n.h / 2, currLanes) ??
              (n.laneId
                ? currLanes.find((l) => l.id === n.laneId)
                : currLanes[0]);
            // Never re-lane into a collapsed (hidden) lane: maxRel would be 0,
            // stranding the node in the 28px strip and clobbering its real
            // relativeY. (Real lanes are >= MIN_LANE_HEIGHT (90); only a
            // collapsed display-lane has h === COLLAPSED_LANE_HEIGHT.) Keep the
            // node's current lane/relativeY; only x changes.
            if (!targetLane || targetLane.h === COLLAPSED_LANE_HEIGHT) {
              return { ...n, x: newX };
            }
            const maxRel = Math.max(0, targetLane.h - n.h);
            const rel = Math.max(0, Math.min(maxRel, targetAbsY - targetLane.y));
            return { ...n, x: newX, laneId: targetLane.id, relativeY: rel };
          })
        );
        return;
      }
      if (drag.type === "pan") {
        const v = viewportRef.current;
        setViewport({
          ...v,
          tx: drag.tx0 + (e.clientX - drag.startX),
          ty: drag.ty0 + (e.clientY - drag.startY),
        });
      }
    };

    const onUp = (e: globalThis.MouseEvent) => {
      if (drag.type === "edgeBend") {
        const final = edgesRef.current.find((ed) => ed.id === drag.edgeId);
        if (final) {
          const finalValue =
            drag.orientation === "horizontal"
              ? final.bendX ?? null
              : final.bendY ?? null;
          if (finalValue !== drag.origBend) {
            // Persist the new bend, plus record the inverse for undo.
            void api
              .updateEdge(
                projectId,
                drag.edgeId,
                drag.orientation === "horizontal"
                  ? { bend_x: finalValue }
                  : { bend_y: finalValue }
              )
              .catch((err) => {
                console.error("Failed to save edge bend", err);
                toast.error("Couldn't save the connection shape.");
              });
            const edgeId = drag.edgeId;
            const orientation = drag.orientation;
            const origBend = drag.origBend;
            record({
              description: "Move edge segment",
              do: () => applyEdgeBendLocal(edgeId, orientation, finalValue),
              undo: () => applyEdgeBendLocal(edgeId, orientation, origBend),
            });
          }
        }
        setDrag(null);
        return;
      }
      if (drag.type === "connect") {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        const target = nodesRef.current.find((n) => {
          // Resolve node Y the same way renderNodes does.
          const lane = n.laneId
            ? displayLanesRef.current.find((l) => l.id === n.laneId)
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
            void createEdgeImpl(sourceId, targetId).catch((err) => {
              console.error("Failed to create edge", err);
              toast.error("Couldn't connect those steps — please try again.");
            });
          }
        }
        setDrag(null);
        return;
      }
      if (drag.type === "node") {
        const finals = drag.members
          .map((m) => nodesRef.current.find((n) => n.id === m.id))
          .filter((n): n is NonNullable<typeof n> => !!n);
        for (const f of finals) {
          markNode(f.id, {
            x: f.x,
            relative_y: f.relativeY,
            lane_id: f.laneId ?? undefined,
          });
        }
        const moved = drag.members.some((m) => {
          const f = finals.find((n) => n.id === m.id);
          return (
            f &&
            (f.x !== m.origX ||
              f.relativeY !== m.origRelativeY ||
              f.laneId !== m.origLaneId)
          );
        });
        if (moved) {
          const newPositions = finals.map((f) => ({
            id: f.id,
            x: f.x,
            relativeY: f.relativeY,
            laneId: f.laneId,
          }));
          const oldPositions = drag.members.map((m) => ({
            id: m.id,
            x: m.origX,
            relativeY: m.origRelativeY,
            laneId: m.origLaneId,
          }));
          record({
            description: finals.length > 1 ? `Move ${finals.length} nodes` : "Move node",
            do: () => applyGroupPositionsLocal(newPositions),
            undo: () => applyGroupPositionsLocal(oldPositions),
          });
        }
        // A plain click (no drag) on a member of a multi-selection collapses the
        // selection to just that node; a real group drag leaves the group selected.
        if (!moved && drag.members.length > 1) {
          selectOnly(drag.id);
        }
      }
      if (drag.type === "pan") {
        // Distinguish a true background click (deselect) from a pan-drag
        // (preserve selection so the Properties panel stays put while
        // panning). 4px threshold is the usual click-vs-drag cutoff.
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (dx * dx + dy * dy < 16) {
          clearSelection();
        }
      }
      if (drag.type === "marquee") {
        const rect = normalizeMarquee(drag.startX, drag.startY, drag.currX, drag.currY);
        const moved = rect.w * rect.w + rect.h * rect.h > 16; // >4 world units (≈4px at 1.0 zoom)
        if (!moved) {
          if (!drag.additive) clearSelection();
        } else {
          const positioned = renderNodesRef.current.map((n) => ({
            id: n.id,
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
          }));
          const hitNodes = nodesInMarquee(positioned, rect);
          const hitEdges = edgesInMarquee(
            edgesRef.current.map((e) => ({ id: e.id, from: e.from, to: e.to })),
            hitNodes
          );
          setSelection([...hitNodes, ...hitEdges], drag.additive);
        }
        setDrag(null);
        return;
      }
      setDrag(null);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [drag, markNode, record, createEdgeImpl, projectId, applyEdgeBendLocal, clearSelection, setSelection, selectOnly]);

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
    const currLanes = displayLanesRef.current;
    const targetLane =
      laneAtY(dropCenterY + shape.h / 2, currLanes) ?? currLanes[0];
    if (!targetLane || collapsedLaneIds.has(targetLane.id)) return;
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
        type: shape.backendType,
        kind: shape.kind,
        label: created.name,
        laneId: targetLane.id,
        x: dropCenterX,
        relativeY: rel,
        w: shape.w,
        h: shape.h,
      };
      setNodes((curr) => [...curr, newNode]);
      selectOnly(newNode.id);
    } catch (err) {
      console.error("Failed to create node from palette", err);
      toast.error("Couldn't add that shape — please try again.");
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
      MIN_SCALE,
      Math.min(MAX_SCALE, Math.min(usableW / worldWidth, usableH / worldHeight))
    );
    setViewport({
      scale,
      tx: (rect.width - worldWidth * scale) / 2,
      ty: (rect.height - worldHeight * scale) / 2,
    });
  }, [worldWidth, worldHeight]);

  // Zoom toward the viewport center, mirroring the wheel handler's anchor math
  // so the +/- buttons keep content centered instead of drifting to the origin.
  const zoomByStep = useCallback((factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const v = viewportRef.current;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const wx = (cx - v.tx) / v.scale;
    const wy = (cy - v.ty) / v.scale;
    setViewport({ scale: newScale, tx: cx - wx * newScale, ty: cy - wy * newScale });
  }, []);

  // Low-level mutator used by undo/redo callbacks for node moves. Bypasses
  // record() so undo replay does not pollute the history stack.
  const applyGroupPositionsLocal = useCallback(
    (positions: Array<{ id: UUID; x: number; relativeY: number; laneId: UUID | null }>) => {
      const byId = new Map(positions.map((p) => [p.id, p]));
      setNodes((curr) =>
        curr.map((n) => {
          const p = byId.get(n.id);
          return p ? { ...n, x: p.x, relativeY: p.relativeY, laneId: p.laneId } : n;
        })
      );
      for (const p of positions) {
        markNode(p.id, { x: p.x, relative_y: p.relativeY, lane_id: p.laneId ?? undefined });
      }
    },
    [markNode]
  );

  const moveSelectionToLaneImpl = useCallback(
    (laneId: UUID) => {
      const ids = [...selectedIdsRef.current].filter((id) =>
        nodesRef.current.some((n) => n.id === id)
      );
      if (ids.length === 0) return;
      const oldPositions = ids.map((id) => {
        const n = nodesRef.current.find((nn) => nn.id === id)!;
        return { id, x: n.x, relativeY: n.relativeY, laneId: n.laneId };
      });
      const newPositions = oldPositions.map((p) => ({ ...p, relativeY: 0, laneId }));
      applyGroupPositionsLocal(newPositions);
      record({
        description: `Move ${ids.length} to lane`,
        do: () => applyGroupPositionsLocal(newPositions),
        undo: () => applyGroupPositionsLocal(oldPositions),
      });
    },
    [applyGroupPositionsLocal, record]
  );

  const copySelectionImpl = useCallback(() => {
    const ids = new Set(
      [...selectedIdsRef.current].filter((id) =>
        nodesRef.current.some((n) => n.id === id)
      )
    );
    if (ids.size === 0) return;
    const nodes = nodesRef.current
      .filter((n) => ids.has(n.id))
      .map((n) => ({
        oldId: n.id,
        type: n.type,
        kind: n.kind,
        label: n.label,
        laneId: n.laneId,
        x: n.x,
        relativeY: n.relativeY,
        w: n.w,
        h: n.h,
      }));
    const edges = edgesRef.current
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ fromOldId: e.from, toOldId: e.to, label: e.label }));
    clipboard.copy({ nodes, edges });
  }, [clipboard]);

  const pasteClipboardImpl = useCallback(async () => {
    const snap = clipboard.get();
    if (!snap || snap.nodes.length === 0) return;
    const fallbackLane = lanesRef.current[0];
    // Resolve target specs ONCE (offset positions, resolved/persistable lanes).
    const nodeSpecs = snap.nodes
      .map((cn) => {
        const laneId =
          (cn.laneId && lanesRef.current.some((l) => l.id === cn.laneId)
            ? cn.laneId
            : fallbackLane?.id) ?? null;
        if (!laneId) return null;
        return {
          oldId: cn.oldId,
          type: cn.type,
          kind: cn.kind,
          label: cn.label,
          laneId,
          x: cn.x + PASTE_OFFSET,
          relativeY: cn.relativeY + PASTE_OFFSET,
          w: cn.w,
          h: cn.h,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    if (nodeSpecs.length === 0) return;
    const edgeSpecs = snap.edges;

    // Ids of the currently-materialized paste; updated on each (re)create so
    // undo always deletes the live set and redo recreates fresh ones.
    let currentNodeIds: UUID[] = [];
    let currentEdgeIds: UUID[] = [];

    const materialize = async () => {
      const idMap = new Map<UUID, UUID>();
      const createdNodes: CanvasNode[] = [];
      const createdEdgeIds: UUID[] = [];
      for (const ns of nodeSpecs) {
        const created = await api.createNode(projectId, modelId, versionId, {
          type: ns.type,
          name: ns.label,
          lane_id: ns.laneId,
          x: ns.x,
          relative_y: ns.relativeY,
        });
        idMap.set(ns.oldId, created.id);
        createdNodes.push({
          id: created.id,
          type: ns.type,
          kind: ns.kind,
          label: created.name,
          laneId: ns.laneId,
          x: ns.x,
          relativeY: ns.relativeY,
          w: ns.w,
          h: ns.h,
        });
      }
      setNodes((curr) => [...curr, ...createdNodes]);
      for (const es of edgeSpecs) {
        const from = idMap.get(es.fromOldId);
        const to = idMap.get(es.toOldId);
        if (!from || !to) continue;
        const created = await api.createEdge(projectId, modelId, versionId, {
          source_node_id: from,
          target_node_id: to,
          label: es.label ?? undefined,
        });
        createdEdgeIds.push(created.id);
        setEdges((curr) => [
          ...curr,
          { id: created.id, from, to, label: created.label ?? null },
        ]);
      }
      currentNodeIds = createdNodes.map((n) => n.id);
      currentEdgeIds = createdEdgeIds;
      setSelectedIds(new Set(currentNodeIds));
    };

    const remove = async () => {
      const nodeIds = currentNodeIds;
      const edgeIds = currentEdgeIds;
      for (const id of edgeIds) await api.deleteEdge(projectId, id).catch(() => {});
      for (const id of nodeIds) await api.deleteNode(projectId, id).catch(() => {});
      setEdges((curr) => curr.filter((e) => !edgeIds.includes(e.id)));
      setNodes((curr) => curr.filter((n) => !nodeIds.includes(n.id)));
      setSelectedIds(new Set());
    };

    try {
      await materialize();
      record({
        description: `Paste ${currentNodeIds.length} item${currentNodeIds.length > 1 ? "s" : ""}`,
        do: materialize,
        undo: remove,
      });
    } catch (err) {
      console.error("Failed to paste", err);
      toast.error("Couldn't paste — please try again.");
    }
  }, [clipboard, projectId, modelId, versionId, record]);

  const openNodeMenu = useCallback(
    (e: MouseEvent, nodeId: UUID) => {
      e.preventDefault();
      e.stopPropagation();
      const wasSelected = selectedIdsRef.current.has(nodeId);
      if (!wasSelected) selectOnly(nodeId);
      // When the node wasn't already selected we just collapsed to it (size 1);
      // otherwise the ref accurately reflects the current multi-selection.
      const count = wasSelected ? selectedIdsRef.current.size : 1;
      const suffix = count > 1 ? ` ${count}` : "";
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          ...(count <= 1 && onOpenProperties
            ? [{ label: "Properties", onSelect: () => onOpenProperties() }]
            : []),
          { label: `Copy${suffix}`, onSelect: copySelectionImpl },
          {
            label: "Duplicate",
            onSelect: () => {
              copySelectionImpl();
              void pasteClipboardImpl();
            },
          },
          { label: `Delete${suffix}`, onSelect: () => void deleteSelectionImpl() },
        ],
      });
    },
    [selectOnly, copySelectionImpl, pasteClipboardImpl, deleteSelectionImpl, onOpenProperties]
  );

  const openEdgeMenu = useCallback(
    (e: MouseEvent, edgeId: UUID) => {
      e.preventDefault();
      e.stopPropagation();
      selectOnly(edgeId);
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Edit label", onSelect: () => setEditingEdgeId(edgeId) },
          { label: "Delete", onSelect: () => void deleteEdgeImpl(edgeId) },
        ],
      });
    },
    [selectOnly, deleteEdgeImpl]
  );

  const openCanvasMenu = useCallback(
    (e: MouseEvent<SVGSVGElement>) => {
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: "Paste",
            disabled: !clipboard.hasContent(),
            onSelect: () => void pasteClipboardImpl(),
          },
          {
            label: "Select all",
            onSelect: () =>
              setSelectedIds(new Set(renderNodesRef.current.map((n) => n.id))),
          },
          { label: "Fit to screen", onSelect: fitToWorld },
        ],
      });
    },
    [clipboard, pasteClipboardImpl, fitToWorld]
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

  const setLaneColorLocal = useCallback(
    (laneId: string, color: string) => {
      setLanes((curr) =>
        curr.map((l) => (l.id === laneId ? { ...l, color } : l))
      );
      markLane(laneId, { color });
    },
    [markLane]
  );

  const setLaneColor = useCallback(
    (laneId: string, color: string) => {
      const old = lanesRef.current.find((l) => l.id === laneId);
      if (!old || old.color === color) return;
      const oldColor = old.color;
      setLaneColorLocal(laneId, color);
      record({
        description: "Set lane color",
        do: () => setLaneColorLocal(laneId, color),
        undo: () => setLaneColorLocal(laneId, oldColor),
      });
    },
    [setLaneColorLocal, record]
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
          collapsed: false,
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
        toast.error("Couldn't add the lane — please try again.");
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
        // Drop the deleted lane from the collapse set so the (now persisted)
        // set doesn't accumulate orphaned IDs over a long session.
        setCollapsedLaneIds((curr) => {
          if (!curr.has(laneId)) return curr;
          const next = new Set(curr);
          next.delete(laneId);
          return next;
        });
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
        toast.error("Couldn't delete the lane — please try again.");
      }
    },
    [projectId, flush]
  );

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <svg
        ref={svgRef}
        onMouseDown={onSvgMouseDown}
        onContextMenu={openCanvasMenu}
        onDragOver={onCanvasDragOver}
        onDrop={onCanvasDrop}
        style={{
          width: "100%",
          height: "100%",
          cursor:
            drag?.type === "pan"
              ? "grabbing"
              : tool === "pan"
                ? "grab"
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
          {displayLanes.map((lane) => (
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
          {edges
            .filter((edge) => {
              const f = nodes.find((n) => n.id === edge.from);
              const t = nodes.find((n) => n.id === edge.to);
              const hidden = (n?: CanvasNode) =>
                !!n?.laneId && collapsedLaneIds.has(n.laneId);
              return !hidden(f) && !hidden(t);
            })
            .map((edge) => (
              <EdgeArrow
                key={edge.id}
                edge={edge}
                nodes={renderNodes}
                selected={selectedIds.has(edge.id)}
                onClick={(id) => selectOnly(id)}
                onDoubleClick={(id) => {
                  selectOnly(id);
                  setEditingEdgeId(id);
                }}
                onContextMenu={openEdgeMenu}
                onStartBendDrag={onStartBendDrag}
              />
            ))}
          {renderNodes.map((node) => (
            <NodeShape
              key={node.id}
              node={node}
              selected={selectedIds.has(node.id)}
              issueLevel={showIssues ? issuesMap[node.id] ?? null : null}
              reviewBadge={reviewMode ? reviewMap[node.id] ?? null : null}
              showHandles={tool === "connect"}
              onMouseDown={onNodeMouseDown}
              onContextMenu={openNodeMenu}
              onStartConnect={onStartConnect}
            />
          ))}
          {flashId && (() => {
            const fn = renderNodes.find((n) => n.id === flashId);
            if (!fn) return null;
            return (
              <rect
                x={fn.x - 4}
                y={fn.y - 4}
                width={fn.w + 8}
                height={fn.h + 8}
                rx={8}
                fill="none"
                stroke="#6366f1"
                strokeWidth={3}
                className="pointer-events-none"
              >
                <animate attributeName="opacity" values="1;0.2;1" dur="0.7s" repeatCount="2" />
              </rect>
            );
          })()}
          {editingEdgeId &&
            (() => {
              const edge = edges.find((e) => e.id === editingEdgeId);
              if (!edge) return null;
              const from = renderNodes.find((n) => n.id === edge.from);
              const to = renderNodes.find((n) => n.id === edge.to);
              if (!from || !to) return null;
              const { midX, midY } = buildEdgePath(from, to);
              return (
                <EdgeLabelEditor
                  x={midX}
                  y={midY}
                  initial={edge.label ?? ""}
                  onCommit={(value) => {
                    setEditingEdgeId(null);
                    void commitEdgeLabel(edge.id, value);
                  }}
                  onCancel={() => setEditingEdgeId(null)}
                />
              );
            })()}
          {drag?.type === "connect" &&
            (() => {
              const source = renderNodes.find((n) => n.id === drag.sourceId);
              if (!source) return null;
              // If the cursor is over a target node, preview the final
              // edge using node-to-node routing so the user can see exactly
              // what they'll get. Otherwise fall back to source-side → cursor.
              const target = renderNodes.find(
                (n) =>
                  n.id !== drag.sourceId &&
                  drag.currX >= n.x &&
                  drag.currX <= n.x + n.w &&
                  drag.currY >= n.y &&
                  drag.currY <= n.y + n.h
              );
              const d = target
                ? buildEdgePath(source, target).d
                : buildPreviewToCursor(source, drag.sourceSide, drag.currX, drag.currY);
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
          {drag?.type === "marquee" &&
            (() => {
              const r = normalizeMarquee(drag.startX, drag.startY, drag.currX, drag.currY);
              return (
                <rect
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  fill="rgba(37,99,235,0.08)"
                  stroke="#2563eb"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  pointerEvents="none"
                />
              );
            })()}
        </g>
      </svg>

      <LaneRail
        lanes={displayLanes}
        viewport={viewport}
        onMoveLane={moveLane}
        onResizeLane={resizeLane}
        onRenameLane={renameLane}
        onAddLaneAt={addLaneAt}
        onDeleteLane={deleteLane}
        onSetColor={setLaneColor}
        collapsedLaneIds={collapsedLaneIds}
        onToggleCollapse={toggleLaneCollapse}
      />

      <ShapePalette />

      {/* end SVG */}
      <FloatingToolbar
        tool={tool}
        onToolChange={setTool}
        viewport={viewport}
        onZoomIn={() => zoomByStep(ZOOM_STEP)}
        onZoomOut={() => zoomByStep(1 / ZOOM_STEP)}
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

      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
});

function EdgeLabelEditor({
  x,
  y,
  initial,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const W = 120;
  const H = 24;
  return (
    <foreignObject x={x - W / 2} y={y - H / 2} width={W} height={H}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          // Don't let Cmd+Z bubble to the canvas-level shortcut.
          e.stopPropagation();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        placeholder="label…"
        style={{
          width: "100%",
          height: "100%",
          padding: "0 6px",
          fontSize: 11,
          fontFamily: "inherit",
          textAlign: "center",
          background: "#fff",
          border: "1.5px solid #0f172a",
          borderRadius: 4,
          color: "#0f172a",
          outline: "none",
          boxShadow: "0 2px 6px rgba(15,23,42,0.18)",
        }}
      />
    </foreignObject>
  );
}
