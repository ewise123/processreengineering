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

export interface CanvasNode {
  id: UUID;
  kind: CanvasNodeKind;
  label: string;
  laneId: UUID | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasEdge {
  id: UUID;
  from: UUID;
  to: UUID;
  label: string | null;
}

export interface CanvasLane {
  id: UUID;
  label: string;
  color: string;
  y: number;
  h: number;
}

export interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}
