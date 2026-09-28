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
import type { DeleteRequest, IssueSeverity, NodeUpdate, UUID } from "@/lib/types";
import type { BundlePlan, BatchResult, MutationStep } from "./suggestion-apply";

import { CanvasContextMenu, type ContextMenuItem } from "./canvas-context-menu";
import {
  DELETE_LANE_DESCRIPTION,
  DELETE_LANE_LABEL,
  deleteActionDescription,
  deleteActionLabel,
} from "./delete-reason";
import { FloatingToolbar, type CanvasTool } from "./floating-toolbar";
import { LaneRail } from "./lane-rail";
import { LANE_HEIGHT, LANE_PALETTE, nodeKindFromType } from "./layout";
import { sizeForNodeType } from "./node-type";
import { isEdgeProposed, placeProposedStep } from "./ai-edit";
import { laneAccent, MARKER, NODE_SHADOW_FILTER, THEME } from "./canvas-theme";
import { computeEdgeRoutes } from "./edge-routes";
import { resolveShortcut, type ShortcutAction } from "./keymap";
import {
  boundsOf,
  contentBounds,
  ensureVisible,
  fitRect,
  interpretWheel,
  scaleAt,
  zoomAt,
  type WheelMode,
} from "./viewport-math";
import { browserWheelModeStore } from "./wheel-mode";
import { roundedPath } from "./rounded-path";
import { edgeFocusCenter } from "./edge-focus";
import { normalizeMarquee, nodesInMarquee, edgesInMarquee } from "./selection";
import {
  PALETTE_DRAG_MIME,
  PALETTE_SHAPES,
  ShapePalette,
  type PaletteShape,
} from "./shape-palette";
import {
  creationReason,
  EDGE_REASON_TAB,
  resolveDraftCommit,
  type DraftTrigger,
  type DraftVia,
} from "./draft-step";
import { NodeLabelEditor } from "./node-label-editor";
import { LANE_HEADER_W, nextStepSlot, pointToLaneSlot, type LaneBox } from "./step-placement";
import { computeSnap, guidesFor, type Box } from "./snap";
import { alignItems, type AlignCommand } from "./align";
import { routesToReset, type RouteReset } from "./routes";
import { anchorToolbar } from "./toolbar-anchor";
import { SelectionToolbar } from "./selection-toolbar";
import {
  arrowDirection,
  clampNudge,
  NUDGE_BURST_MS,
  NUDGE_LARGE,
  NUDGE_SMALL,
} from "./nudge";
import {
  buildEdgePath,
  EdgeArrow,
  HANDLE_OFFSET,
  NodeShape,
  sidePoint,
  type ConnectSide,
  type EdgeOrientation,
} from "./shapes";
import { pickDropTarget, type Rect } from "./drop-target";

/** World units a connect drop may land outside a node and still target it. */
const DROP_TOLERANCE = 20;
import { isBacktrack, deriveLoopSides } from "./backtrack";
import type {
  CanvasEdge,
  CanvasLane,
  CanvasNode,
  CanvasNodeKind,
  ResolvedNode,
  Viewport,
} from "./types";
import { ReasonPromptDialog } from "./reason-prompt-dialog";
import { useClipboard } from "./use-clipboard";
import { useGraphPersistence, type SaveStatus } from "./use-persistence";
import { useReasonPrompt } from "./use-reason-prompt";
import { useUndoStack, type UndoAction } from "./use-undo-stack";

const WORLD_WIDTH_MIN = 1700;
const WORLD_RIGHT_PADDING = 240;
const MIN_LANE_HEIGHT = 90;
const COLLAPSED_LANE_HEIGHT = 28;

const PASTE_OFFSET = 24;

/** A step being named before it exists (double-click, Tab, palette). It is
 * only created when the name is committed; see ./draft-step. */
type DraftStep = {
  key: number;
  laneId: UUID;
  x: number;
  relativeY: number;
  type: string;
  kind: CanvasNodeKind;
  w: number;
  h: number;
  via: DraftVia;
  defaultName: string;
  /** The step this one follows (Tab). A promise because the source may be a
   * draft still being saved when the user Tabs on from it. */
  source: Promise<UUID | null> | null;
  /** Where the source sits, in world units, for the preview connector. */
  sourceRect?: { x: number; y: number; w: number; h: number };
};

type Editing =
  | { kind: "rename"; nodeId: UUID }
  | { kind: "draft"; draft: DraftStep }
  | null;

const ZOOM_STEP = 1.2;
/** How close (screen pixels) a dragged step must come to a line to snap. */
const SNAP_PX = 6;

type NodePosition = { id: UUID; x: number; relativeY: number; laneId: UUID | null };

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
  | { kind: "node"; id: UUID; name?: string; nodeKind?: string; type?: string; laneId?: UUID | null; description?: string; childModelId?: UUID | null }
  | { kind: "edge"; id: UUID }
  | { kind: "multi"; nodeIds: UUID[]; edgeIds: UUID[] };

export interface BpmnCanvasHandle {
  /** Prompt for a deletion reason, then — unless the user cancels — call the
   * API and remove the node (and any edges touching it) from local state
   * without re-fetching the whole graph. Resolves either way, so a caller
   * cannot tell a cancel from a delete; it should react to the resulting
   * selection change rather than assuming the node is gone. */
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
  /** Clear the current selection (used by the chat when a message is sent). */
  clearSelection: () => void;
  /** Pan/zoom to an object by id, select it, and flash it briefly. Handles
   * both nodes and edges (used by chat mention links). */
  navigateTo: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  /** Clear a node's child-sub-process link locally (drops the "+" marker)
   * after the sub-process is removed via the API. */
  clearChildModelId: (id: UUID) => void;
  /** Prompt once for a deletion reason, then — unless the user cancels — delete
   * every selected node and edge under it (node deletes are non-undoable). */
  deleteSelection: () => Promise<void>;
  /** Copy the current selection to the in-memory clipboard. */
  copySelection: () => void;
  /** Reassign every selected node to a lane (grouped undo). */
  moveSelectionToLane: (laneId: UUID) => void;
  /** Apply a validated suggestion bundle plan to the canvas. Runs every step,
   * rolling back on failure. Undoable plans record a single grouped undo entry
   * (Cmd+Z) and return an inline `undo`; delete-containing plans do neither. */
  applySuggestionBatch: (plan: BundlePlan) => Promise<BatchResult>;
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
  /** Fires when a node with a child sub-process is double-clicked. The page
   * resolves the child's latest version and routes there. */
  onDrillIntoNode?: (childModelId: UUID) => void;
  /** Screen pixels on the right hidden behind floating panels (chat,
   * properties). Scroll-into-view treats that strip as off-screen. */
  occludedRight?: number;
}

/** Change-log reasons for applied-suggestion semantic edits. `planBundle` fills
 * each step's `reason` from the suggestion's rationale; APPLIED_REASON_FALLBACK
 * only guards a step that somehow reached the executor without one. The inverse
 * (undo) is a user-initiated revert, so it logs its own plain reason and is NOT
 * marked `ai_applied`. */
const APPLIED_REASON_FALLBACK = "Applied AI suggestion";
const REVERT_REASON = "Reverted an applied AI suggestion";

/** Pure helper: recompute `y` offsets for a lane list after insertions/deletions.
 * Module-level (not a hook) so both the canvas body and `runStep` can call it. */
