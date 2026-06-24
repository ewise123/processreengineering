"use client";

import { ArrowLeft } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AiEditCacheProvider } from "@/components/canvas/ai-edit-cache";
import { BpmnCanvas, type BpmnCanvasHandle, type CanvasSelection } from "@/components/canvas/bpmn-canvas";
import { PropertiesPanel } from "@/components/canvas/properties-panel";
import { RightPanel } from "@/components/canvas/right-panel";
import type { SelectedObject } from "@/components/canvas/chat-context";
import { buildCanvasState } from "@/components/canvas/layout";
import { reviewByNodeMap } from "@/components/canvas/review-summary";
import type { SaveStatus } from "@/components/canvas/use-persistence";
import { api } from "@/lib/api";
import type { IssueSeverity, NodeReviewUpdate, ReviewDecision, UUID, ViewerTarget } from "@/lib/types";

// react-pdf / pdfjs reference browser-only globals at module eval, which crash
// server-side rendering. Load the viewer client-only so the page route never
// imports pdfjs on the server.
const DocumentViewer = dynamic(
  () => import("@/components/canvas/document-viewer").then((m) => m.DocumentViewer),
  { ssr: false },
);

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
  const [viewerTarget, setViewerTarget] = useState<ViewerTarget | null>(null);
  const [viewerExpanded, setViewerExpanded] = useState(true);
  const [counts, setCounts] = useState<{ lanes: number; nodes: number; edges: number } | null>(null);
  const handleCountsChange = useCallback(
    (c: { lanes: number; nodes: number; edges: number }) => setCounts(c),
    []
  );
  const canvasRef = useRef<BpmnCanvasHandle>(null);
  const queryClient = useQueryClient();
  const router = useRouter();

  const handleNavigateVersion = useCallback(
    (newVersionId: UUID) => {
      router.push(
        `/projects/${params.id}/maps/${params.modelId}/versions/${newVersionId}`
      );
    },
    [router, params.id, params.modelId]
  );

  const handleNodeDelete = useCallback(
    async (id: UUID) => {
      if (!canvasRef.current) return;
      await canvasRef.current.deleteNode(id);
      setSelected({ kind: "none" });
    },
    []
  );

  const handleNodeUpdate = useCallback(
    async (id: UUID, patch: { name?: string; laneId?: UUID; type?: string; description?: string }) => {
      if (!canvasRef.current) return;
      await canvasRef.current.updateNode(id, patch);
      // Reflect the new label/lane/type/description in the panel without forcing a re-select.
      setSelected((curr) =>
        curr.kind === "node" && curr.id === id
          ? {
              ...curr,
              ...(patch.name !== undefined ? { name: patch.name } : {}),
              ...(patch.laneId !== undefined ? { laneId: patch.laneId } : {}),
              ...(patch.type !== undefined ? { type: patch.type } : {}),
              ...(patch.description !== undefined ? { description: patch.description } : {}),
            }
          : curr
      );
    },
    []
  );

  const handleAddStep = useCallback(
    async (
      sourceId: UUID,
      step: { proposed_name: string; proposed_type: string; edge_label: string | null; cited_claim_ids: UUID[] }
    ) => {
      await canvasRef.current?.addProposedStep({
        sourceId,
        name: step.proposed_name,
        type: step.proposed_type,
        citedClaimIds: step.cited_claim_ids,
        edgeLabel: step.edge_label,
      });
    },
    []
  );

  const handleNodeDeleted = useCallback(
    (_id: UUID) => {
      setSelected({ kind: "none" });
      // A delete changes issue badges, the graph node set, and the review
      // rollup (counts/buckets/meter) — refresh all three so no surface
      // counts a node that no longer exists.
      for (const key of ["issues", "graph", "review"]) {
        queryClient.invalidateQueries({
          queryKey: [key, params.id, params.modelId, params.versionId],
        });
      }
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

  const { data: reviewState } = useQuery({
    queryKey: ["review", params.id, params.modelId, params.versionId],
    queryFn: () => api.getReviewState(params.id, params.modelId, params.versionId),
    enabled: !!data,
  });

  const reviewByNode = useMemo<Record<string, ReviewDecision>>(
    () => reviewByNodeMap(reviewState?.nodes ?? []),
    [reviewState]
  );

  const invalidateReview = () =>
    queryClient.invalidateQueries({
      queryKey: ["review", params.id, params.modelId, params.versionId],
    });

  const setNodeReviewMutation = useMutation({
    mutationFn: (vars: { nodeId: UUID; body: NodeReviewUpdate }) =>
      api.setNodeReview(params.id, vars.nodeId, vars.body),
    onSuccess: invalidateReview,
  });

  const requestReviewMutation = useMutation({
    mutationFn: () => api.requestReview(params.id, params.modelId, params.versionId),
    onSuccess: invalidateReview,
  });

  const initial = useMemo(
    () => (data ? buildCanvasState(data) : null),
    [data]
  );

  const selectedNode = selected.kind === "node" ? selected : null;

  // Every selected object, flattened for the chat context tab (supports
  // multi-select; node labels resolved from the loaded graph).
  const chatSelected: SelectedObject[] = useMemo(() => {
    if (selected.kind === "node")
      return [{ id: selected.id, kind: "node", name: selected.name }];
    if (selected.kind === "multi") {
      const nameById = new Map((data?.nodes ?? []).map((n) => [n.id, n.name]));
      return selected.nodeIds.map((id) => ({ id, kind: "node" as const, name: nameById.get(id) }));
    }
    return [];
  }, [selected, data]);

  return (
    <AiEditCacheProvider>
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
          reviewByNode={reviewByNode}
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
            modelId={params.modelId}
            versionId={params.versionId}
            selected={selectedNode}
            lanes={data.lanes}
            collapsed={propertiesCollapsed}
            onCollapsedChange={setPropertiesCollapsed}
            onDelete={handleNodeDelete}
            onUpdate={handleNodeUpdate}
            onAddStep={handleAddStep}
            onOpenSource={(target) => {
              setViewerTarget(target);
              setViewerExpanded(true);
            }}
            review={
              selectedNode
                ? {
                    status: reviewByNode[selectedNode.id] ?? null,
                    onApprove: () =>
                      setNodeReviewMutation.mutate({
                        nodeId: selectedNode.id,
                        body: { status: "approved" },
                      }),
                    onRequestChange: (note?: string) =>
                      setNodeReviewMutation.mutate({
                        nodeId: selectedNode.id,
                        body: { status: "changes_requested", note },
                      }),
                  }
                : undefined
            }
          />
        </div>
      )}

      {selected.kind === "multi" && data && (
        <div
          style={{
            position: "absolute",
            right: rightCollapsed ? 64 : 384,
            top: 60,
            zIndex: 25,
            transition: "right 150ms ease",
          }}
        >
          <BulkActionBar
            count={selected.nodeIds.length + selected.edgeIds.length}
            lanes={data.lanes.map((l) => ({ id: l.id, name: l.name }))}
            onDelete={() => canvasRef.current?.deleteSelection()}
            onCopy={() => canvasRef.current?.copySelection()}
            onMoveToLane={(laneId) => canvasRef.current?.moveSelectionToLane(laneId as UUID)}
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
            nodes={data.nodes.map((n) => ({
              id: n.id,
              name: n.name,
              type: n.type,
              lane_id: n.lane_id,
            }))}
            selected={chatSelected}
            onFocusNode={(id) => canvasRef.current?.selectNode(id)}
            onNavigate={(refTarget) => canvasRef.current?.navigateTo(refTarget)}
            onClearSelection={() => canvasRef.current?.clearSelection()}
            onRemoveContext={(id) => canvasRef.current?.deselectId(id)}
            reviewState={reviewState}
            onSendRequest={() => requestReviewMutation.mutate()}
            onNavigateVersion={handleNavigateVersion}
            onOpenSource={(target) => {
              setViewerTarget(target);
              setViewerExpanded(true);
            }}
            collapsed={rightCollapsed}
            onCollapsedChange={setRightCollapsed}
          />
        </div>
      )}

      {/* Source document viewer — floats over the canvas at single/double
          width; opened from citation cards or the Sources tab. */}
      {viewerTarget && (
        <div
          style={{
            position: "absolute",
            right: rightCollapsed ? 64 : 384,
            top: 60,
            bottom: 60,
            zIndex: 30,
            display: "flex",
          }}
        >
          <DocumentViewer
            key={viewerTarget.inputId}
            projectId={params.id}
            target={viewerTarget}
            expanded={viewerExpanded}
            onToggleExpanded={() => setViewerExpanded((v) => !v)}
            onClose={() => setViewerTarget(null)}
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
    </AiEditCacheProvider>
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

function BulkActionBar({
  count,
  lanes,
  onDelete,
  onCopy,
  onMoveToLane,
}: {
  count: number;
  lanes: { id: string; name: string }[];
  onDelete: () => void;
  onCopy: () => void;
  onMoveToLane: (laneId: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        background: "rgba(255,255,255,0.98)",
        borderRadius: 8,
        border: "1px solid #e2e8f0",
        boxShadow: "0 8px 28px -8px rgba(15,23,42,0.18)",
        fontSize: 13,
        height: 44,
      }}
    >
      <span style={{ fontWeight: 600 }}>{count} selected</span>
      <span style={{ color: "#94a3b8" }}>·</span>
      <Button size="sm" variant="outline" onClick={onCopy}>
        Copy
      </Button>
      <select
        defaultValue=""
        onChange={(e) => {
          if (e.target.value) {
            onMoveToLane(e.target.value);
            e.target.value = "";
          }
        }}
        style={{
          height: 32,
          borderRadius: 6,
          border: "1px solid #e2e8f0",
          fontSize: 12,
          padding: "0 6px",
        }}
      >
        <option value="" disabled>
          Move to lane…
        </option>
        {lanes.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <Button size="sm" variant="destructive" onClick={onDelete}>
        Delete
      </Button>
    </div>
  );
}
