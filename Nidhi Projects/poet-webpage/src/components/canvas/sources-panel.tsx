"use client";

import { X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { CitationDetail, UUID } from "@/lib/types";

const KIND_TINT: Record<string, string> = {
  actor: "#dbeafe",
  task: "#dcfce7",
  decision: "#fef9c3",
  threshold: "#fae8ff",
  sla: "#fce7f3",
  dependency: "#cffafe",
  exception: "#ffedd5",
  control: "#e0e7ff",
  system: "#fde68a",
  gateway_condition: "#fcd34d",
};

export function SourcesPanel({
  projectId,
  nodeId,
  nodeName,
  onClose,
}: {
  projectId: UUID;
  nodeId: UUID;
  nodeName?: string;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["node-citations", projectId, nodeId],
    queryFn: () => api.getNodeCitations(projectId, nodeId),
  });

  return (
    <div className="flex h-full w-[360px] flex-col border-l bg-white shadow-xl">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Sources
          </p>
          <h2 className="truncate text-sm font-semibold">
            {nodeName ?? "Selected node"}
          </h2>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">
          <X size={16} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {isLoading && (
          <p className="px-1 text-sm text-muted-foreground">Loading…</p>
        )}
        {error && (
          <p className="px-1 text-sm text-red-600">
            {(error as Error).message}
          </p>
        )}

        {data && data.claims.length === 0 && (
          <p className="px-1 text-sm text-muted-foreground">
            No claims linked to this node yet. Use the AI to attach
            supporting evidence.
          </p>
        )}

        <ul className="space-y-3">
          {data?.claims.map((claim) => (
            <li
              key={claim.id}
              className="rounded-md border bg-white shadow-sm"
            >
              <div className="border-b px-3 py-2">
                <div className="flex items-center gap-2">
                  <Badge
                    variant="outline"
                    style={{
                      backgroundColor: KIND_TINT[claim.kind] ?? "#f1f5f9",
                    }}
                  >
                    {claim.kind.replace(/_/g, " ")}
                  </Badge>
                  {claim.confidence != null && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      conf {claim.confidence.toFixed(2)}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
                    {claim.link_kind}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium leading-snug">
                  {claim.subject}
                </p>
              </div>
              <ul className="space-y-2 px-3 py-2">
                {claim.citations.length === 0 && (
                  <li className="text-xs text-muted-foreground">
                    No citations recorded.
                  </li>
                )}
                {claim.citations.map((c) => (
                  <CitationItem key={c.citation_id} citation={c} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CitationItem({ citation }: { citation: CitationDetail }) {
  const ref = citation.section_ref;
  const refLabel = formatSectionRef(citation.section_kind, ref);
  return (
    <li className="rounded border-l-2 border-slate-200 bg-slate-50 px-2 py-1.5">
      <p className="line-clamp-3 text-xs leading-snug text-slate-700">
        “{citation.quote}”
      </p>
      <p className="mt-1 text-[10px] text-muted-foreground">
        <span className="font-medium text-slate-600">{citation.input_name}</span>
        {" · "}
        <span>{citation.input_type.replace(/_/g, " ")}</span>
        {refLabel && <span> · {refLabel}</span>}
      </p>
    </li>
  );
}

function formatSectionRef(kind: string, ref: Record<string, unknown>): string | null {
  if (!ref) return null;
  if (typeof ref.page === "number") return `page ${ref.page}`;
  if (typeof ref.slide === "number") return `slide ${ref.slide}`;
  if (typeof ref.sheet === "string") return `sheet ${ref.sheet}`;
  if (typeof ref.paragraph_block === "number")
    return `block ${ref.paragraph_block + 1}`;
  if (kind && kind !== "page") return kind.replace(/_/g, " ");
  return null;
}
