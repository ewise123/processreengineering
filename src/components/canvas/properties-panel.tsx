"use client";

import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type {
  CitationDetail,
  NodeIssueDetail,
  ProcessLane,
  ReviewDecision,
  SuggestedStep,
  UUID,
  ViewerTarget,
} from "@/lib/types";

import { AiEditPanel } from "./ai-edit-panel";
import { NODE_TYPE_OPTIONS } from "./node-type";

interface SelectedNode {
  id: UUID;
  name?: string;
  nodeKind?: string;
  type?: string;
  laneId?: string | null;
  description?: string;
}

export function PropertiesPanel({
  projectId,
  modelId,
  versionId,
  selected,
  lanes,
  collapsed,
  onCollapsedChange,
  onDelete,
  onUpdate,
  onAddStep,
  onOpenSource,
  review,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  selected: SelectedNode;
  lanes: ProcessLane[];
  /** Controlled collapse state — the page lifts this so it can resize the
   * wrapper to a single small button when the panel is collapsed. */
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  onDelete?: (id: UUID) => Promise<void> | void;
  onUpdate?: (
    id: UUID,
    patch: { name?: string; laneId?: UUID; type?: string; description?: string }
  ) => Promise<void> | void;
  onAddStep?: (sourceId: UUID, step: SuggestedStep) => void;
  /** Open a source document in the viewer, jumping to a citation's quote. */
  onOpenSource: (target: ViewerTarget) => void;
  review?: {
    status: ReviewDecision | null;
    onApprove: () => void;
    onRequestChange: (note?: string) => void;
  };
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["node-citations", projectId, selected.id],
    queryFn: () => api.getNodeCitations(projectId, selected.id),
  });

  const { data: issuesData, isLoading: issuesLoading } = useQuery({
    queryKey: ["node-issues", projectId, selected.id],
    queryFn: () => api.getNodeIssues(projectId, selected.id),
  });

  const claims = data?.claims ?? [];
  const totalCitations = claims.reduce((acc, c) => acc + c.citations.length, 0);
  const issues = issuesData?.issues ?? [];
  const [issuesExpanded, setIssuesExpanded] = useState(true);
  const [provenanceExpanded, setProvenanceExpanded] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [changeNote, setChangeNote] = useState("");
  const [showChangeNote, setShowChangeNote] = useState(false);
  // Reset the change-request note UI when the selection moves to another node,
  // so an open/typed note can't leak onto — or be submitted against — a
  // different node (the panel instance persists across selection changes).
  useEffect(() => {
    setChangeNote("");
    setShowChangeNote(false);
  }, [selected.id]);

  // Local label state lets the input feel responsive while debouncing the
  // PATCH until blur/Enter. Reset whenever the selection changes.
  const [labelDraft, setLabelDraft] = useState(selected.name ?? "");
  useEffect(() => {
    setLabelDraft(selected.name ?? "");
  }, [selected.id, selected.name]);

  const [descriptionDraft, setDescriptionDraft] = useState(selected.description ?? "");
  useEffect(() => {
    setDescriptionDraft(selected.description ?? "");
  }, [selected.id, selected.description]);

  const qc = useQueryClient();
  const [attachOpen, setAttachOpen] = useState(false);
  const detach = useMutation({
    mutationFn: (claimId: UUID) =>
      api.detachNodeClaim(projectId, selected.id, claimId),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["node-citations", projectId, selected.id],
      });
      qc.invalidateQueries({
        queryKey: ["node-issues", projectId, selected.id],
      });
    },
  });

  const handleDelete = async () => {
    if (!onDelete || deleting) return;
    setDeleting(true);
    try {
      await onDelete(selected.id);
    } finally {
      setDeleting(false);
    }
  };

  const handleLabelCommit = () => {
    if (!onUpdate) return;
    const trimmed = labelDraft.trim();
    if (trimmed === "" || trimmed === (selected.name ?? "")) {
      setLabelDraft(selected.name ?? "");
      return;
    }
    void onUpdate(selected.id, { name: trimmed });
  };

  const handleLaneChange = (laneId: UUID) => {
    if (!onUpdate || laneId === (selected.laneId ?? "")) return;
    void onUpdate(selected.id, { laneId });
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => onCollapsedChange(false)}
        title={`Expand properties — ${selected.name ?? "selected node"}`}
        aria-label="Expand properties panel"
        className="flex h-9 w-10 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900"
        style={{
          boxShadow:
            "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
        }}
      >
        <ChevronLeft size={14} />
      </button>
    );
  }

  return (
    <div
      className="flex h-full w-[270px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
      style={{
        boxShadow: "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
      }}
    >
      {/* Header — sticky at top */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-white px-3 py-2">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Properties
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleDelete}
            disabled={!onDelete || deleting}
            title={onDelete ? "Delete this node" : "Delete unavailable"}
            className="text-[11px] text-slate-400 hover:text-rose-600 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            onClick={() => onCollapsedChange(true)}
            title="Collapse properties"
            aria-label="Collapse"
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Scrollable body — three sections share this container */}
      <div className="flex-1 overflow-y-auto">

      {/* Properties body */}
      <div className="space-y-2.5 px-3 py-2.5">
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Label
          </label>
          <input
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={handleLabelCommit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.currentTarget as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLabelDraft(selected.name ?? "");
                (e.currentTarget as HTMLInputElement).blur();
              }
            }}
            disabled={!onUpdate}
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-slate-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Type
            </label>
            <select
              value={selected.type ?? "task"}
              onChange={(e) =>
                onUpdate?.(selected.id, { type: e.target.value })
              }
              disabled={!onUpdate}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-slate-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
            >
              {NODE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
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
              onChange={(e) => handleLaneChange(e.target.value as UUID)}
              disabled={!onUpdate}
              className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-slate-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
            >
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Description
          </label>
          <textarea
            value={descriptionDraft}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            onBlur={() => {
              if (descriptionDraft !== (selected.description ?? "")) {
                onUpdate?.(selected.id, { description: descriptionDraft });
              }
            }}
            disabled={!onUpdate}
            rows={3}
            className="mt-1 w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 focus:border-slate-500 focus:outline-none disabled:bg-slate-50"
          />
        </div>

        <AiEditPanel
          projectId={projectId}
          modelId={modelId}
          versionId={versionId}
          nodeId={selected.id}
          onRelabel={(name) => onUpdate?.(selected.id, { name })}
          onDescribe={(description) => {
            setDescriptionDraft(description);
            onUpdate?.(selected.id, { description });
          }}
          onAddStep={(step) => onAddStep?.(selected.id, step)}
        />
      </div>

      {/* Issues — open conflicts touching this node's claims */}
      {(issuesLoading || issues.length > 0) && (
        <div className="border-t border-slate-100 bg-rose-50/40 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setIssuesExpanded((v) => !v)}
            className="flex w-full items-center justify-between"
            aria-expanded={issuesExpanded}
          >
            <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-rose-700">
              {issuesExpanded ? (
                <ChevronDown size={10} />
              ) : (
                <ChevronRight size={10} />
              )}
              <AlertTriangle size={10} />
              Issues
            </div>
            {issues.length > 0 && (
              <span className="text-[10px] tabular-nums text-rose-700/70">
                {issues.length} open
              </span>
            )}
          </button>
          {issuesExpanded && (
            <div className="mt-1.5">
              {issuesLoading && (
                <div className="text-[11px] italic text-slate-400">
                  Loading…
                </div>
              )}
              {!issuesLoading && issues.length > 0 && (
                <ul className="space-y-1.5">
                  {issues.map((iss) => (
                    <IssueCard
                      key={iss.conflict_id}
                      issue={iss}
                      projectId={projectId}
                      onResolved={() => {
                        qc.invalidateQueries({
                          queryKey: ["node-issues", projectId, selected.id],
                        });
                      }}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Provenance */}
      <div className="border-t border-slate-100 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setProvenanceExpanded((v) => !v)}
          className="flex w-full items-center justify-between"
          aria-expanded={provenanceExpanded}
        >
          <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            {provenanceExpanded ? (
              <ChevronDown size={10} />
            ) : (
              <ChevronRight size={10} />
            )}
            Provenance
          </div>
          <span className="text-[10px] text-slate-400 tabular-nums">
            {claims.length} claim{claims.length === 1 ? "" : "s"} ·{" "}
            {totalCitations} cite{totalCitations === 1 ? "" : "s"}
          </span>
        </button>
        {provenanceExpanded && (
          <div className="mt-1.5 space-y-2">
            <button
              type="button"
              onClick={() => setAttachOpen(true)}
              className="w-full rounded-md border border-dashed border-slate-300 px-2 py-1 text-[10.5px] font-semibold text-slate-500 hover:border-violet-300 hover:text-violet-700"
            >
              + Attach claim
            </button>
            {isLoading && (
              <div className="text-[11px] italic text-slate-400">Loading…</div>
            )}
            {!isLoading && claims.length === 0 && (
              <div className="text-[11px] italic text-slate-400">
                No source citations for this node.
              </div>
            )}
            {claims.map((claim) => (
              <div key={claim.id} className="space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-[10.5px] font-medium text-slate-600">
                    {claim.subject}
                  </span>
                  <button
                    type="button"
                    title="Detach this claim from the node"
                    disabled={detach.isPending}
                    onClick={() => detach.mutate(claim.id)}
                    className="rounded px-1 text-[11px] text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                  >
                    ×
                  </button>
                </div>
                <ul className="space-y-1.5">
                  {claim.citations.map((cit) => (
                    <CitationCard
                      key={cit.citation_id}
                      kind={claim.kind}
                      citation={cit}
                      onOpenSource={onOpenSource}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stakeholder Review */}
      <div className="border-t border-slate-100 px-3 py-2.5">
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Stakeholder Review
        </div>
        <div className="mb-2 text-[11px] italic">
          {review?.status === "approved" ? (
            <span className="text-emerald-600">Approved</span>
          ) : review?.status === "changes_requested" ? (
            <span className="text-amber-600">Changes requested</span>
          ) : (
            <span className="text-slate-400">Not yet reviewed</span>
          )}
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            disabled={!review}
            onClick={() => review?.onApprove()}
            className="flex-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10.5px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={!review}
            onClick={() => setShowChangeNote((v) => !v)}
            className="flex-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[10.5px] font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            Request change
          </button>
          <button
            type="button"
            disabled
            title="Assigning reviewers needs multi-user accounts (coming later)"
            className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10.5px] font-semibold text-slate-400 cursor-not-allowed"
          >
            @ Assign
          </button>
        </div>
        {showChangeNote && review && (
          <div className="mt-2">
            <textarea
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              aria-label="Change request note"
              placeholder="Optional note for the change request…"
              rows={2}
              className="w-full rounded-md border border-slate-200 px-2 py-1 text-[11px] focus:border-slate-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                review.onRequestChange(changeNote.trim() || undefined);
                setChangeNote("");
                setShowChangeNote(false);
              }}
              className="mt-1 w-full rounded-md bg-rose-600 px-2 py-1 text-[10.5px] font-semibold text-white hover:bg-rose-700"
            >
              Submit change request
            </button>
          </div>
        )}
      </div>

      </div>{/* end scrollable body */}
      {attachOpen && (
        <AttachClaimDialog
          projectId={projectId}
          nodeId={selected.id}
          linkedClaimIds={new Set(claims.map((c) => c.id))}
          onClose={() => setAttachOpen(false)}
          onAttached={() => {
            qc.invalidateQueries({
              queryKey: ["node-citations", projectId, selected.id],
            });
            qc.invalidateQueries({
              queryKey: ["node-issues", projectId, selected.id],
            });
          }}
        />
      )}
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
  onOpenSource,
}: {
  kind: string;
  citation: CitationDetail;
  onOpenSource: (target: ViewerTarget) => void;
}) {
  const ref = citation.section_ref;
  const refLabel = formatSectionRef(citation.section_kind, ref);
  return (
    <li>
      <button
        type="button"
        onClick={() =>
          onOpenSource({
            inputId: citation.input_id,
            inputName: citation.input_name,
            sectionRef: citation.section_ref,
            quote: citation.quote,
          })
        }
        title="View this quote in the source document"
        className="w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-left hover:border-violet-300 hover:bg-violet-50"
      >
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
          &ldquo;{citation.quote}&rdquo;
        </div>
        {refLabel && (
          <div className="mt-0.5 text-[9px] uppercase tracking-wider text-slate-400">
            {refLabel}
          </div>
        )}
      </button>
    </li>
  );
}

const CONFLICT_KIND_LABEL: Record<string, string> = {
  threshold_mismatch: "Threshold mismatch",
  owner_mismatch: "Owner mismatch",
  sla_mismatch: "SLA mismatch",
  sequence_mismatch: "Sequence mismatch",
  missing_path: "Missing path",
};

function IssueCard({
  issue,
  projectId,
  onResolved,
}: {
  issue: NodeIssueDetail;
  projectId: UUID;
  onResolved: () => void;
}) {
  const kindLabel =
    CONFLICT_KIND_LABEL[issue.kind] ?? issue.kind.replace(/_/g, " ");
  const resolve = useMutation({
    mutationFn: (status: string) =>
      api.resolveConflict(projectId, issue.conflict_id, {
        resolution_status: status,
      }),
    onSuccess: onResolved,
  });
  return (
    <li className="rounded-md border border-rose-200 bg-white px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-700">
          {kindLabel}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-slate-400">
          {issue.detected_by}
        </span>
      </div>
      <div className="mt-1 space-y-1">
        <ClaimLine label="This step" claim={issue.this_claim} />
        <div className="pl-3 text-[9px] uppercase tracking-wider text-rose-500">
          ↕ vs.
        </div>
        <ClaimLine label="Other claim" claim={issue.other_claim} />
      </div>
      {issue.detection_reason && (
        <div className="mt-1.5 rounded border-l-2 border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10.5px] italic text-slate-600">
          {issue.detection_reason}
        </div>
      )}
      <div className="mt-1.5 flex gap-1">
        <button
          type="button"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate("resolved")}
          className="flex-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
        >
          Resolve
        </button>
        <button
          type="button"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate("dismissed")}
          className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </li>
  );
}

function ClaimLine({
  label,
  claim,
}: {
  label: string;
  claim: NodeIssueDetail["this_claim"];
}) {
  return (
    <div>
      <div className="flex items-center gap-1">
        <span
          className="rounded px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-slate-700"
          style={{ background: KIND_TINT[claim.kind] ?? "#e2e8f0" }}
        >
          {claim.kind.replace(/_/g, " ")}
        </span>
        <span className="text-[9px] uppercase tracking-wider text-slate-400">
          {label}
        </span>
      </div>
      <div className="mt-0.5 text-[10.5px] leading-snug text-slate-700">
        {claim.subject}
      </div>
    </div>
  );
}

function AttachClaimDialog({
  projectId,
  nodeId,
  linkedClaimIds,
  onClose,
  onAttached,
}: {
  projectId: UUID;
  nodeId: UUID;
  linkedClaimIds: Set<UUID>;
  onClose: () => void;
  onAttached: () => void;
}) {
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<UUID>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ["attach-claims", projectId],
    queryFn: () => api.listClaims(projectId, { limit: 500 }),
  });
  const attach = useMutation({
    mutationFn: () =>
      api.attachNodeClaims(projectId, nodeId, {
        claim_ids: Array.from(selected),
        link_kind: "evidence",
      }),
    onSuccess: () => {
      onAttached();
      onClose();
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const kinds = Array.from(
    new Set((data?.items ?? []).map((c) => c.kind))
  ).sort();
  const visible = (data?.items ?? []).filter(
    (c) => !linkedClaimIds.has(c.id) && (kindFilter === "all" || c.kind === kindFilter)
  );

  const toggle = (cid: UUID) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-[420px] flex-col rounded-lg border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
          <span className="text-sm font-semibold text-slate-800">
            Attach claims to this node
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
          >
            ×
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-2">
          <label className="text-[11px] text-slate-500">Kind</label>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="rounded-md border border-slate-200 px-2 py-1 text-xs"
          >
            <option value="all">All</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          {isLoading && (
            <div className="text-[11px] italic text-slate-400">Loading…</div>
          )}
          {!isLoading && visible.length === 0 && (
            <div className="py-6 text-center text-[11px] text-slate-400">
              No unlinked claims for this filter.
            </div>
          )}
          <ul className="space-y-1">
            {visible.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 px-2 py-1.5 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] uppercase tracking-wide text-slate-400">
                      {c.kind.replace(/_/g, " ")}
                    </span>
                    <span className="block text-[11.5px] leading-snug text-slate-700">
                      {c.subject}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-3 py-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={selected.size === 0 || attach.isPending}
            onClick={() => attach.mutate()}
            className="rounded-md bg-violet-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {attach.isPending ? "Attaching…" : `Attach ${selected.size || ""}`}
          </button>
        </div>
      </div>
    </div>
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