function recomputeY(ls: CanvasLane[]): CanvasLane[] {
  let y = 0;
  return ls.map((l) => {
    const out = { ...l, y };
    y += l.h;
    return out;
  });
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
  onDrillIntoNode,
  occludedRight = 0,
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
  const occludedRightRef = useRef(occludedRight);
  occludedRightRef.current = occludedRight;
  // Mouse/Trackpad scroll setting. Starts at the default and is read from
  // storage after mount, so server and first client render agree.
  const [wheelMode, setWheelMode] = useState<WheelMode>("trackpad");
  const wheelModeRef = useRef<WheelMode>("trackpad");
  wheelModeRef.current = wheelMode;
  const wheelModeStore = useMemo(() => browserWheelModeStore(), []);
  useEffect(() => {
    setWheelMode(wheelModeStore.load());
  }, [wheelModeStore]);
  const changeWheelMode = useCallback(
    (next: WheelMode) => {
      setWheelMode(next);
      wheelModeStore.save(next);
    },
    [wheelModeStore]
  );
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

  const { record, undo, redo, isLatest, canUndo, canRedo } = useUndoStack();
  const clipboard = useClipboard();
  const reasonPrompt = useReasonPrompt();
  const { promptReason } = reasonPrompt;

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
    async (id: UUID, body: DeleteRequest) => {
      await api.deleteNode(projectId, id, body);
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
      next: { name: string; laneId: UUID | null; relativeY: number; description?: string },
      reason: string
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
        reason,
      });
    },
    [projectId]
  );

  const applyNodeTypeLocal = useCallback(
    async (id: UUID, newType: string, reason: string) => {
      const kind = nodeKindFromType(newType);
      const size = sizeForNodeType(newType);
      setNodes((curr) =>
        curr.map((n) =>
          n.id === id
            ? { ...n, type: newType, kind, w: size.w, h: size.h }
            : n
        )
      );
      await api.updateNode(projectId, id, { type: newType, reason });
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
        const reason = await promptReason("Change step type");
        if (reason === null) return;
        await applyNodeTypeLocal(id, newType, reason);
        const description = "Change node type";
        record({
          description,
          do: () => applyNodeTypeLocal(id, newType, `Redo of ${description}`),
          undo: () => applyNodeTypeLocal(id, oldType, `Undo of ${description}`),
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
        const reason = await promptReason("Edit step description");
        if (reason === null) return;
        await applyNodeEditLocal(id, { ...base, description: newDescription }, reason);
        const description = "Edit description";
        record({
          description,
          do: () =>
            applyNodeEditLocal(id, { ...base, description: newDescription }, `Redo of ${description}`),
          undo: () =>
            applyNodeEditLocal(id, { ...base, description: oldDescription }, `Undo of ${description}`),
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
      const reason = await promptReason(laneChanged ? "Move step to lane" : "Rename step");
      if (reason === null) return;
      await applyNodeEditLocal(id, next, reason);
      const description = laneChanged ? "Move node to lane" : "Rename node";
      record({
        description,
        do: () => applyNodeEditLocal(id, next, `Redo of ${description}`),
        undo: () => applyNodeEditLocal(id, prev, `Undo of ${description}`),
      });
    },
    [applyNodeEditLocal, applyNodeTypeLocal, record, promptReason]
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
          undo: () =>
            deleteNodeImpl(liveNode.id, {
              reason: "Undo of Add AI-proposed step",
            }),
        });
      } catch (err) {
        console.error("Failed to apply proposed step", err);
        toast.error("Couldn't add the suggested step — please try again.");
      }
    },
    [projectId, modelId, versionId, record, deleteNodeImpl, selectOnly]
  );

  const clearChildModelId = useCallback((id: UUID) => {
    setNodes((curr) =>
      curr.map((n) => (n.id === id ? { ...n, childModelId: null } : n))
    );
  }, []);

  // Pick a world position for a newly-created suggestion node: offset from the
  // anchor node when one is given, else a default slot in the target lane.
  const placeNewNode = useCallback(
    (laneId: UUID | null, nearNodeId: UUID | null): { laneId: UUID; x: number; relativeY: number } | null => {
      const near = nearNodeId ? nodesRef.current.find((n) => n.id === nearNodeId) : null;
      const resolvedLane = laneId ?? near?.laneId ?? lanesRef.current[0]?.id ?? null;
      if (!resolvedLane) return null;
      if (near) {
        const pos = placeProposedStep({ x: near.x, relativeY: near.relativeY, w: near.w });
        return { laneId: resolvedLane, x: pos.x, relativeY: pos.relativeY };
      }
      const inLane = nodesRef.current.filter((n) => n.laneId === resolvedLane);
      const x = inLane.length ? Math.max(...inLane.map((n) => n.x + n.w)) + 60 : 80;
      return { laneId: resolvedLane, x, relativeY: 40 };
    },
    // Empty deps intentional: reads only via stable refs (nodesRef/lanesRef)
    // and the module-level placeProposedStep, so it never needs to re-create.
    []
  );

  // Takes a bare `reason` rather than a DeleteRequest (as deleteNodeImpl does)
  // because no AI path routes through here — applied suggestions delete edges
  // via api.deleteEdge directly, since this impl records an undo entry that
  // delete-containing plans must not get. So `ai_applied` is never wanted.
  const deleteEdgeImpl = useCallback(
    async (id: UUID, reason: string) => {
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
          reason: "Undo of Delete edge",
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
      await api.deleteEdge(projectId, currentId, { reason });
      remove(currentId);
      const description = "Delete edge";
      record({
        description,
        do: async () => {
          await api.deleteEdge(projectId, currentId, {
            reason: `Redo of ${description}`,
          });
          remove(currentId);
        },
        undo: recreate,
      });
    },
    [projectId, modelId, versionId, record, deselect]
  );

  /** Prompt for a reason, then delete every selected node and edge with it.
   * One prompt covers the whole selection: one user decision, one rationale,
   * N recorded consequences. */
  const deleteSelectionImpl = useCallback(async () => {
    const ids = [...selectedIdsRef.current];
    if (ids.length === 0) return;
    const nodeIds = ids.filter((id) => nodesRef.current.some((n) => n.id === id));
    const edgeIds = ids.filter((id) => edgesRef.current.some((e) => e.id === id));
    // Ids can be selected but present in neither list (e.g. removed by a
    // concurrent apply). Bail before prompting: both loops below would no-op,
    // so the modal would ask the user to justify nothing.
    if (nodeIds.length + edgeIds.length === 0) return;
    const counts = { nodes: nodeIds.length, edges: edgeIds.length };
    const reason = await promptReason(deleteActionLabel(counts), {
      destructive: true,
      description: deleteActionDescription(counts),
    });
    if (reason === null) return;
    // Nodes first: deleteNodeImpl also strips their touching edges locally.
    for (const id of nodeIds) {
      await deleteNodeImpl(id, { reason });
    }
    // Then any still-present standalone edges (skip ones a node delete removed).
    for (const id of edgeIds) {
      if (edgesRef.current.some((e) => e.id === id)) {
        await deleteEdgeImpl(id, reason);
      }
    }
  }, [deleteNodeImpl, deleteEdgeImpl, promptReason]);

  /** Panel/handle entry point for deleting one node. */
  const requestDeleteNode = useCallback(
    async (id: UUID) => {
      const counts = { nodes: 1, edges: 0 };
      const reason = await promptReason(deleteActionLabel(counts), {
        destructive: true,
        description: deleteActionDescription(counts),
      });
      if (reason === null) return;
      await deleteNodeImpl(id, { reason });
    },
    [deleteNodeImpl, promptReason]
  );

  /** Context-menu entry point for deleting one edge. */
  const requestDeleteEdge = useCallback(
    async (id: UUID) => {
      const counts = { nodes: 0, edges: 1 };
      const reason = await promptReason(deleteActionLabel(counts), {
        destructive: true,
        description: deleteActionDescription(counts),
      });
      if (reason === null) return;
      await deleteEdgeImpl(id, reason);
    },
    [deleteEdgeImpl, promptReason]
  );

  const updateEdgeLabelLocal = useCallback(
    async (id: UUID, label: string | null, reason: string) => {
      const updated = await api.updateEdge(projectId, id, { label, reason });
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
      const reason = await promptReason("Edit connection label");
      if (reason === null) return;
      await updateEdgeLabelLocal(id, newLabel, reason);
      const description = "Edit edge label";
      record({
        description,
        do: () => updateEdgeLabelLocal(id, newLabel, `Redo of ${description}`),
        undo: () => updateEdgeLabelLocal(id, oldLabel, `Undo of ${description}`),
      });
    },
    [updateEdgeLabelLocal, record, promptReason]
  );

  const createEdgeImpl = useCallback(
    async (
      sourceId: UUID,
      targetId: UUID,
      opts?: {
        sourceSide?: "top" | "bottom";
        targetSide?: "top" | "bottom";
        kind?: "rework";
      }
    ) => {
      let currentId: UUID;
      const create = async () => {
        const created = await api.createEdge(projectId, modelId, versionId, {
          source_node_id: sourceId,
          target_node_id: targetId,
          ...(opts?.sourceSide ? { source_side: opts.sourceSide } : {}),
          ...(opts?.targetSide ? { target_side: opts.targetSide } : {}),
          ...(opts?.kind ? { edge_kind: opts.kind } : {}),
        });
        currentId = created.id;
        setEdges((curr) => [
          ...curr,
          {
            id: currentId,
            from: sourceId,
            to: targetId,
            label: created.label ?? null,
            sourceSide: created.source_side ?? opts?.sourceSide ?? null,
            targetSide: created.target_side ?? opts?.targetSide ?? null,
            kind: created.edge_kind === "rework" ? "rework" : "flow",
          },
        ]);
      };
      await create();
      record({
        description: opts?.kind === "rework" ? "Create rework edge" : "Create edge",
        do: create,
        undo: async () => {
          await api.deleteEdge(projectId, currentId, {
            reason: "Undo of Create edge",
          });
          setEdges((curr) => curr.filter((e) => e.id !== currentId));
          deselect(currentId);
        },
      });
    },
    [projectId, modelId, versionId, record, deselect]
  );

  // Per-step executor for applySuggestionBatch. Declared before
  // applySuggestionBatch so it can appear in that callback's dep array.
  const runStep = useCallback(
    async (
      step: MutationStep,
      tmp: Record<string, UUID>,
      resolve: (ref: string) => UUID,
      inverses: Array<() => Promise<void>>,
      batchCtx: { newLaneCount: number }
    ) => {
      switch (step.kind) {
        case "update_node": {
          const id = resolve(step.nodeRef);
          const before = nodesRef.current.find((n) => n.id === id);
          if (!before) throw new Error("Node no longer exists.");
          const apiPatch: NodeUpdate = {};
          const localPatch: Partial<CanvasNode> = {};
          if (step.name !== undefined) {
            apiPatch.name = step.name;
            localPatch.label = step.name;
          }
          if (step.description !== undefined) {
            apiPatch.description = step.description;
            localPatch.description = step.description;
          }
          if (step.laneRef !== undefined) {
            const laneId = resolve(step.laneRef);
            apiPatch.lane_id = laneId;
            localPatch.laneId = laneId;
          }
          if (step.nodeType !== undefined) {
            const size = sizeForNodeType(step.nodeType);
            apiPatch.type = step.nodeType;
            localPatch.type = step.nodeType;
            localPatch.kind = nodeKindFromType(step.nodeType);
            localPatch.w = size.w;
            localPatch.h = size.h;
          }
          apiPatch.reason = step.reason ?? APPLIED_REASON_FALLBACK;
          apiPatch.ai_applied = true;
          const prev = { label: before.label, description: before.description, laneId: before.laneId, type: before.type, kind: before.kind, w: before.w, h: before.h };
          setNodes((curr) => curr.map((n) => (n.id === id ? { ...n, ...localPatch } : n)));
          // Push the inverse BEFORE the API call so a forward failure can still
          // revert the optimistic local edit. Restoring to the pre-edit value is
          // a harmless no-op on the server if the forward call never landed.
          inverses.push(async () => {
            setNodes((curr) => curr.map((n) => (n.id === id ? { ...n, ...prev } : n)));
            // Mirror the forward step: only restore the fields it touched, so an
            // undo never writes a spurious change to an untouched field. A
            // describe_node applied to a node that had no description is reverted
            // with "" (an explicit empty string the backend persists) rather than
            // `undefined`, which a PATCH drops and so can't clear the field.
            const inversePatch: NodeUpdate = { reason: REVERT_REASON };
            if (step.name !== undefined) inversePatch.name = prev.label;
            if (step.description !== undefined) inversePatch.description = prev.description ?? "";
            if (step.laneRef !== undefined) inversePatch.lane_id = prev.laneId ?? undefined;
            if (step.nodeType !== undefined) inversePatch.type = prev.type;
            await api.updateNode(projectId, id, inversePatch);
          });
          await api.updateNode(projectId, id, apiPatch);
          break;
        }
        case "delete_node": {
          const id = resolve(step.nodeRef);
          await deleteNodeImpl(id, {
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          // delete-containing plans aren't undoable; no inverse pushed.
          break;
        }
        case "create_node": {
          const place = placeNewNode(
            step.laneRef ? resolve(step.laneRef) : null,
            step.nearNodeRef ? resolve(step.nearNodeRef) : null
          );
          if (!place) throw new Error("No lane available to place the new step.");
          const created = await api.createNode(projectId, modelId, versionId, {
            type: step.nodeType,
            name: step.label,
            lane_id: place.laneId,
            x: place.x,
            relative_y: place.relativeY,
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          const size = sizeForNodeType(created.type);
          const newNode: CanvasNode = {
            id: created.id,
            type: created.type,
            kind: nodeKindFromType(created.type),
            label: created.name,
            laneId: place.laneId,
            x: place.x,
            relativeY: place.relativeY,
            w: size.w,
            h: size.h,
            aiProposed: true,
          };
          tmp[step.tempId] = created.id;
          setNodes((curr) => [...curr, newNode]);
          inverses.push(async () => {
            await api.deleteNode(projectId, created.id, { reason: REVERT_REASON });
            setNodes((curr) => curr.filter((n) => n.id !== created.id));
            setEdges((curr) => curr.filter((e) => e.from !== created.id && e.to !== created.id));
          });
          break;
        }
        case "create_edge": {
          const created = await api.createEdge(projectId, modelId, versionId, {
            source_node_id: resolve(step.fromRef),
            target_node_id: resolve(step.toRef),
            label: step.label,
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          if (step.tempId) tmp[step.tempId] = created.id;
          setEdges((curr) => [
            ...curr,
            { id: created.id, from: created.source_node_id, to: created.target_node_id, label: created.label ?? null },
          ]);
          inverses.push(async () => {
            await api.deleteEdge(projectId, created.id, { reason: REVERT_REASON });
            setEdges((curr) => curr.filter((e) => e.id !== created.id));
          });
          break;
        }
        case "delete_edge": {
          const id = resolve(step.edgeRef);
          await api.deleteEdge(projectId, id, {
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          setEdges((curr) => curr.filter((e) => e.id !== id));
          // delete-containing plan: no inverse.
          break;
        }
        case "update_edge_label": {
          const id = resolve(step.edgeRef);
          const before = edgesRef.current.find((e) => e.id === id);
          if (!before) throw new Error("Edge no longer exists.");
          const oldLabel = before.label;
          setEdges((curr) => curr.map((e) => (e.id === id ? { ...e, label: step.label } : e)));
          // Push the inverse BEFORE the API call (see update_node note).
          inverses.push(async () => {
            setEdges((curr) => curr.map((e) => (e.id === id ? { ...e, label: oldLabel } : e)));
            await api.updateEdge(projectId, id, { label: oldLabel, reason: REVERT_REASON });
          });
          await api.updateEdge(projectId, id, {
            label: step.label,
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          break;
        }
        case "reroute_edge": {
          const id = resolve(step.edgeRef);
          const before = edgesRef.current.find((e) => e.id === id);
          if (!before) throw new Error("Edge no longer exists.");
          const newFrom = step.fromRef ? resolve(step.fromRef) : before.from;
          const newTo = step.toRef ? resolve(step.toRef) : before.to;
          await api.deleteEdge(projectId, id, {
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          setEdges((curr) => curr.filter((e) => e.id !== id));
          // The edge is already gone; if the recreate fails we can't restore it
          // (non-undoable batch), so surface a clear, recoverable message.
          let created;
          try {
            created = await api.createEdge(projectId, modelId, versionId, {
              source_node_id: newFrom,
              target_node_id: newTo,
              label: before.label,
              // Both halves of the reroute are the AI's doing; without these the
              // create logs as a manual user edit.
              reason: step.reason ?? APPLIED_REASON_FALLBACK,
              ai_applied: true,
            });
          } catch {
            throw new Error(
              "The edge was deleted but could not be reconnected — please refresh the map."
            );
          }
          setEdges((curr) => [
            ...curr,
            { id: created.id, from: created.source_node_id, to: created.target_node_id, label: created.label ?? null },
          ]);
          // delete-containing plan: no inverse.
          break;
        }
        case "create_lane": {
          // lanesRef.current is stale within a batch (setLanes is async), so a
          // batch-scoped counter offsets order_index + palette index to keep
          // multiple create_lane steps in one bundle distinct.
          const laneSlot = lanesRef.current.length + batchCtx.newLaneCount;
          const created = await api.createLane(projectId, modelId, versionId, {
            name: step.name,
            order_index: laneSlot,
            height_px: LANE_HEIGHT,
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          batchCtx.newLaneCount++;
          tmp[step.tempId] = created.id;
          const newLane: CanvasLane = {
            id: created.id,
            label: created.name,
            color: LANE_PALETTE[laneSlot % LANE_PALETTE.length],
            collapsed: false,
            y: 0,
            h: created.height_px,
          };
          setLanes((curr) => recomputeY([...curr, newLane]));
          inverses.push(async () => {
            await api.deleteLane(projectId, created.id, { reason: REVERT_REASON });
            setLanes((curr) => recomputeY(curr.filter((l) => l.id !== created.id)));
          });
          break;
        }
        case "update_lane": {
          const id = resolve(step.laneRef);
          const before = lanesRef.current.find((l) => l.id === id);
          if (!before) throw new Error("Lane no longer exists.");
          const oldName = before.label;
          setLanes((curr) => curr.map((l) => (l.id === id ? { ...l, label: step.name } : l)));
          // Push the inverse BEFORE the API call (see update_node note).
          inverses.push(async () => {
            setLanes((curr) => curr.map((l) => (l.id === id ? { ...l, label: oldName } : l)));
            await api.updateLane(projectId, id, { name: oldName, reason: REVERT_REASON });
          });
          await api.updateLane(projectId, id, {
            name: step.name,
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          break;
        }
        case "delete_lane": {
          const id = resolve(step.laneRef);
          // Flush pending PATCHes so we don't fire a 404 against a deleted lane
          // (mirrors the manual deleteLane callback).
          await flush();
          await api.deleteLane(projectId, id, {
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          // Backend reassigns this lane's nodes to the first REMAINING lane (by order),
          // not to no lane — mirror it so local state matches the server and the
          // reassigned nodes keep rendering inside a real lane.
          const fallback = lanesRef.current.find((l) => l.id !== id);
          setLanes((curr) => recomputeY(curr.filter((l) => l.id !== id)));
          // Drop the deleted lane from the collapse set so the (now persisted)
          // set doesn't accumulate orphaned IDs over a long session (mirrors the
          // manual deleteLane callback).
          setCollapsedLaneIds((curr) => {
            if (!curr.has(id)) return curr;
            const next = new Set(curr);
            next.delete(id);
            return next;
          });
          if (fallback) {
            setNodes((curr) => curr.map((n) => (n.laneId === id ? { ...n, laneId: fallback.id } : n)));
          }
          // delete-containing plan: no inverse.
          break;
        }
        case "update_edge_condition": {
          const id = resolve(step.edgeRef);
          const before = edgesRef.current.find((e) => e.id === id);
          if (!before) throw new Error("Edge no longer exists.");
          const oldCondition = before.condition ?? null;
          setEdges((curr) => curr.map((e) => (e.id === id ? { ...e, condition: step.conditionText } : e)));
          inverses.push(async () => {
            setEdges((curr) => curr.map((e) => (e.id === id ? { ...e, condition: oldCondition } : e)));
            await api.updateEdge(projectId, id, { condition_text: oldCondition, reason: REVERT_REASON });
          });
          await api.updateEdge(projectId, id, {
            condition_text: step.conditionText,
            reason: step.reason ?? APPLIED_REASON_FALLBACK,
            ai_applied: true,
          });
          break;
        }
      }
    },
    // `flush` (from useGraphPersistence, declared below) is referenced in the
    // delete_lane case above but intentionally omitted here: it's read inside
    // the callback body only when runStep is invoked (after the full render
    // completes), so including it in this literal would throw a
    // ReferenceError (TDZ) on every render, since useGraphPersistence hasn't
    // run yet at this point in the component body. `flush`'s identity is
    // stable across renders (memoized on `projectId` alone, which is already
    // a dep here), so omitting it does not cause staleness.
    [projectId, modelId, versionId, deleteNodeImpl, placeNewNode]
  );

  const applySuggestionBatch = useCallback(
    async (plan: BundlePlan): Promise<BatchResult> => {
      if (!plan.applyable) {
        return { ok: false, error: plan.reason ?? "This change can no longer be applied." };
      }

      // tmp placeholder -> real id, populated as create-steps run.
      const tmp: Record<string, UUID> = {};
      const resolve = (ref: string): UUID => (tmp[ref] as UUID) ?? (ref as UUID);
      let inverses: Array<() => Promise<void>> = [];
      let applied = false;
      let dead = false;

      const runSteps = async () => {
        // Reset by deleting keys (NOT reassigning) so `resolve`'s captured
        // reference stays valid; clears stale tmp entries on a reapply/redo.
        for (const k in tmp) delete tmp[k];
        inverses = [];
        const batchCtx = { newLaneCount: 0 };
        for (const step of plan.steps) {
          await runStep(step, tmp, resolve, inverses, batchCtx);
        }
        applied = true;
      };

      try {
        await runSteps();
      } catch (err) {
        for (const inv of [...inverses].reverse()) {
          try {
            await inv();
          } catch {
            /* best-effort rollback */
          }
        }
        return { ok: false, error: err instanceof Error ? err.message : "Couldn't apply the change." };
      }

      if (!plan.undoable) return { ok: true };

      const revert = async () => {
        if (!applied) return;
        for (const inv of [...inverses].reverse()) await inv();
        applied = false;
      };
      const reapply = async () => {
        if (applied || dead) return;
        await runSteps();
      };
      record({ description: "Apply suggestion", do: reapply, undo: revert });
      // Card Undo reverts AND permanently kills redo for this batch so
      // Cmd+Shift+Z can't silently re-apply while the card shows "pending".
      const cardUndo = async () => {
        await revert();
        dead = true;
      };
      return { ok: true, undo: cardUndo };
    },
    [record, runStep]
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

  // NOTE: useImperativeHandle is defined further down, after copySelectionImpl
  // and moveSelectionToLaneImpl, so those callbacks can be listed in its
  // dependency array without a temporal-dead-zone reference.

  // Keyboard shortcuts. `resolveShortcut` (./keymap) maps a key to an action;
  // this handler owns the context: nothing fires while typing in a field, and
  // Space-to-pan only claims the key while the pointer is over the canvas.
  // Actions are read through `shortcutActionsRef` (filled in once every
  // callback exists, further down) so this listener is registered once and
  // never goes stale.
  const shortcutActionsRef = useRef<
    Partial<Record<ShortcutAction, (e: KeyboardEvent) => void | boolean>>
  >({});
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (inEditable) return;

      if (e.code === "Space") {
        // Only hijack Space for pan when the pointer is over the canvas;
        // elsewhere leave it for scrolling and button/menu activation.
        if (!pointerOverCanvasRef.current) return;
        e.preventDefault(); // stop the page from scrolling
        spaceHeld.current = true;
        return;
      }

      const action = resolveShortcut(e);
      if (!action) return;
      if (action === "delete" && selectedIdsRef.current.size === 0) return;
      if (action === "escape" && contextMenuRef.current) {
        setContextMenu(null);
        return;
      }
      if (action === "next-step" || action === "rename" || action === "nudge") {
        // Tab/Enter/arrows only belong to the canvas when focus is on it (or on
        // nothing). Anywhere else — a panel button, a link — they keep their
        // normal meaning.
        const active = document.activeElement;
        const root = svgRef.current?.parentElement;
        const onCanvas = !active || active === document.body || (!!root && root.contains(active));
        if (!onCanvas) return;
      }
      const run = shortcutActionsRef.current[action];
      if (!run) return;
      // An action can decline (e.g. Tab with nothing selected); then the key
      // keeps its browser meaning.
      if (run(e) === false) return;
      // Claim the key so the browser doesn't also act on it (page zoom on
      // Mod+=, select-all text on Mod+A, back-navigation on Backspace).
      e.preventDefault();
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
  }, []);

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const spaceHeld = useRef(false);
  // True while the pointer is over the canvas. Space-to-pan only engages then,
  // so we don't swallow Space (scroll / button activation) page-wide.
  const pointerOverCanvasRef = useRef(false);
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
  // Alignment snapping while a step is dragged: the steps it can line up
  // with (fixed at drag start) and whether snapping is on right now (off
  // while Ctrl/Cmd is held).
  const snapOthersRef = useRef<Box[]>([]);
  const [snapping, setSnapping] = useState(false);

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

  // A signature of the single-selected node's panel-relevant fields. The emit
  // effect below depends on it so a selected node edited from ELSEWHERE — an
  // applied chat suggestion, an undo/redo — re-emits a fresh selection and the
  // Properties panel reflects it without a reselect. Excludes position so a
  // plain drag of the selected node doesn't churn the selection; a cross-lane
  // drag changes laneId and re-emits, which is what we want.
  const selectedNodeSig = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const id = [...selectedIds][0];
    const n = nodes.find((x) => x.id === id);
    return n
      ? JSON.stringify([n.label, n.kind, n.type, n.laneId, n.description ?? null])
      : null;
  }, [selectedIds, nodes]);

  // Notify parent of selection so it can drive side panels. `selectedNodeSig` is
  // a re-emit trigger (the body reads the live node via nodesRef), not used here.
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
          childModelId: node.childModelId ?? null,
        });
      } else {
        onSelectionChange({ kind: "edge", id });
      }
      return;
    }
    const nodeIds = ids.filter((id) => nodesRef.current.some((n) => n.id === id));
    const edgeIds = ids.filter((id) => edgesRef.current.some((e) => e.id === id));
    onSelectionChange({ kind: "multi", nodeIds, edgeIds });
  }, [selectedIds, onSelectionChange, selectedNodeSig]);

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

  // Guides for what the dragged steps line up with, read from where they
  // actually are (after the lane clamp), so a guide never claims an
  // alignment that didn't happen.
  const snapGuides = useMemo(() => {
    if (drag?.type !== "node" || !snapping) return [];
    const ids = new Set(drag.members.map((m) => m.id));
    const moving = boundsOf(renderNodes.filter((n) => ids.has(n.id)));
    return moving ? guidesFor(moving, snapOthersRef.current) : [];
  }, [drag, snapping, renderNodes]);

  const renderNodeById = useMemo(
    () => new Map(renderNodes.map((n) => [n.id, n])),
    [renderNodes]
  );
  // Every connector is placed with its neighbours in view (shared sides,
  // gateway corners), so routes are computed for the whole map at once.
  const edgeRoutes = useMemo(
    () => computeEdgeRoutes(edges, renderNodes),
    [edges, renderNodes]
  );

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

  // Native wheel handler with passive:false so the page never scrolls or
  // zooms under the canvas. What the wheel does depends on the user's
  // Mouse/Trackpad setting (see interpretWheel).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const v = viewportRef.current;
      const action = interpretWheel(e, wheelModeRef.current, rect.height);
      if (action.kind === "zoom") {
        setViewport(
          zoomAt(v, action.factor, { x: e.clientX - rect.left, y: e.clientY - rect.top })
        );
      } else {
        setViewport({ ...v, tx: v.tx - action.dx, ty: v.ty - action.dy });
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
      // Body-drag picks the source side from where the user grabbed: the closest
      // of top/right/bottom/left to the click point. Backtrack vs forward is
      // decided on drop, not here.
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
    // Snap targets are fixed when the drag starts: every visible step that
    // isn't moving.
    const moving = new Set(members.map((m) => m.id));
    snapOthersRef.current = renderNodesRef.current
      .filter((n) => !moving.has(n.id))
      .map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
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
        let deltaX = x - drag.offX - grabbed.origX;
        let deltaY = y - drag.offY - grabbed.origAbsY;
        // Line the moving box up with nearby steps. Holding Ctrl/Cmd places
        // freely; it's read on every move so it can change mid-drag.
        const free = e.ctrlKey || e.metaKey;
        setSnapping(!free);
        if (!free && snapOthersRef.current.length > 0) {
          const boxes = drag.members.flatMap((m) => {
            const n = nodesRef.current.find((nn) => nn.id === m.id);
            return n ? [{ x: m.origX + deltaX, y: m.origAbsY + deltaY, w: n.w, h: n.h }] : [];
          });
          const moving = boundsOf(boxes);
          if (moving) {
            const snap = computeSnap(
              moving,
              snapOthersRef.current,
              SNAP_PX / viewportRef.current.scale
            );
            deltaX += snap.dx;
            deltaY += snap.dy;
          }
        }
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
        // Build resolved candidate rects (exclude the source) and pick the
        // nearest within tolerance, so a drop just outside a node still lands.
        const candidates: Rect[] = nodesRef.current
          .filter((n) => n.id !== drag.sourceId)
          .map((n) => {
            const lane = n.laneId
              ? displayLanesRef.current.find((l) => l.id === n.laneId)
              : undefined;
            const ny = lane ? lane.y + n.relativeY : n.relativeY;
            return { id: n.id, x: n.x, y: ny, width: n.w, height: n.h };
          });
        const targetId = pickDropTarget({ x, y }, candidates, DROP_TOLERANCE);
        const picked = candidates.find((c) => c.id === targetId);
        const targetRect = picked
          ? { x: picked.x, y: picked.y, w: picked.width, h: picked.height }
          : undefined;
        if (targetId && targetRect) {
          const sourceId = drag.sourceId;
          const source = nodesRef.current.find((n) => n.id === sourceId);
          const exists = edgesRef.current.some(
            (e2) => e2.from === sourceId && e2.to === targetId
          );
          if (!exists && source && isBacktrack(source, targetRect)) {
            const { sourceSide, targetSide } = deriveLoopSides(
              drag.sourceSide,
              y,
              targetRect
            );
            void createEdgeImpl(sourceId, targetId, {
              sourceSide,
              targetSide,
              kind: "rework",
            }).catch((err) => {
              console.error("Failed to create rework edge", err);
              toast.error("Couldn't add that backtrack arrow — please try again.");
            });
          } else if (!exists) {
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
        setSnapping(false);
        const finals = drag.members
          .map((m) => nodesRef.current.find((n) => n.id === m.id))
          .filter((n): n is NonNullable<typeof n> => !!n);
        const moved = drag.members.some((m) => {
          const f = finals.find((n) => n.id === m.id);
          return (
            f &&
            (f.x !== m.origX ||
              f.relativeY !== m.origRelativeY ||
              f.laneId !== m.origLaneId)
          );
        });
        // A drag that lands a node in a different lane is a SEMANTIC edit and
        // needs a reason; a pure reposition (or in-lane move) is cosmetic.
        const relaned = drag.members.some((m) => {
          const f = finals.find((n) => n.id === m.id);
          return f && f.laneId !== m.origLaneId;
        });
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
        const description =
          finals.length > 1 ? `Move ${finals.length} nodes` : "Move node";

        if (moved && relaned) {
          // Prompt for the relane reason. The nodes are already optimistically
          // in their new spots (from onMove); if the user cancels we snap them
          // back and persist nothing.
          void (async () => {
            const reason = await promptReason(
              finals.length > 1 ? `Move ${finals.length} steps to lane` : "Move step to lane"
            );
            if (reason === null) {
              applyGroupPositionsLocal(oldPositions);
              return;
            }
            applyGroupPositionsLocal(newPositions, reason);
            record({
              description,
              do: () => applyGroupPositionsLocal(newPositions, `Redo of ${description}`),
              undo: () => applyGroupPositionsLocal(oldPositions, `Undo of ${description}`),
            });
          })();
        } else {
          // Cosmetic move: persist position only, no prompt, no reason.
          for (const f of finals) {
            markNode(f.id, {
              x: f.x,
              relative_y: f.relativeY,
              lane_id: f.laneId ?? undefined,
            });
          }
          if (moved) {
            record({
              description,
              do: () => applyGroupPositionsLocal(newPositions),
              undo: () => applyGroupPositionsLocal(oldPositions),
            });
          }
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
  // applyGroupPositionsLocal is intentionally omitted: it's declared later in
  // the component (referencing it here would hit the TDZ) and its identity
  // tracks markNode, which is already a dependency, so the effect re-subscribes
  // exactly when it would change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, markNode, record, createEdgeImpl, projectId, applyEdgeBendLocal, promptReason, clearSelection, setSelection, selectOnly]);

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
    // Name it first; the step is created when the name is committed (a
    // blank name keeps the shape's default, since the drop was deliberate).
    openDraft({
      laneId: targetLane.id,
      x: dropCenterX,
      relativeY: rel,
      type: shape.backendType,
      via: "palette-drop",
      defaultName: shape.defaultName,
      source: null,
    });
  };

  // Fit frames the map's actual content (lane headers to the right-most
  // step), not the fixed minimum world width, so a small map fills the screen.
  const fitContent = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const box =
      contentBounds(renderNodesRef.current, displayLanesRef.current) ??
      { x: 0, y: 0, w: worldWidth, h: worldHeight };
    // Frame the map in the part of the canvas not covered by side panels.
    const visibleW = Math.max(200, rect.width - occludedRightRef.current);
    setViewport(fitRect(box, { w: visibleW, h: rect.height }, 48, 1));
  }, [worldWidth, worldHeight]);

  const zoomToSelection = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const picked = renderNodesRef.current.filter((n) => selectedIdsRef.current.has(n.id));
    const box = boundsOf(picked);
    if (!box) return;
    const visibleW = Math.max(200, rect.width - occludedRightRef.current);
    setViewport(fitRect(box, { w: visibleW, h: rect.height }, 96, 1.5));
  }, []);

  const zoomReset = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    setViewport(scaleAt(viewportRef.current, 1, { x: rect.width / 2, y: rect.height / 2 }));
  }, []);

  // Zoom toward the viewport center, mirroring the wheel handler's anchor math
  // so the +/- buttons keep content centered instead of drifting to the origin.
  const zoomByStep = useCallback((factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    setViewport(zoomAt(viewportRef.current, factor, { x: rect.width / 2, y: rect.height / 2 }));
  }, []);

  // Low-level mutator used by undo/redo callbacks for node moves. Bypasses
  // record() so undo replay does not pollute the history stack.
  const applyGroupPositionsLocal = useCallback(
    (
      positions: Array<{ id: UUID; x: number; relativeY: number; laneId: UUID | null }>,
      // Provided only when a position change also re-lanes a node (semantic);
      // pure repositioning leaves it undefined so the cosmetic patch carries
      // no reason.
      reason?: string
    ) => {
      const byId = new Map(positions.map((p) => [p.id, p]));
      setNodes((curr) =>
        curr.map((n) => {
          const p = byId.get(n.id);
          return p ? { ...n, x: p.x, relativeY: p.relativeY, laneId: p.laneId } : n;
        })
      );
      // Attach the caller-supplied reason to the persisted patch whenever one was
      // given. Callers pass a reason ONLY for a semantic relane (drag-across-lanes,
      // moveSelectionToLane, and their undo/redo); a pure reposition passes none.
      // We must NOT re-derive "did the lane change" from nodesRef here: the drag
      // path optimistically updates a node's lane during onMove, so by the time
      // this runs the node's "previous" lane already equals its new lane, which
      // would drop the required reason and 422 the backend.
      for (const p of positions) {
        markNode(p.id, {
          x: p.x,
          relative_y: p.relativeY,
          lane_id: p.laneId ?? undefined,
          ...(reason !== undefined ? { reason } : {}),
        });
      }
    },
    [markNode]
  );

  const moveSelectionToLaneImpl = useCallback(
    async (laneId: UUID) => {
      const ids = [...selectedIdsRef.current].filter((id) =>
        nodesRef.current.some((n) => n.id === id)
      );
      if (ids.length === 0) return;
      const oldPositions = ids.map((id) => {
        const n = nodesRef.current.find((nn) => nn.id === id)!;
        return { id, x: n.x, relativeY: n.relativeY, laneId: n.laneId };
      });
      // No-op if every selected node already lives in the target lane.
      if (oldPositions.every((p) => p.laneId === laneId)) return;
      const reason = await promptReason(
        ids.length > 1 ? `Move ${ids.length} steps to lane` : "Move step to lane"
      );
      if (reason === null) return;
      const newPositions = oldPositions.map((p) => ({ ...p, relativeY: 0, laneId }));
      applyGroupPositionsLocal(newPositions, reason);
      const description = `Move ${ids.length} to lane`;
      record({
        description,
        do: () => applyGroupPositionsLocal(newPositions, `Redo of ${description}`),
        undo: () => applyGroupPositionsLocal(oldPositions, `Undo of ${description}`),
      });
    },
    [applyGroupPositionsLocal, record, promptReason]
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

  // Placed here (not with the other hooks above) so copySelectionImpl and
  // moveSelectionToLaneImpl are already defined and can be real dependencies.
  useImperativeHandle(
    ref,
    () => ({
      deleteNode: requestDeleteNode,
      updateNode: updateNodeImpl,
      addProposedStep,
      selectNode: (id) => {
        setSelectedIds(new Set([id]));
        focusNodeInViewport(id);
      },
      clearSelection,
      navigateTo: (refTarget) => {
        setSelectedIds(new Set([refTarget.id]));
        if (refTarget.kind === "edge") focusEdgeInViewport(refTarget.id);
        else focusNodeInViewport(refTarget.id);
        flash(refTarget.id);
      },
      clearChildModelId,
      deleteSelection: deleteSelectionImpl,
      copySelection: copySelectionImpl,
      moveSelectionToLane: moveSelectionToLaneImpl,
      applySuggestionBatch,
    }),
    [
      requestDeleteNode,
      updateNodeImpl,
      addProposedStep,
      focusNodeInViewport,
      focusEdgeInViewport,
      flash,
      clearSelection,
      clearChildModelId,
      deleteSelectionImpl,
      copySelectionImpl,
      moveSelectionToLaneImpl,
      applySuggestionBatch,
    ]
  );

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
          reason: "Pasted from selection",
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
      for (const id of edgeIds)
        await api
          .deleteEdge(projectId, id, { reason: "Undo of Paste" })
          .catch(() => {});
      for (const id of nodeIds)
        await api
          .deleteNode(projectId, id, { reason: "Undo of Paste" })
          .catch(() => {});
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
          ...(() => {
            const child = count <= 1 ? nodesRef.current.find((n) => n.id === nodeId)?.childModelId : null;
            return child && onDrillIntoNode
              ? [{ label: "Open sub-process", onSelect: () => onDrillIntoNode(child) }]
              : [];
          })(),
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
    [selectOnly, copySelectionImpl, pasteClipboardImpl, deleteSelectionImpl, onOpenProperties, onDrillIntoNode]
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
          { label: "Delete", onSelect: () => void requestDeleteEdge(edgeId) },
        ],
      });
    },
    [selectOnly, requestDeleteEdge]
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
          { label: "Fit to screen", onSelect: fitContent },
        ],
      });
    },
    [clipboard, pasteClipboardImpl, fitContent]
  );

  // ── Fast creation and naming on the canvas (#97) ──────────────────────
  // Double-click empty lane space, Tab from a step, or a palette click opens a
  // draft with a name box; the step is created on commit. Renames happen in
  // the same box over the step (double-click, Enter, F2).
  const [editing, setEditing] = useState<Editing>(null);
  const draftKeyRef = useRef(0);
  // Creations run one at a time, so a fast Tab chain connects each step to
  // the one before it even while that one is still being saved.
  const creationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // Redo re-creates a step with a new id. Map old ids to their replacement
  // so a later redo in the same chain connects to the live step.
  const liveIdsRef = useRef(new Map<UUID, UUID>());
  const liveId = useCallback((id: UUID): UUID => {
    let cur = id;
    const seen = new Set<UUID>();
    while (liveIdsRef.current.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = liveIdsRef.current.get(cur)!;
    }
    return cur;
  }, []);

  const laneBoxes = useCallback(
    (): LaneBox[] =>
      displayLanesRef.current.map((l) => ({
        id: l.id,
        y: l.y,
        h: l.h,
        collapsed: collapsedLaneIds.has(l.id),
      })),
    [collapsedLaneIds]
  );

  /** Bring a world rect on screen (and zoom to 100% if the view is too far
   * out to read what you're typing). */
  const revealWorldRect = useCallback((r: { x: number; y: number; w: number; h: number }) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const box = { width: Math.max(200, rect.width - occludedRightRef.current), height: rect.height };
    let v = viewportRef.current;
    if (v.scale < 0.5) {
      v = scaleAt(v, 1, {
        x: (r.x + r.w / 2) * v.scale + v.tx,
        y: (r.y + r.h / 2) * v.scale + v.ty,
      });
    }
    v = ensureVisible(v, r, { w: box.width, h: box.height });
    if (v !== viewportRef.current) setViewport(v);
  }, []);

  const openDraft = useCallback(
    (args: {
      laneId: UUID;
      x: number;
      relativeY: number;
      type: string;
      via: DraftVia;
      defaultName: string;
      source: Promise<UUID | null> | null;
      sourceRect?: { x: number; y: number; w: number; h: number };
    }) => {
      const size = sizeForNodeType(args.type);
      const draft: DraftStep = {
        ...args,
        key: ++draftKeyRef.current,
        kind: nodeKindFromType(args.type),
        w: size.w,
        h: size.h,
      };
      setContextMenu(null);
      setEditing({ kind: "draft", draft });
      const lane = displayLanesRef.current.find((l) => l.id === args.laneId);
      if (lane) revealWorldRect({ x: args.x, y: lane.y + args.relativeY, w: size.w, h: size.h });
    },
    [revealWorldRect]
  );

  /** Save a named draft as a real step (plus its connector, for Tab), as one
   * undo step. Resolves to the new step's id, or null if it failed. */
  const commitDraft = useCallback(
    (draft: DraftStep, name: string): Promise<UUID | null> => {
      const run = async (): Promise<UUID | null> => {
        const sourceId = draft.source ? await draft.source : null;
        if (draft.source && !sourceId) return null; // the step before it failed
        const body = {
          type: draft.type,
          name,
          lane_id: draft.laneId,
          x: draft.x,
          relative_y: draft.relativeY,
        };
        const created = await api.createNode(projectId, modelId, versionId, {
          ...body,
          reason: creationReason(draft.via),
        });
        const node: CanvasNode = {
          id: created.id,
          type: draft.type,
          kind: draft.kind,
          label: created.name,
          laneId: draft.laneId,
          x: draft.x,
          relativeY: draft.relativeY,
          w: draft.w,
          h: draft.h,
        };
        setNodes((curr) => [...curr, node]);
        const connect = async (from: UUID, to: UUID, reason: string) => {
          const e = await api.createEdge(projectId, modelId, versionId, {
            source_node_id: from,
            target_node_id: to,
            reason,
          });
          setEdges((curr) => [...curr, { id: e.id, from, to, label: e.label ?? null }]);
        };
        if (sourceId) await connect(liveId(sourceId), created.id, EDGE_REASON_TAB);
        selectOnly(created.id);

        let liveNodeId: UUID = created.id;
        record({
          description: "Add step",
          do: async () => {
            const again = await api.createNode(projectId, modelId, versionId, {
              ...body,
              reason: "Redo of Add step",
            });
            liveIdsRef.current.set(liveNodeId, again.id);
            liveNodeId = again.id;
            setNodes((curr) => [...curr, { ...node, id: again.id }]);
            if (sourceId) await connect(liveId(sourceId), again.id, "Redo of Add step");
            selectOnly(again.id);
          },
          undo: () => deleteNodeImpl(liveNodeId, { reason: "Undo of Add step" }),
        });
        return created.id;
      };
      const p = creationQueueRef.current
        .then(run)
        .catch((err) => {
          console.error("Failed to add step", err);
          toast.error("Couldn't add that step — please try again.");
          return null;
        });
      creationQueueRef.current = p;
      return p;
    },
    [projectId, modelId, versionId, record, deleteNodeImpl, selectOnly, liveId]
  );

  /** Open a draft for the step after `from`, in the same lane. */
  const openNextDraft = useCallback(
    (from: {
      x: number;
      relativeY: number;
      w: number;
      h: number;
      laneId: UUID | null;
      source: Promise<UUID | null>;
    }) => {
      const lane = from.laneId ? displayLanesRef.current.find((l) => l.id === from.laneId) : undefined;
      if (!lane) {
        toast.error("Can't place a step from a node with no lane.");
        return;
      }
      if (collapsedLaneIds.has(lane.id)) return;
      const size = sizeForNodeType("task");
      const laneNodes = nodesRef.current
        .filter((n) => n.laneId === lane.id)
        .map((n) => ({ x: n.x, relativeY: n.relativeY, w: n.w, h: n.h }));
      laneNodes.push({ x: from.x, relativeY: from.relativeY, w: from.w, h: from.h });
      const slot = nextStepSlot(from, size, laneNodes, lane.h);
      openDraft({
        laneId: lane.id,
        ...slot,
        type: "task",
        via: "tab",
        defaultName: "New task",
        source: from.source,
        sourceRect: { x: from.x, y: lane.y + from.relativeY, w: from.w, h: from.h },
      });
    },
    [collapsedLaneIds, openDraft]
  );

  const onDraftCommit = useCallback(
    (draft: DraftStep, text: string, trigger: DraftTrigger) => {
      setEditing(null);
      const outcome = resolveDraftCommit({
        text,
        via: draft.via,
        trigger,
        defaultName: draft.defaultName,
      });
      if (outcome.kind === "discard") return;
      const pending = commitDraft(draft, outcome.name);
      if (trigger === "tab") {
        openNextDraft({
          x: draft.x,
          relativeY: draft.relativeY,
          w: draft.w,
          h: draft.h,
          laneId: draft.laneId,
          source: pending,
        });
      }
    },
    [commitDraft, openNextDraft]
  );

  const startRename = useCallback(
    (nodeId: UUID) => {
      const n = renderNodesRef.current.find((x) => x.id === nodeId);
      if (!n) return;
      setContextMenu(null);
      selectOnly(nodeId);
      setEditing({ kind: "rename", nodeId });
      revealWorldRect(n);
    },
    [selectOnly, revealWorldRect]
  );

  const onRenameCommit = useCallback(
    async (nodeId: UUID, text: string, trigger: DraftTrigger) => {
      setEditing(null);
      const n = nodesRef.current.find((x) => x.id === nodeId);
      if (!n) return;
      const name = text.trim();
      // Renaming an existing step still records a reason (it asks, or uses
      // the session note when one is set).
      if (trigger !== "escape" && name && name !== n.label) await updateNodeImpl(nodeId, { name });
      if (trigger === "tab") {
        const now = nodesRef.current.find((x) => x.id === nodeId) ?? n;
        openNextDraft({ ...now, source: Promise.resolve(nodeId) });
      }
    },
    [updateNodeImpl, openNextDraft]
  );

  const nextStepFromSelection = useCallback((): boolean => {
    const ids = [...selectedIdsRef.current];
    if (ids.length !== 1) return false;
    const n = nodesRef.current.find((x) => x.id === ids[0]);
    if (!n) return false;
    openNextDraft({ ...n, source: Promise.resolve(n.id) });
    return true;
  }, [openNextDraft]);

  const renameSelection = useCallback((): boolean => {
    const ids = [...selectedIdsRef.current];
    if (ids.length !== 1) return false;
    if (nodesRef.current.some((n) => n.id === ids[0])) {
      startRename(ids[0]);
      return true;
    }
    if (edgesRef.current.some((e) => e.id === ids[0])) {
      setEditingEdgeId(ids[0]);
      return true;
    }
    return false;
  }, [startRename]);

  const addShapeAtCenter = useCallback(
    (shape: PaletteShape) => {
      const svg = svgRef.current;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const centre = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      const lanes = laneBoxes();
      let slot = pointToLaneSlot(centre, lanes, shape);
      if (!slot) {
        const first = lanes.find((l) => !l.collapsed);
        if (!first) return;
        slot = {
          laneId: first.id,
          x: Math.max(52, centre.x - shape.w / 2),
          relativeY: Math.max(0, (first.h - shape.h) / 2),
        };
      }
      openDraft({
        ...slot,
        type: shape.backendType,
        via: "palette-click",
        defaultName: shape.defaultName,
        source: null,
      });
    },
    [toWorld, laneBoxes, openDraft]
  );

  const onSvgDoubleClick = (e: MouseEvent<SVGSVGElement>) => {
    if (tool !== "select") return;
    const target = e.target as SVGElement;
    const isBg =
      target === svgRef.current ||
      (target.tagName === "rect" && target.getAttribute("data-bg") === "1");
    if (!isBg) return;
    const size = sizeForNodeType("task");
    const slot = pointToLaneSlot(toWorld(e.clientX, e.clientY), laneBoxes(), size);
    if (!slot) return;
    openDraft({ ...slot, type: "task", via: "dblclick", defaultName: "New task", source: null });
  };

  // ── Selection toolbar ────────────────────────────────────────────────
  // Floats over a selection of two or more things. Its commands keep every
  // step in its lane, so they're cosmetic: one undo entry, no reason.

  // The canvas's pixel size, for keeping the toolbar on screen.
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver(() => {
      const r = svg.getBoundingClientRect();
      setCanvasSize({ w: r.width, h: r.height });
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);
  const [toolbarSize, setToolbarSize] = useState({ w: 520, h: 36 });
  const onToolbarSize = useCallback(
    (size: { w: number; h: number }) =>
      setToolbarSize((curr) => (curr.w === size.w && curr.h === size.h ? curr : size)),
    []
  );

  const selectedRenderNodes = useMemo(
    () => renderNodes.filter((n) => selectedIds.has(n.id)),
    [renderNodes, selectedIds]
  );
  const bendsToReset = useMemo(() => routesToReset(edges, selectedIds), [edges, selectedIds]);

  const alignSelection = (cmd: AlignCommand) => {
    const lanesById = new Map(displayLanesRef.current.map((l) => [l.id, l]));
    const picked = renderNodesRef.current.filter((n) => selectedIdsRef.current.has(n.id));
    const moves = alignItems(
      picked.map((n) => {
        const lane = n.laneId ? lanesById.get(n.laneId) : undefined;
        return {
          id: n.id,
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
          laneY: lane ? lane.y : null,
          laneH: lane ? lane.h : null,
        };
      }),
      cmd
    );
    if (moves.length === 0) return;
    const byId = new Map(nodesRef.current.map((n) => [n.id, n]));
    const before: NodePosition[] = moves.map((m) => {
      const n = byId.get(m.id)!;
      return { id: n.id, x: n.x, relativeY: n.relativeY, laneId: n.laneId };
    });
    const after: NodePosition[] = moves.map((m) => ({
      id: m.id,
      x: m.x,
      relativeY: m.relativeY,
      laneId: byId.get(m.id)!.laneId,
    }));
    applyGroupPositionsLocal(after);
    record({
      description: cmd.startsWith("distribute") ? "Space steps evenly" : "Align steps",
      do: () => applyGroupPositionsLocal(after),
      undo: () => applyGroupPositionsLocal(before),
    });
  };

  // Set connectors' bends (null clears one) and save them; used by Reset
  // routes and its undo/redo.
  const applyBendsLocal = useCallback(
    (bends: RouteReset[]) => {
      const byId = new Map(bends.map((b) => [b.id, b]));
      setEdges((curr) =>
        curr.map((e) => {
          const b = byId.get(e.id);
          return b ? { ...e, bendX: b.bendX, bendY: b.bendY } : e;
        })
      );
      return Promise.all(
        bends.map((b) =>
          api.updateEdge(projectId, b.id, { bend_x: b.bendX, bend_y: b.bendY })
        )
      ).then(
        () => undefined,
        (err) => {
          console.error("Failed to save connector routes", err);
          toast.error("Couldn't save the connector routes.");
        }
      );
    },
    [projectId]
  );

  const resetRoutes = () => {
    const before = routesToReset(edgesRef.current, selectedIdsRef.current);
    if (before.length === 0) return;
    const after = before.map((b) => ({ id: b.id, bendX: null, bendY: null }));
    void applyBendsLocal(after);
    record({
      description: "Reset routes",
      do: () => applyBendsLocal(after),
      undo: () => applyBendsLocal(before),
    });
  };

  const selectionToolbar = (() => {
    if (selectedIds.size < 2 || drag || editing || contextMenu || canvasSize.w === 0) return null;
    // The selection's on-screen box: its steps, or a selected connector's
    // end steps when only connectors are selected.
    let boxes: Box[] = selectedRenderNodes;
    if (boxes.length === 0) {
      const ends = new Set(
        edges.filter((e) => selectedIds.has(e.id)).flatMap((e) => [e.from, e.to])
      );
      boxes = renderNodes.filter((n) => ends.has(n.id));
    }
    const bounds = boundsOf(boxes);
    if (!bounds) return null;
    // Leave the connect handles (and their hover margin) uncovered.
    const pad = HANDLE_OFFSET + 8;
    const world = { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 };
    const { tx, ty, scale } = viewport;
    const pos = anchorToolbar(
      { x: world.x * scale + tx, y: world.y * scale + ty, w: world.w * scale, h: world.h * scale },
      toolbarSize,
      { width: canvasSize.w, height: canvasSize.h, occludedRight, top: 56 }
    );
    const laneIds = new Set(selectedRenderNodes.map((n) => n.laneId));
    return (
      <SelectionToolbar
        left={pos.left}
        top={pos.top}
        count={selectedIds.size}
        nodeCount={selectedRenderNodes.length}
        spansLanes={laneIds.size > 1}
        resetCount={bendsToReset.length}
        lanes={lanes.map((l) => ({ id: l.id, name: l.label }))}
        onSize={onToolbarSize}
        onAlign={alignSelection}
        onResetRoutes={resetRoutes}
        onMoveToLane={(laneId) => void moveSelectionToLaneImpl(laneId as UUID)}
        onCopy={copySelectionImpl}
        onDelete={() => void deleteSelectionImpl()}
      />
    );
  })();

  // Arrow-key nudging. Each press moves the steps and saves their position
  // at once. Presses in quick succession on the same selection are one
  // burst: the first records an undo entry and the rest extend it, so one
  // Ctrl+Z puts the steps back where the burst began. A burst ends when the
  // keys go quiet, the selection changes, or anything else lands on the undo
  // stack first.
  const nudgeBurstRef = useRef<{
    key: string;
    at: number;
    entry: { before: NodePosition[]; after: NodePosition[] };
    action: UndoAction;
  } | null>(null);

  const nudgeSelection = (e: KeyboardEvent): boolean => {
    const dir = arrowDirection(e.key);
    if (!dir) return false;
    const lanesById = new Map(displayLanesRef.current.map((l) => [l.id, l]));
    const selected = nodesRef.current.filter(
      (n) =>
        selectedIdsRef.current.has(n.id) &&
        !(n.laneId && lanesById.get(n.laneId)?.h === COLLAPSED_LANE_HEIGHT)
    );
    // Nothing to move: leave the arrows to scroll the page.
    if (selected.length === 0) return false;
    const key = selected.map((n) => n.id).sort().join(",");
    const now = Date.now();
    const prev = nudgeBurstRef.current;
    const burst =
      prev && prev.key === key && now - prev.at < NUDGE_BURST_MS && isLatest(prev.action)
        ? prev
        : null;
    const current: NodePosition[] =
      burst?.entry.after ??
      selected.map((n) => ({ id: n.id, x: n.x, relativeY: n.relativeY, laneId: n.laneId }));
    const heights = new Map(selected.map((n) => [n.id, n.h]));
    const step = e.shiftKey ? NUDGE_LARGE : NUDGE_SMALL;
    const { dx, dy } = clampNudge(
      current.map((p) => ({
        id: p.id,
        x: p.x,
        relativeY: p.relativeY,
        h: heights.get(p.id) ?? 0,
        laneH: p.laneId ? lanesById.get(p.laneId)?.h ?? null : null,
      })),
      dir.dx * step,
      dir.dy * step,
      LANE_HEADER_W
    );
    // At a lane edge: nothing moves, but the key is still ours — the page
    // shouldn't scroll instead.
    if (dx === 0 && dy === 0) return true;
    const after = current.map((p) => ({ ...p, x: p.x + dx, relativeY: p.relativeY + dy }));
    applyGroupPositionsLocal(after);
    if (burst) {
      burst.entry.after = after;
      burst.at = now;
      return true;
    }
    const entry = { before: current, after };
    const action: UndoAction = {
      description: after.length > 1 ? `Nudge ${after.length} steps` : "Nudge step",
      do: () => applyGroupPositionsLocal(entry.after),
      undo: () => applyGroupPositionsLocal(entry.before),
    };
    record(action);
    nudgeBurstRef.current = { key, at: now, entry, action };
    return true;
  };

  // Everything the keyboard can trigger, refreshed each render so the
  // once-registered key listener always calls current callbacks.
  shortcutActionsRef.current = {
    undo: () => void undo(),
    redo: () => void redo(),
    nudge: nudgeSelection,
    copy: copySelectionImpl,
    paste: () => void pasteClipboardImpl(),
    "select-all": () => setSelectedIds(new Set(renderNodesRef.current.map((n) => n.id))),
    "tool-select": () => setTool("select"),
    "tool-pan": () => setTool("pan"),
    "tool-connect": () => setTool("connect"),
    escape: () => {
      setTool("select");
      clearSelection();
    },
    delete: () => void deleteSelectionImpl(),
    "zoom-in": () => zoomByStep(ZOOM_STEP),
    "zoom-out": () => zoomByStep(1 / ZOOM_STEP),
    "zoom-reset": zoomReset,
    fit: fitContent,
    "zoom-selection": zoomToSelection,
    "next-step": nextStepFromSelection,
    rename: renameSelection,
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

  // The lane rail previews heights through `resizeLaneLocal` while dragging
  // and calls this once on release, so a whole drag is one undo step.
  const commitLaneResize = useCallback(
    (laneId: string, fromH: number, toH: number) => {
      const from = Math.max(MIN_LANE_HEIGHT, Math.round(fromH));
      const to = Math.max(MIN_LANE_HEIGHT, Math.round(toH));
      resizeLaneLocal(laneId, to);
      if (to === from) return;
      record({
        description: "Resize lane",
        do: () => resizeLaneLocal(laneId, to),
        undo: () => resizeLaneLocal(laneId, from),
      });
    },
    [resizeLaneLocal, record]
  );

  const renameLaneLocal = useCallback(
    (laneId: string, newName: string, reason: string) => {
      setLanes((curr) =>
        curr.map((l) => (l.id === laneId ? { ...l, label: newName } : l))
      );
      markLane(laneId, { name: newName, reason });
    },
    [markLane]
  );

  const renameLane = useCallback(
    async (laneId: string, newName: string) => {
      const old = lanesRef.current.find((l) => l.id === laneId);
      if (!old || old.label === newName) return;
      const oldName = old.label;
      const reason = await promptReason("Rename lane");
      if (reason === null) return;
      renameLaneLocal(laneId, newName, reason);
      const description = "Rename lane";
      record({
        description,
        do: () => renameLaneLocal(laneId, newName, `Redo of ${description}`),
        undo: () => renameLaneLocal(laneId, oldName, `Undo of ${description}`),
      });
    },
    [renameLaneLocal, record, promptReason]
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
      const reason = await promptReason(DELETE_LANE_LABEL, {
        destructive: true,
        description: DELETE_LANE_DESCRIPTION,
      });
      if (reason === null) return;
      // Flush pending PATCHes so we don't fire a 404 against a deleted lane.
      await flush();
      try {
        await api.deleteLane(projectId, laneId, { reason });
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
    [projectId, flush, promptReason]
  );

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <svg
        ref={svgRef}
        onMouseDown={onSvgMouseDown}
        onDoubleClick={onSvgDoubleClick}
        onContextMenu={openCanvasMenu}
        onDragOver={onCanvasDragOver}
        onDrop={onCanvasDrop}
        onPointerEnter={() => { pointerOverCanvasRef.current = true; }}
        onPointerLeave={() => {
          pointerOverCanvasRef.current = false;
          spaceHeld.current = false; // don't strand pan mode if Space is released off-canvas
        }}
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
          {/* Arrowheads are sized in world units (not stroke units) so a
            selected, thicker line keeps the same head; one per colour so the
            head always matches its line. */}
          {(
            [
              [MARKER.default, THEME.edge],
              [MARKER.selected, THEME.selection],
              [MARKER.rework, THEME.rework],
              [MARKER.proposed, THEME.proposed],
              ["poet-arrow-ink", THEME.ink],
            ] as const
          ).map(([id, color]) => (
            <marker
              key={id}
              id={id}
              markerUnits="userSpaceOnUse"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="10"
              markerHeight="10"
              orient="auto"
            >
              <path d="M 1 1 L 9 5 L 1 9 L 3 5 z" fill={color} />
            </marker>
          ))}
          <filter id={NODE_SHADOW_FILTER} x="-10%" y="-20%" width="120%" height="150%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.4" floodColor="#0f172a" floodOpacity="0.1" />
          </filter>
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
              {/* Lane colour is an accent (header strip + a thin edge), not a
                fill, so steps stand out from a near-white body. */}
              <rect
                data-bg="1"
                x={0}
                y={lane.y}
                width={worldWidth}
                height={lane.h}
                fill={lane.color}
                opacity={THEME.laneBodyOpacity}
              />
              <rect
                x={0}
                y={lane.y}
                width={44}
                height={lane.h}
                fill={lane.color}
                opacity={THEME.laneHeaderOpacity}
              />
              <rect
                x={0}
                y={lane.y}
                width={THEME.laneAccentWidth}
                height={lane.h}
                fill={laneAccent(lane.color)}
              />
              <line
                x1={0}
                y1={lane.y + lane.h}
                x2={worldWidth}
                y2={lane.y + lane.h}
                stroke={THEME.laneDivider}
              />
            </g>
          ))}
          {edges.map((edge) => {
            // Edges into collapsed lanes have no route: their end isn't drawn.
            const route = edgeRoutes.get(edge.id);
            if (!route) return null;
            const f = renderNodeById.get(edge.from);
            const t = renderNodeById.get(edge.to);
            return (
              <EdgeArrow
                key={edge.id}
                edge={edge}
                route={route}
                proposed={!!f && !!t && isEdgeProposed(f, t)}
                selected={selectedIds.has(edge.id)}
                onClick={(id) => selectOnly(id)}
                onDoubleClick={(id) => {
                  selectOnly(id);
                  setEditingEdgeId(id);
                }}
                onContextMenu={openEdgeMenu}
                onStartBendDrag={onStartBendDrag}
              />
            );
          })}
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
              onDoubleClick={startRename}
              onOpenSubprocess={onDrillIntoNode}
              hideLabel={editing?.kind === "rename" && editing.nodeId === node.id}
            />
          ))}
          {editing?.kind === "rename" &&
            (() => {
              const n = renderNodeById.get(editing.nodeId);
              if (!n) return null;
              return (
                <NodeLabelEditor
                  key={`rename-${n.id}`}
                  rect={n}
                  kind={n.kind}
                  initial={n.label}
                  onCommit={(text, trigger) => void onRenameCommit(n.id, text, trigger)}
                  onCancel={() => setEditing(null)}
                />
              );
            })()}
          {editing?.kind === "draft" &&
            (() => {
              const d = editing.draft;
              const lane = displayLanes.find((l) => l.id === d.laneId);
              if (!lane) return null;
              const rect = { x: d.x, y: lane.y + d.relativeY, w: d.w, h: d.h };
              const ghost = {
                fill: "#fff",
                stroke: THEME.selection,
                strokeWidth: 1.5,
                strokeDasharray: "5 4",
                pointerEvents: "none" as const,
              };
              return (
                <g key={`draft-${d.key}`}>
                  {d.sourceRect && (
                    <path
                      d={roundedPath(buildEdgePath(d.sourceRect, rect).points)}
                      fill="none"
                      stroke={THEME.selection}
                      strokeWidth={THEME.edgeWidth}
                      strokeDasharray="5 4"
                      markerEnd={`url(#${MARKER.selected})`}
                      pointerEvents="none"
                    />
                  )}
                  {d.kind === "gateway" ? (
                    <polygon
                      points={`${rect.x + rect.w / 2},${rect.y} ${rect.x + rect.w},${rect.y + rect.h / 2} ${rect.x + rect.w / 2},${rect.y + rect.h} ${rect.x},${rect.y + rect.h / 2}`}
                      {...ghost}
                    />
                  ) : d.kind === "start" || d.kind === "end" || d.kind === "intermediate" ? (
                    <circle cx={rect.x + rect.w / 2} cy={rect.y + rect.h / 2} r={rect.w / 2} {...ghost} />
                  ) : (
                    <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={THEME.nodeRadius} {...ghost} />
                  )}
                  <NodeLabelEditor
                    rect={rect}
                    kind={d.kind}
                    initial=""
                    placeholder={d.via === "palette-drop" ? d.defaultName : "Name this step"}
                    onCommit={(text, trigger) => onDraftCommit(d, text, trigger)}
                    onCancel={() => onDraftCommit(d, "", "escape")}
                  />
                </g>
              );
            })()}
          {flashId && (() => {
            const pulse = (
              <animate attributeName="opacity" values="1;0.2;1" dur="0.7s" repeatCount="2" />
            );
            const fn = renderNodes.find((n) => n.id === flashId);
            if (fn) {
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
                  {pulse}
                </rect>
              );
            }
            // Edge flash: pulse a marker at the edge midpoint so navigateTo to an
            // edge gives the same visual confirmation a node does.
            const fe = edges.find((e) => e.id === flashId);
            if (fe) {
              const route = edgeRoutes.get(fe.id);
              if (!route) return null;
              const { x: midX, y: midY } = route.labelAt;
              return (
                <rect
                  x={midX - 22}
                  y={midY - 14}
                  width={44}
                  height={28}
                  rx={8}
                  fill="none"
                  stroke="#6366f1"
                  strokeWidth={3}
                  className="pointer-events-none"
                >
                  {pulse}
                </rect>
              );
            }
            return null;
          })()}
          {editingEdgeId &&
            (() => {
              const edge = edges.find((e) => e.id === editingEdgeId);
              if (!edge) return null;
              // Open where the label is actually drawn — including on bent and
              // rework edges, which plain routing would place elsewhere.
              const route = edgeRoutes.get(edge.id);
              if (!route) return null;
              const { x: midX, y: midY } = route.labelAt;
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
              // Use the same picker as the drop so the preview matches the result.
              const candidates: Rect[] = renderNodes
                .filter((n) => n.id !== drag.sourceId)
                .map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.w, height: n.h }));
              const targetId = pickDropTarget({ x: drag.currX, y: drag.currY }, candidates, DROP_TOLERANCE);
              const target = targetId
                ? renderNodes.find((n) => n.id === targetId)
                : undefined;
              const backtrack = !!target && isBacktrack(source, target);
              let d: string;
              if (target && backtrack) {
                const { sourceSide, targetSide } = deriveLoopSides(
                  drag.sourceSide,
                  drag.currY,
                  target
                );
                d = roundedPath(buildEdgePath(source, target, { sourceSide, targetSide }).points);
              } else if (target) {
                d = roundedPath(buildEdgePath(source, target).points);
              } else {
                d = buildPreviewToCursor(
                  source,
                  drag.sourceSide,
                  drag.currX,
                  drag.currY
                );
              }
              return (
                <path
                  d={d}
                  fill="none"
                  stroke={backtrack ? THEME.rework : THEME.ink}
                  strokeWidth={THEME.edgeWidth}
                  strokeDasharray="4 4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd={
                    backtrack ? `url(#${MARKER.rework})` : "url(#poet-arrow-ink)"
                  }
                  pointerEvents="none"
                />
              );
            })()}
          {snapGuides.map((g, i) => (
            <line
              key={`guide-${i}`}
              className="snap-guide"
              x1={g.axis === "x" ? g.at : g.from - 12}
              x2={g.axis === "x" ? g.at : g.to + 12}
              y1={g.axis === "y" ? g.at : g.from - 12}
              y2={g.axis === "y" ? g.at : g.to + 12}
              stroke={THEME.guide}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ))}
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
        onResizeLanePreview={resizeLaneLocal}
        onResizeLane={commitLaneResize}
        onRenameLane={renameLane}
        onAddLaneAt={addLaneAt}
        onDeleteLane={deleteLane}
        onSetColor={setLaneColor}
        collapsedLaneIds={collapsedLaneIds}
        onToggleCollapse={toggleLaneCollapse}
      />

      <ShapePalette onAddShape={addShapeAtCenter} />

      {selectionToolbar}

      {/* end SVG */}
      <FloatingToolbar
        tool={tool}
        onToolChange={setTool}
        viewport={viewport}
        onZoomIn={() => zoomByStep(ZOOM_STEP)}
        onZoomOut={() => zoomByStep(1 / ZOOM_STEP)}
        onFit={fitContent}
        wheelMode={wheelMode}
        onWheelModeChange={changeWheelMode}
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

      <ReasonPromptDialog {...reasonPrompt} />
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
