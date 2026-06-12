import type { UUID } from "@/lib/types";

export type CanvasNodeKind =
  | "start"
  | "end"
  | "intermediate"
  | "task"
  | "user"
  | "service"
  | "manual"
  | "send"
  | "receive"
  | "gateway"
  | "subprocess";

/**
 * Storage shape: a node's vertical position is stored as an offset from the
 * top of its assigned lane (`relativeY`), not an absolute world Y. The
 * absolute Y is derived at render time as `lane.y + relativeY`. This means
 * (a) when a lane is reordered or resized, its nodes follow automatically,
 * and (b) dragging a node into a different lane is just a matter of
 * re-assigning its `laneId` and recomputing `relativeY` against the new lane.
 */
export interface CanvasNode {
  id: UUID;
  /** Backend NodeType string, e.g. "task", "gateway_exclusive". Preserved
   * so copy/paste recreates the exact type (kind alone is lossy). */
  type: string;
  kind: CanvasNodeKind;
  label: string;
  laneId: UUID | null;
  x: number;
  relativeY: number;
  w: number;
  h: number;
  /** True when this node was created by an AI proposal (properties.ai_proposed).
   * Drives distinct rendering. */
  aiProposed?: boolean;
  /** Optional free-text description (properties.description). */
  description?: string;
  /** True when SP-7c reconcile flagged this node's evidence as stale
   * (properties.evidence_stale). Frontend-read-only badge. */
  evidenceStale?: boolean;
}

/** Resolved node with absolute world Y, used for SVG rendering. */
export type ResolvedNode = Omit<CanvasNode, "relativeY"> & { y: number };

export interface CanvasEdge {
  id: UUID;
  from: UUID;
  to: UUID;
  label: string | null;
  /** Optional user-set X-coordinate of the vertical mid-segment when the
   * edge routes horizontally. */
  bendX?: number | null;
  /** Y-coordinate of the horizontal mid-segment for vertical-routed edges. */
  bendY?: number | null;
}

export interface CanvasLane {
  id: UUID;
  label: string;
  color: string;
  collapsed: boolean;
  y: number;
  h: number;
}

export interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}
