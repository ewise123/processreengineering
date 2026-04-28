"use client";

import { Sparkles, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type {
  CitationDetail,
  ProcessLane,
  UUID,
} from "@/lib/types";

interface SelectedNode {
  id: UUID;
  name?: string;
  nodeKind?: string;
  laneId?: string | null;
}

const NODE_KINDS = [
  "start",
  "end",
  "intermediate",
  "user",
  "service",
  "manual",
  "send",
  "receive",
  "gateway",
] as const;

export function PropertiesPanel({
  projectId,
  selected,
  lanes,
  onClose,
}: {
  projectId: UUID;
  selected: SelectedNode;
  lanes: ProcessLane[];
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["node-citations", projectId, selected.id],
    queryFn: () => api.getNodeCitations(projectId, selected.id),
  });

  const claims = data?.claims ?? [];
  const totalCitations = claims.reduce((acc, c) => acc + c.citations.length, 0);

  return (
    <div
      className="flex h-full w-[270px] flex-col border-l bg-white"
      style={{
        boxShadow: "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Properties
        </div>
        <div className="flex items-center gap-2">
          <button
            disabled
            title="Delete coming soon"
            className="text-[11px] text-slate-300"
          >
            Delete
          </button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            className="h-6 w-6 p-0"
            aria-label="Close"
          >
            <X size={14} />
          </Button>
        </div>
      </div>

      {/* Properties body */}
      <div className="space-y-2.5 px-3 py-2.5">
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Label
          </label>
          <input
            value={selected.name ?? ""}
            disabled
            title="Editing label inline coming soon — drag the node to reposition for now"
            className="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-600 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Type
            </label>
            <select
              value={selected.nodeKind ?? "user"}
              disabled
              title="Type editing coming soon"
              className="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-600 focus:outline-none"
            >
              {NODE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Lane
            </label>
            <select
              value={selected.laneId ?? ""}
              disabled
              title="Drag the node into a different lane to change assignment"
              className="mt-1 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-600 focus:outline-none"
            >
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          disabled
          title="AI editing coming in Phase 3c"
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-slate-200 px-2.5 py-1.5 text-[11px] font-semibold text-slate-500"
        >
          <Sparkles size={11} />
          Ask AI to edit this step
        </button>
      </div>

      {/* Provenance */}
      <div className="border-t border-slate-100 px-3 py-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Provenance
          </div>
          <span className="text-[10px] text-slate-400 tabular-nums">
            {claims.length} claim{claims.length === 1 ? "" : "s"} ·{" "}
            {totalCitations} cite{totalCitations === 1 ? "" : "s"}
          </span>
        </div>
        {isLoading && (
          <div className="text-[11px] italic text-slate-400">Loading…</div>
        )}
        {!isLoading && claims.length === 0 && (
          <div className="text-[11px] italic text-slate-400">
            No source citations for this node.
          </div>
        )}
        <ul className="space-y-1.5">
          {claims.flatMap((claim) =>
            claim.citations.map((cit) => (
              <CitationCard
                key={cit.citation_id}
                kind={claim.kind}
                citation={cit}
              />
            ))
          )}
        </ul>
      </div>

      {/* Stakeholder Review (design surface only — Phase 3d wires it) */}
      <div className="border-t border-slate-100 px-3 py-2.5">
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Stakeholder Review
        </div>
        <div className="mb-2 text-[11px] italic text-slate-400">
          Not yet assigned.
        </div>
        <div className="flex gap-1">
          <button
            disabled
            className="flex-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10.5px] font-semibold text-emerald-700/60"
          >
            Approve
          </button>
          <button
            disabled
            className="flex-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[10.5px] font-semibold text-rose-700/60"
          >
            Request change
          </button>
          <button
            disabled
            className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10.5px] font-semibold text-slate-500"
          >
            @ Assign
          </button>
        </div>
      </div>
    </div>
  );
}

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

function CitationCard({
  kind,
  citation,
}: {
  kind: string;
  citation: CitationDetail;
}) {
  const ref = citation.section_ref;
  const refLabel = formatSectionRef(citation.section_kind, ref);
  return (
    <li className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-700"
          style={{ background: KIND_TINT[kind] ?? "#e2e8f0" }}
        >
          {kind.replace(/_/g, " ")}
        </span>
        <span className="ml-1 truncate text-[10px] font-semibold text-slate-700">
          {citation.input_name}
        </span>
        {citation.confidence != null && (
          <span className="ml-1 text-[9px] tabular-nums text-slate-400">
            {Math.round(citation.confidence * 100)}%
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10.5px] italic leading-snug text-slate-500">
        “{citation.quote}”
      </div>
      {refLabel && (
        <div className="mt-0.5 text-[9px] uppercase tracking-wider text-slate-400">
          {refLabel}
        </div>
      )}
    </li>
  );
}

function formatSectionRef(
  kind: string,
  ref: Record<string, unknown>
): string | null {
  if (!ref) return null;
  if (typeof ref.page === "number") return `page ${ref.page}`;
  if (typeof ref.slide === "number") return `slide ${ref.slide}`;
  if (typeof ref.sheet === "string") return `sheet ${ref.sheet}`;
  if (typeof ref.paragraph_block === "number")
    return `block ${ref.paragraph_block + 1}`;
  if (kind && kind !== "page") return kind.replace(/_/g, " ");
  return null;
}
