"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BpmnCanvas, type BpmnCanvasHandle, type CanvasSelection } from "@/components/canvas/bpmn-canvas";
import { PropertiesPanel } from "@/components/canvas/properties-panel";
import { RightPanel } from "@/components/canvas/right-panel";
import { buildCanvasState } from "@/components/canvas/layout";
import type { SaveStatus } from "@/components/canvas/use-persistence";
import { api } from "@/lib/api";
import type { IssueSeverity, UUID } from "@/lib/types";

const STATUS_LABEL: Record<SaveStatus, string> = {
  idle: "Saved",
  dirty: "Unsaved",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

const STATUS_COLOR: Record<SaveStatus, string> = {
  idle: "#64748b",
  dirty: "#a16207",
  saving: "#0369a1",
  saved: "#166534",
  error: "#dc2626",
};

export default function CanvasPage() {
  const params = useParams<{
    id: string;
    modelId: string;
    versionId: string;
  }>();
  const [showXml, setShowXml] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CanvasSelection>({ kind: "none" });
  // The right panel is always present; only its collapsed/expanded state
  // varies. Lifting it to the page so the Properties panel can shift as
  // the right panel changes width.
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // Properties panel collapse state lifted so the page can resize the
  // wrapper to a small button when collapsed.
  const [propertiesCollapsed, setPropertiesCollapsed] = useState(false);
  const [counts, setCounts] = useState<{ lanes: number; nodes: number; edges: number } | null>(null);
  const handleCountsChange = useCallback(
    (c: { lanes: number; nodes: number; edges: number }) => setCounts(c),
    []
  );
  const canvasRef = useRef<BpmnCanvasHandle>(null);
  const queryClient = useQueryClient();

  const handleNodeDelete = useCallback(
    async (id: UUID) => {
      if (!canvasRef.current) return;
      await canvasRef.current.deleteNode(id);
      setSelected({ kind: "none" });
    },
    []
  );

  const handleNodeUpdate = useCallback(
    async (id: UUID, patch: { name?: string; laneId?: UUID }) => {
      if (!canvasRef.current) return;
      await canvasRef.current.updateNode(id, patch);
      // Reflect the new label/lane in the panel without forcing a re-select.
      setSelected((curr) =>
        curr.kind === "node" && curr.id === id
          ? {
              ...curr,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.laneId !== undefined ? { laneId: patch.laneId } : {}),
            }
          : curr
      );
    },
    []
  );

  const handleNodeDeleted = useCallback(
    (_id: UUID) => {
      setSelected({ kind: "none" });
      queryClient.invalidateQueries({
        queryKey: ["issues", params.id, params.modelId, params.versionId],
      });
    },
    [queryClient, params.id, params.modelId, params.versionId]
  );

  const handleSaveStatusChange = useCallback(
    (status: SaveStatus, error: string | null) => {
      setSaveStatus(status);
      setSaveError(error);
    },
    []
  );

  const handleSelectionChange = useCallback((s: CanvasSelection) => {
    setSelected(s);
    if (s.kind === "node") setPropertiesCollapsed(false);
  }, []);

  const { data, isLoading, error } = useQuery({
    queryKey: ["graph", params.id, params.modelId, params.versionId],
    queryFn: () =>
      api.getProcessGraph(params.id, params.modelId, params.versionId),
  });

  const { data: issues } = useQuery({
    queryKey: ["issues", params.id, params.modelId, params.versionId],
    queryFn: () =>
      api.getProcessMapIssues(params.id, params.modelId, params.versionId),
    enabled: !!data,
  });

  const issuesByNode = useMemo<Record<string, IssueSeverity>>(() => {
    if (!issues) return {};
    const out: Record<string, IssueSeverity> = {};
    for (const i of issues) out[i.node_id] = i.severity;
    return out;
  }, [issues]);

  const initial = useMemo(
    () => (data ? buildCanvasState(data) : null),
    [data]
  );

  const selectedNode = selected.kind === "node" ? selected : null;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Top floating bar */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          right: 12,
          zIndex: 30,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Button asChild size="sm" variant="secondary">
            <Link href={`/projects/${params.id}/maps`}>
              <ArrowLeft size={14} />
              Maps
            </Link>
          </Button>
          {data && (
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "6px 12px",
                background: "rgba(255,255,255,0.96)",
                borderRadius: 8,
                border: "1px solid #e2e8f0",
                boxShadow:
                  "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
                fontSize: 12,
              }}
            >
              <span style={{ fontWeight: 600 }}>{counts?.lanes ?? data.lanes.length} lanes</span>
              <span style={{ color: "#94a3b8" }}>·</span>
              <span style={{ fontWeight: 600 }}>{counts?.nodes ?? data.nodes.length} nodes</span>
              <span style={{ color: "#94a3b8" }}>·</span>
              <span style={{ fontWeight: 600 }}>{counts?.edges ?? data.edges.length} edges</span>
              <span style={{ color: "#94a3b8" }}>·</span>
              <Badge variant="outline">v{data.version.version_number}</Badge>
              <Badge variant="secondary">{data.version.status}</Badge>
            </div>
          )}
        </div>
        <div
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <SaveIndicator status={saveStatus} error={saveError} />
          <Button
            size="sm"
            variant="outline"
            disabled={!data?.version.bpmn_xml}
            onClick={() => setShowXml(true)}
          >
            BPMN XML
          </Button>
        </div>
      </div>

      {isLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#64748b",
          }}
        >
          Loading map…
        </div>
      )}
      {error && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#dc2626",
          }}
        >
          {(error as Error).message}
        </div>
      )}
      {initial && (
        <BpmnCanvas
          ref={canvasRef}
          projectId={params.id}
          modelId={params.modelId}
          versionId={params.versionId}
          initialNodes={initial.nodes}
          initialEdges={initial.edges}
          initialLanes={initial.lanes}
          issuesByNode={issuesByNode}
          onSaveStatusChange={handleSaveStatusChange}
          onSelectionChange={handleSelectionChange}
          onNodeDeleted={handleNodeDeleted}
          onCountsChange={handleCountsChange}
        />
      )}

      {/* Per-selection Properties panel — floats right, sits to the LEFT
          of the always-visible RightPanel. Shifts based on whether the
          right panel is collapsed (40px) or expanded (360px). When
          collapsed, the wrapper sizes down to just the small expand
          button (no full-height column). */}
      {selectedNode && data && (
        <div
          style={{
            position: "absolute",
            right: rightCollapsed ? 64 : 384,
            top: 60,
            ...(propertiesCollapsed
              ? { height: 36 }
              : { bottom: 60 }),
            zIndex: 25,
            display: "flex",
            transition: "right 150ms ease",
          }}
        >
          <PropertiesPanel
            projectId={params.id}
            selected={selectedNode}
            lanes={data.lanes}
            collapsed={propertiesCollapsed}
            onCollapsedChange={setPropertiesCollapsed}
            onDelete={handleNodeDelete}
            onUpdate={handleNodeUpdate}
          />
        </div>
      )}

      {/* Tabbed right panel — always visible, anchored to the right edge.
          User collapses it via the chevron inside the panel. */}
      {data && (
        <div
          style={{
            position: "absolute",
            right: 12,
            top: 60,
            bottom: 60,
            zIndex: 26,
            display: "flex",
            transition: "width 150ms ease",
          }}
        >
          <RightPanel
            projectId={params.id}
            modelId={params.modelId}
            versionId={params.versionId}
            version={data.version}
            nodes={data.nodes.map((n) => ({
              id: n.id,
              name: n.name,
              type: n.type,
              lane_id: n.lane_id,
            }))}
            selected={
              selected.kind === "node"
                ? { id: selected.id, kind: "node", name: selected.name, nodeKind: selected.nodeKind }
                : selected.kind === "edge"
                  ? { id: selected.id, kind: "edge" }
                  : null
            }
            onFocusNode={(id) => canvasRef.current?.selectNode(id)}
            collapsed={rightCollapsed}
            onCollapsedChange={setRightCollapsed}
          />
        </div>
      )}

      <Dialog open={showXml} onOpenChange={setShowXml}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>BPMN 2.0 XML</DialogTitle>
            <DialogDescription>
              Reflects the original generation. Canvas edits don&apos;t
              regenerate the XML yet — paste into bpmn.io for full BPMN
              viewer rendering.
            </DialogDescription>
          </DialogHeader>
          <textarea
            readOnly
            value={data?.version.bpmn_xml ?? ""}
            className="h-[60vh] w-full resize-none rounded-md border bg-slate-50 p-3 font-mono text-xs"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SaveIndicator({
  status,
  error,
}: {
  status: SaveStatus;
  error: string | null;
}) {
  return (
    <div
      title={error ?? STATUS_LABEL[status]}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        background: "rgba(255,255,255,0.96)",
        borderRadius: 8,
        border: "1px solid #e2e8f0",
        fontSize: 12,
        color: STATUS_COLOR[status],
        boxShadow:
          "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: STATUS_COLOR[status],
          opacity: status === "saving" ? 0.6 : 1,
        }}
      />
      {STATUS_LABEL[status]}
    </div>
  );
}
