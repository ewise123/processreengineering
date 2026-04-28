"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
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
import { ProcessCanvas } from "@/components/process-canvas";
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            <Link href={`/projects/${params.id}/maps`} className="hover:underline">
              Maps
            </Link>
          </p>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">
              Process map
            </h2>
            {data && (
              <>
                <Badge variant="outline">v{data.version.version_number}</Badge>
                <Badge variant="secondary">{data.version.status}</Badge>
              </>
            )}
          </div>
          {data?.version.notes && (
            <p className="text-xs text-muted-foreground">{data.version.notes}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!data?.version.bpmn_xml}
            onClick={() => setShowXml(true)}
          >
            Show BPMN XML
          </Button>
        </div>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading map…</p>
      )}
      {error && (
        <p className="text-sm text-red-600">{(error as Error).message}</p>
      )}

      {data && (
        <>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">{data.lanes.length}</span>{" "}
              lane{data.lanes.length === 1 ? "" : "s"}
            </span>
            <span>·</span>
            <span>
              <span className="font-medium text-foreground">{data.nodes.length}</span>{" "}
              node{data.nodes.length === 1 ? "" : "s"}
            </span>
            <span>·</span>
            <span>
              <span className="font-medium text-foreground">{data.edges.length}</span>{" "}
              edge{data.edges.length === 1 ? "" : "s"}
            </span>
          </div>
          <ProcessCanvas graph={data} />
        </>
      )}

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
