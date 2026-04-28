"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";

import type { ProcessGraph } from "@/lib/types";
import { CANVAS_CONSTANTS, layoutGraph } from "@/lib/canvas-layout";

const KIND_LABELS: Record<string, string> = {
  task: "Task",
  subprocess: "Subprocess",
  event_start: "Start",
  event_end: "End",
  event_intermediate: "Event",
  gateway_exclusive: "XOR",
  gateway_parallel: "AND",
  gateway_inclusive: "OR",
};

function BpmnTaskNode({ data }: NodeProps) {
  const label = (data as { label?: string }).label ?? "";
  const kind = (data as { kind?: string }).kind ?? "task";
  return (
    <div className="rounded-md border-2 border-blue-300 bg-blue-50 px-3 py-2 text-xs shadow-sm">
      <Handle type="target" position={Position.Left} />
      <div className="font-medium leading-tight text-blue-950">{label}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-blue-700/70">
        {KIND_LABELS[kind] ?? kind}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function BpmnGatewayNode({ data }: NodeProps) {
  const label = (data as { label?: string }).label ?? "";
  const kind = (data as { kind?: string }).kind ?? "gateway_exclusive";
  const symbol = kind === "gateway_parallel" ? "+" : kind === "gateway_inclusive" ? "○" : "×";
  return (
    <div className="relative flex h-[60px] w-[60px] items-center justify-center" title={label}>
      <Handle type="target" position={Position.Left} />
      <div className="absolute inset-0 rotate-45 rounded-sm border-2 border-amber-400 bg-amber-50 shadow-sm" />
      <span className="relative text-lg font-semibold text-amber-900">{symbol}</span>
      <Handle type="source" position={Position.Right} />
      <div className="absolute -top-5 left-1/2 max-w-[160px] -translate-x-1/2 truncate text-[10px] text-amber-900/80">
        {label}
      </div>
    </div>
  );
}

function BpmnEventNode({ data }: NodeProps) {
  const kind = (data as { kind?: string }).kind ?? "event_start";
  const isStart = kind === "event_start";
  const isEnd = kind === "event_end";
  const ring = isEnd ? "border-[3px] border-rose-500" : "border-2 border-emerald-500";
  const tint = isStart ? "bg-emerald-50" : isEnd ? "bg-rose-50" : "bg-slate-50";
  const label = (data as { label?: string }).label ?? "";
  return (
    <div className={`flex h-[50px] w-[50px] items-center justify-center rounded-full ${ring} ${tint} shadow-sm`} title={label}>
      <Handle type="target" position={Position.Left} />
      <span className="text-[10px] font-medium text-slate-700">
        {KIND_LABELS[kind] ?? kind}
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = {
  bpmnTask: BpmnTaskNode,
  bpmnGateway: BpmnGatewayNode,
  bpmnEvent: BpmnEventNode,
};

export function ProcessCanvas({ graph }: { graph: ProcessGraph }) {
  const { nodes, edges, laneOrder } = useMemo(() => layoutGraph(graph), [graph]);

  return (
    <ReactFlowProvider>
      <div className="relative h-[70vh] w-full rounded-md border bg-slate-50">
        {/* Lane labels — overlaid on the left, scroll-locked to ReactFlow's transform */}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.3}
          maxZoom={2}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls position="bottom-right" />
          <MiniMap pannable zoomable position="bottom-left" />
        </ReactFlow>
        {/* Static lane legend — sits over the canvas, fixed at top-left */}
        <div className="pointer-events-none absolute left-2 top-2 space-y-1 rounded bg-white/80 p-2 text-xs shadow-sm backdrop-blur">
          <div className="font-medium text-slate-700">Lanes</div>
          {laneOrder.map((l, idx) => (
            <div key={l.id} className="flex items-center gap-2">
              <div
                className="h-2 w-2 rounded-full"
                style={{ background: laneColor(idx) }}
              />
              <span className="text-slate-600">{l.name}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Auto-layout via Dagre with lane-Y override. Lane bands of{" "}
        {CANVAS_CONSTANTS.LANE_HEIGHT}px. Click "Show BPMN XML" above for the
        canonical output.
      </p>
    </ReactFlowProvider>
  );
}

const LANE_PALETTE = [
  "#0ea5e9",
  "#22c55e",
  "#a855f7",
  "#f59e0b",
  "#ec4899",
  "#14b8a6",
  "#ef4444",
  "#6366f1",
];
function laneColor(idx: number): string {
  return LANE_PALETTE[idx % LANE_PALETTE.length];
}
