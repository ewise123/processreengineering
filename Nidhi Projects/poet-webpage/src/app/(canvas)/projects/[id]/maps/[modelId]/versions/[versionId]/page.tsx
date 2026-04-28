"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BpmnCanvas } from "@/components/canvas/bpmn-canvas";
import { PropertiesPanel } from "@/components/canvas/properties-panel";
import { buildCanvasState } from "@/components/canvas/layout";
import type { SaveStatus } from "@/components/canvas/use-persistence";
import { api } from "@/lib/api";
import type { IssueSeverity } from "@/lib/types";

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

type Selected =
  | {
      id: string;
      kind: "node" | "edge";
      name?: string;
      nodeKind?: string;
      laneId?: string | null;
    }
  | null;

export default function CanvasPage() {
  const params = useParams<{
    id: string;
    modelId: string;
    versionId: string;
  }>();
  const [showXml, setShowXml] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected>(null);

  const handleSaveStatusChange = useCallback(
    (status: SaveStatus, error: string | null) => {
      setSaveStatus(status);
      setSaveError(error);
    },
    []
  );

  const handleSelectionChange = useCallback((s: Selected) => {
    setSelected(s);
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

  const selectedNode = selected?.kind === "node" ? selected : null;

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
              <span style={{ fontWeight: 600 }}>{data.lanes.length} lanes</span>
              <span style={{ color: "#94a3b8" }}>·</span>
              <span style={{ fontWeight: 600 }}>{data.nodes.length} nodes</span>
              <span style={{ color: "#94a3b8" }}>·</span>
              <span style={{ fontWeight: 600 }}>{data.edges.length} edges</span>
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
          projectId={params.id}
          modelId={params.modelId}
          versionId={params.versionId}
          initialNodes={initial.nodes}
          initialEdges={initial.edges}
          initialLanes={initial.lanes}
          issuesByNode={issuesByNode}
          onSaveStatusChange={handleSaveStatusChange}
          onSelectionChange={handleSelectionChange}
        />
      )}

      {/* Per-selection Properties panel — auto-shown when a node is selected.
          Matches the prototype's poet-props layout: floating right, single panel. */}
      {selectedNode && data && (
        <div
          style={{
            position: "absolute",
            right: 12,
            top: 60,
            bottom: 60,
            zIndex: 25,
            display: "flex",
          }}
        >
          <PropertiesPanel
            projectId={params.id}
            selected={selectedNode}
            lanes={data.lanes}
            onClose={() => setSelected(null)}
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
