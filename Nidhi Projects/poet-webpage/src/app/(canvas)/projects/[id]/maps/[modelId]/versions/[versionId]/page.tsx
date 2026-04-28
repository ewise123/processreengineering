"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
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
import { buildCanvasState } from "@/components/canvas/layout";
import { api } from "@/lib/api";

export default function CanvasPage() {
  const params = useParams<{
    id: string;
    modelId: string;
    versionId: string;
  }>();
  const [showXml, setShowXml] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["graph", params.id, params.modelId, params.versionId],
    queryFn: () =>
      api.getProcessGraph(params.id, params.modelId, params.versionId),
  });

  const initial = useMemo(
    () => (data ? buildCanvasState(data) : null),
    [data]
  );

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Top bar — overlaid on the canvas */}
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
        <div style={{ pointerEvents: "auto" }}>
          <Button
            size="sm"
            variant="outline"
            disabled={!data?.version.bpmn_xml}
            onClick={() => setShowXml(true)}
          >
            Show BPMN XML
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
          initialNodes={initial.nodes}
          initialEdges={initial.edges}
          initialLanes={initial.lanes}
        />
      )}

      {/* Hint footer */}
      <div
        style={{
          position: "absolute",
          bottom: 12,
          left: "50%",
          transform: "translateX(-50%)",
          padding: "4px 10px",
          background: "rgba(255,255,255,0.9)",
          border: "1px solid #e2e8f0",
          borderRadius: 6,
          fontSize: 11,
          color: "#64748b",
          pointerEvents: "none",
          zIndex: 20,
        }}
      >
        Drag nodes · Hover a lane to drag/resize · Wheel to pan · Cmd+wheel to
        zoom · Edits are local until persistence lands
      </div>

      <Dialog open={showXml} onOpenChange={setShowXml}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>BPMN 2.0 XML</DialogTitle>
            <DialogDescription>
              Canonical machine-readable export. Paste into bpmn.io for full
              BPMN viewer rendering, or hand to a downstream tool.
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
