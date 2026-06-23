"use client";

/**
 * Right-side panel with tabs: Chat, Versions, Issues, Review, Sources.
 * Mirrors the Claude Design prototype layout (poet-workspace/src/audit.jsx).
 *
 * Tabs are collapsed to icon-only when inactive; the active tab gets
 * `flex-1` plus its label. The whole panel can also collapse to a vertical
 * icon rail.
 *
 * Versions is intentionally minimal until backend tracking lands — UI is in
 * place so users can see where that feature will live.
 */

import {
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  GitBranch,
  GitCompare,
  History,
  Link2,
  MessageSquare,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type {
  ChangeLogPage,
  ChatTurn,
  InputRow,
  NodeIssue,
  ReconcileBatch,
  ReconcileSuggestion,
  ReviewState,
  UUID,
  ViewerTarget,
} from "@/lib/types";
import { ChangeEntry } from "./change-entry";
import { buildVersionRows, type TreeRow } from "./version-tree";
import { diffChangeCount, isEmptyDiff } from "./version-diff";
import { reconcileRow } from "./reconcile";
import { bucketNodes, reviewByNodeMap } from "./review-summary";

type TabId = "chat" | "versions" | "issues" | "review" | "sources" | "refresh" | "changelog";

const TAB_LABELS: Record<TabId, string> = {
  chat: "Chat",
  versions: "Versions",
  issues: "Issues",
  review: "Review",
  sources: "Sources",
  refresh: "Refresh",
  changelog: "Change Log",
};

const SUGGESTED_PROMPTS = [
  "Find any gaps in this flow",
  "Should this step come before its predecessor?",
  "Which steps lack source citations?",
  "Compare this against typical processes",
];

interface SelectedRef {
  id: UUID;
  kind: "node" | "edge";
  name?: string;
  nodeKind?: string;
}

export function RightPanel({
  projectId,
  modelId,
  versionId,
  nodes,
  selected,
  onFocusNode,
  reviewState,
  onSendRequest,
  onNavigateVersion,
  onOpenSource,
  collapsed,
  onCollapsedChange,
  initialTab = "chat",
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  nodes: { id: UUID; name: string; type: string; lane_id: UUID | null }[];
  selected: SelectedRef | null;
  /** Sets the canvas selection. Used by Issues "→ Node" links. */
  onFocusNode: (id: UUID) => void;
  reviewState?: ReviewState;
  onSendRequest: () => void;
  onNavigateVersion?: (versionId: UUID) => void;
  /** Open a source document in the viewer (no citation = page 1, no highlight). */
  onOpenSource: (target: ViewerTarget) => void;
  /** Controlled collapse state — the page lifts this so the Properties
   * panel can shift when the right panel collapses. */
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  initialTab?: TabId;
}) {
  const [tab, setTab] = useState<TabId>(initialTab);

  const issuesQuery = useQuery({
    queryKey: ["issues", projectId, modelId, versionId],
    queryFn: () => api.getProcessMapIssues(projectId, modelId, versionId),
  });
  const issues = issuesQuery.data ?? [];

  const tabs: { id: TabId; count?: number }[] = [
    { id: "chat" },
    { id: "versions" },
    { id: "issues", count: issues.length },
    { id: "review" },
    { id: "sources" },
    { id: "refresh" },
    { id: "changelog" },
  ];

  if (collapsed) {
    return (
      <div
        className="flex h-full w-10 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
        style={{
          boxShadow:
            "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
        }}
      >
        <button
          onClick={() => onCollapsedChange(false)}
          title="Expand panel"
          className="flex h-9 items-center justify-center border-b border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
        >
          <ChevronLeft size={14} />
        </button>
        <div className="flex flex-col py-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                onCollapsedChange(false);
              }}
              title={TAB_LABELS[t.id]}
              className={
                "relative flex h-10 items-center justify-center transition " +
                (tab === t.id
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-900")
              }
            >
              <TabIcon id={t.id} />
              {typeof t.count === "number" && t.count > 0 && (
                <span className="absolute right-1 top-1 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-rose-500 px-0.5 text-[9px] font-bold text-white">
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-[360px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
      style={{
        boxShadow:
          "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
      }}
    >
      {/* Header — collapse + tabs */}
      <div className="flex h-9 shrink-0 items-center border-b border-slate-200">
        <button
          onClick={() => onCollapsedChange(true)}
          title="Minimize panel"
          className="flex h-full w-8 items-center justify-center border-r border-slate-200 text-slate-400 hover:bg-slate-50 hover:text-slate-900"
        >
          <ChevronRight size={13} />
        </button>
        <div className="flex min-w-0 flex-1 items-stretch">
          {tabs.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                title={TAB_LABELS[t.id]}
                className={
                  "group flex h-full min-w-0 items-center justify-center gap-1.5 border-b-2 transition-all duration-200 " +
                  (active
                    ? "flex-1 border-slate-900 bg-slate-50/50 px-2.5 text-slate-900"
                    : "border-transparent px-2.5 text-slate-400 hover:bg-slate-50 hover:text-slate-800")
                }
              >
                <TabIcon id={t.id} />
                {active && (
                  <>
                    <span className="truncate text-[11px] font-semibold">
                      {TAB_LABELS[t.id]}
                    </span>
                    {typeof t.count === "number" && t.count > 0 && (
                      <span className="inline-flex h-[15px] min-w-[15px] flex-shrink-0 items-center justify-center rounded-full bg-rose-100 px-1 text-[9px] font-bold text-rose-700">
                        {t.count}
                      </span>
                    )}
                  </>
                )}
                {!active && typeof t.count === "number" && t.count > 0 && (
                  <span className="inline-flex h-[14px] min-w-[14px] flex-shrink-0 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab body */}
      <div className="flex-1 overflow-hidden">
        {tab === "chat" && (
          <ChatTab
            projectId={projectId}
            modelId={modelId}
            versionId={versionId}
            selected={selected}
          />
        )}
        {tab === "versions" && (
          <VersionsTab
            projectId={projectId}
            modelId={modelId}
            versionId={versionId}
            onNavigateVersion={onNavigateVersion}
          />
        )}
        {tab === "issues" && (
          <IssuesTab
            issues={issues}
            nodes={nodes}
            isLoading={issuesQuery.isLoading}
            onFocusNode={onFocusNode}
          />
        )}
        {tab === "review" && (
          <ReviewTab
            nodes={nodes}
            onFocusNode={onFocusNode}
            reviewState={reviewState}
            onSendRequest={onSendRequest}
          />
        )}
        {tab === "sources" && (
          <SourcesTab projectId={projectId} onOpenSource={onOpenSource} />
        )}
        {tab === "refresh" && (
          <RefreshTab projectId={projectId} modelId={modelId} versionId={versionId} />
        )}
        {tab === "changelog" && (
          <ChangeLogTab
            projectId={projectId}
            modelId={modelId}
            selected={selected}
            onFocusNode={onFocusNode}
          />
        )}
      </div>
    </div>
  );
}

function TabIcon({ id }: { id: TabId }) {
  const props = { size: 14 };
  switch (id) {
    case "chat":
      return <MessageSquare {...props} />;
    case "versions":
      return <GitBranch {...props} />;
    case "issues":
      return <TriangleAlert {...props} />;
    case "review":
      return <ShieldCheck {...props} />;
    case "sources":
      return <Link2 {...props} />;
    case "refresh":
      return <RotateCcw {...props} />;
    case "changelog":
      return <History {...props} />;
  }
}

// ─── Chat tab ───────────────────────────────────────────────
function ChatTab({
  projectId,
  modelId,
  versionId,
  selected,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  selected: SelectedRef | null;
}) {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (input: { history: ChatTurn[]; userMessage: string }) =>
      api.chatWithMap(projectId, modelId, versionId, {
        history: input.history,
        user_message: input.userMessage,
        selected_node_id: selected?.kind === "node" ? selected.id : null,
        selected_edge_id: selected?.kind === "edge" ? selected.id : null,
      }),
    onSuccess: (data, vars) => {
      setHistory((curr) => [
        ...curr,
        { role: "user", content: vars.userMessage },
        { role: "assistant", content: data.content },
      ]);
    },
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, ask.isPending]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    setDraft("");
    ask.mutate({ history, userMessage: trimmed });
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-indigo-700">
            POET Assistant
          </div>
          <div className="text-[11.5px] leading-relaxed text-indigo-900/80">
            Grounded in this map&apos;s claims and citations. I&apos;ll push
            back if your premise contradicts the sources.
          </div>
        </div>

        {history.map((m, i) => (
          <ChatMsg key={i} turn={m} />
        ))}

        {ask.isPending && (
          <div className="flex items-start gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-900 text-[10px] font-bold text-white">
              AI
            </div>
            <div className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="flex items-center gap-1">
                <span
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                  style={{ animationDelay: "0s" }}
                />
                <span
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                  style={{ animationDelay: "0.15s" }}
                />
                <span
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                  style={{ animationDelay: "0.3s" }}
                />
                <span className="ml-2 text-[11px] text-slate-500">
                  Thinking…
                </span>
              </div>
            </div>
          </div>
        )}

        {ask.isError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
            {(ask.error as Error).message}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-slate-200 p-2">
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {SUGGESTED_PROMPTS.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              className="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-200"
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={2}
            placeholder="Ask about any node, or describe a change…"
            className="flex-1 resize-none rounded-md border border-slate-200 px-2 py-1.5 text-xs focus:border-slate-500 focus:outline-none"
          />
          <button
            onClick={() => submit(draft)}
            disabled={!draft.trim() || ask.isPending}
            className="h-8 rounded-md bg-slate-900 px-3 text-[11px] font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatMsg({ turn }: { turn: ChatTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex items-start justify-end gap-2">
        <div className="max-w-[85%] rounded-lg bg-slate-900 px-3 py-2 text-[11.5px] leading-relaxed text-white">
          {turn.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2">
      <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-slate-900 text-[10px] font-bold text-white">
        AI
      </div>
      <div className="min-w-0 flex-1">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-800">
          {turn.content.split("\n").map((line, i) => (
            <p key={i} className={i > 0 ? "mt-2" : ""}>
              {line}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Versions tab ───────────────────────────────────────────
const COL_WIDTH = 16; // px per commit-graph column
const ROW_DOT_R = 4;

function VersionsTab({
  projectId,
  modelId,
  versionId,
  onNavigateVersion,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  onNavigateVersion?: (versionId: UUID) => void;
}) {
  const queryClient = useQueryClient();
  const [diffFrom, setDiffFrom] = useState<UUID | null>(null);

  const versionsQuery = useQuery({
    queryKey: ["versions", projectId, modelId],
    queryFn: () => api.listVersions(projectId, modelId),
  });
  const versions = versionsQuery.data ?? [];
  const rows = buildVersionRows(versions);
  const latestNumber = versions.reduce(
    (max, v) => Math.max(max, v.version_number),
    0
  );
  const columnCount = rows.reduce((m, r) => Math.max(m, r.column + 1), 1);

  const copyMutation = useMutation({
    mutationFn: (vars: { sourceId: UUID; note: string }) =>
      api.copyVersion(projectId, modelId, vars.sourceId, vars.note),
    onSuccess: (newVersion) => {
      setDiffFrom(null);
      queryClient.invalidateQueries({ queryKey: ["versions", projectId, modelId] });
      onNavigateVersion?.(newVersion.id);
    },
  });

  const branchFromCurrent = () => {
    const current = versions.find((v) => v.id === versionId);
    copyMutation.mutate({
      sourceId: versionId,
      note: current ? `Branched from v${current.version_number}` : "Branch",
    });
  };

  if (versionsQuery.isLoading) {
    return <div className="px-3 py-3 text-[11px] text-slate-400">Loading versions…</div>;
  }

  if (versionsQuery.isError) {
    return (
      <div className="px-3 py-3 text-[11px] text-rose-600">
        Couldn&apos;t load versions.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Version History
        </div>
        <button
          type="button"
          onClick={branchFromCurrent}
          disabled={copyMutation.isPending}
          title="Branch from the current version"
          className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-[10px] font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          <GitBranch size={11} />
          Branch
        </button>
      </div>

      {copyMutation.isError && (
        <div className="mb-2 rounded bg-rose-50 px-2 py-1 text-[10px] text-rose-700">
          Couldn&apos;t create the version. Try again.
        </div>
      )}

      <div className="space-y-1.5">
        {rows
          .slice()
          .reverse()
          .map((row) => (
            <VersionRow
              key={row.version.id}
              row={row}
              columnCount={columnCount}
              isCurrent={row.version.id === versionId}
              isLatest={row.version.version_number === latestNumber}
              busy={copyMutation.isPending}
              onOpen={() => onNavigateVersion?.(row.version.id)}
              onCopy={(note) =>
                copyMutation.mutate({ sourceId: row.version.id, note })
              }
              onDiff={() => setDiffFrom(row.version.id)}
            />
          ))}
        {rows.length === 0 && (
          <div className="py-8 text-center text-[11px] text-slate-400">
            No versions yet.
          </div>
        )}
      </div>

      {diffFrom && (
        <DiffPanel
          projectId={projectId}
          modelId={modelId}
          fromId={diffFrom}
          toId={versionId}
          fromLabel={
            versions.find((v) => v.id === diffFrom)?.version_number ?? "?"
          }
          toLabel={
            versions.find((v) => v.id === versionId)?.version_number ?? "?"
          }
          onClose={() => setDiffFrom(null)}
        />
      )}
    </div>
  );
}

function VersionRow({
  row,
  columnCount,
  isCurrent,
  isLatest,
  busy,
  onOpen,
  onCopy,
  onDiff,
}: {
  row: TreeRow;
  columnCount: number;
  isCurrent: boolean;
  isLatest: boolean;
  busy: boolean;
  onOpen: () => void;
  onCopy: (note: string) => void;
  onDiff: () => void;
}) {
  const v = row.version;
  const railWidth = columnCount * COL_WIDTH;
  return (
    <div
      className={`flex gap-2 rounded-md border px-2 py-1.5 ${
        isCurrent ? "border-slate-800 bg-slate-50" : "border-slate-200 bg-white"
      }`}
    >
      <svg width={railWidth} height={44} className="flex-shrink-0">
        {row.parentColumn !== null && (
          <line
            x1={row.column * COL_WIDTH + COL_WIDTH / 2}
            y1={ROW_DOT_R + 2}
            x2={row.parentColumn * COL_WIDTH + COL_WIDTH / 2}
            y2={44}
            stroke="#cbd5e1"
            strokeWidth={1.5}
          />
        )}
        <circle
          cx={row.column * COL_WIDTH + COL_WIDTH / 2}
          cy={ROW_DOT_R + 6}
          r={ROW_DOT_R}
          fill={isCurrent ? "#1e293b" : "#94a3b8"}
        />
      </svg>

      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-slate-400">
            v{v.version_number}
          </span>
          {isLatest && (
            <span className="rounded bg-emerald-100 px-1 py-px text-[9px] font-bold text-emerald-700">
              latest
            </span>
          )}
          <span className="rounded bg-slate-200 px-1 py-px text-[9px] font-bold text-slate-700">
            {v.status}
          </span>
          <span className="text-[9px] text-slate-400">{v.node_count} nodes</span>
        </div>
        <div className="truncate text-[11px] leading-snug text-slate-800">
          {v.notes ?? "—"}
        </div>
        <div className="mt-0.5 text-[10px] text-slate-400">
          {new Date(v.created_at).toLocaleString()}
        </div>

        <div className="mt-1 flex flex-wrap gap-1">
          {!isCurrent && (
            <RowButton icon={<Eye size={10} />} label="Open" onClick={onOpen} disabled={busy} />
          )}
          {!isCurrent && (
            <RowButton
              icon={<RotateCcw size={10} />}
              label="Restore"
              onClick={() => onCopy(`Restored from v${v.version_number}`)}
              disabled={busy}
            />
          )}
          {!isCurrent && (
            <RowButton
              icon={<GitCompare size={10} />}
              label="Diff vs current"
              onClick={onDiff}
              disabled={busy}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function RowButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}

function DiffPanel({
  projectId,
  modelId,
  fromId,
  toId,
  fromLabel,
  toLabel,
  onClose,
}: {
  projectId: UUID;
  modelId: UUID;
  fromId: UUID;
  toId: UUID;
  fromLabel: number | string;
  toLabel: number | string;
  onClose: () => void;
}) {
  const diffQuery = useQuery({
    queryKey: ["version-diff", projectId, modelId, fromId, toId],
    queryFn: () => api.getVersionDiff(projectId, modelId, fromId, toId),
  });
  const d = diffQuery.data;

  return (
    <div className="mt-4 rounded-md border border-slate-300 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          v{fromLabel} → v{toLabel}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] font-semibold text-slate-500 hover:text-slate-800"
        >
          Close
        </button>
      </div>
      {diffQuery.isLoading && (
        <div className="text-[11px] text-slate-400">Computing diff…</div>
      )}
      {d && isEmptyDiff(d) && (
        <div className="text-[11px] italic text-slate-500">No structural changes.</div>
      )}
      {d && !isEmptyDiff(d) && (
        <div className="space-y-1.5 text-[11px]">
          <DiffGroup color="text-emerald-700" label="Added" items={d.nodes.added.map((n) => n.name)} />
          <DiffGroup color="text-rose-700" label="Removed" items={d.nodes.removed.map((n) => n.name)} />
          <DiffGroup
            color="text-amber-700"
            label="Renamed"
            items={d.nodes.renamed.map((n) => `${n.from_name} → ${n.name}`)}
          />
          <DiffGroup
            color="text-sky-700"
            label="Moved"
            items={d.nodes.moved.map((n) => `${n.name}: ${n.from_lane} → ${n.to_lane}`)}
          />
          <div className="pt-1 text-[10px] text-slate-400">
            edges +{d.edges.added.length}/−{d.edges.removed.length} ·
            lanes +{d.lanes.added.length}/−{d.lanes.removed.length} ·
            {d.nodes.unchanged_count} unchanged · {diffChangeCount(d)} changes
          </div>
        </div>
      )}
    </div>
  );
}

function DiffGroup({
  color,
  label,
  items,
}: {
  color: string;
  label: string;
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <span className={`font-semibold ${color}`}>
        {label} ({items.length})
      </span>
      <ul className="ml-3 list-disc text-slate-700">
        {items.map((it, i) => (
          <li key={i} className="truncate">
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Issues tab ─────────────────────────────────────────────
function IssuesTab({
  issues,
  nodes,
  isLoading,
  onFocusNode,
}: {
  issues: NodeIssue[];
  nodes: { id: UUID; name: string; type: string }[];
  isLoading: boolean;
  onFocusNode: (id: UUID) => void;
}) {
  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.name);
    return m;
  }, [nodes]);

  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Issues found
        </div>
        <div className="text-[10px] text-slate-400">{issues.length} open</div>
      </div>
      {isLoading && (
        <div className="text-[11px] italic text-slate-400">Loading…</div>
      )}
      {!isLoading && issues.length === 0 && (
        <div className="py-8 text-center text-[11px] text-slate-400">
          No open issues 🎉
        </div>
      )}
      <div className="space-y-2">
        {issues.map((iss) => {
          const sev = iss.severity;
          const palette =
            sev === "high"
              ? {
                  bg: "bg-rose-50",
                  border: "border-rose-200",
                  pillBg: "bg-rose-200",
                  pillFg: "text-rose-800",
                }
              : {
                  bg: "bg-amber-50",
                  border: "border-amber-200",
                  pillBg: "bg-amber-200",
                  pillFg: "text-amber-800",
                };
          const label = labelById.get(iss.node_id) ?? "Unknown node";
          return (
            <div
              key={iss.node_id}
              className={`rounded-lg border ${palette.border} ${palette.bg} p-2.5`}
            >
              <div className="mb-1 flex items-center gap-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${palette.pillBg} ${palette.pillFg}`}
                >
                  {sev} · {iss.conflict_count} conflict
                  {iss.conflict_count === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mb-0.5 text-[11.5px] font-semibold text-slate-900">
                {label}
              </div>
              <div className="text-[11px] leading-snug text-slate-700">
                Open the node to see each conflicting claim side-by-side.
              </div>
              <div className="mt-2 flex gap-1">
                <button
                  onClick={() => onFocusNode(iss.node_id)}
                  className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] text-slate-700 hover:border-slate-500"
                >
                  → {label}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Review tab ─────────────────────────────────────────────
function ReviewTab({
  nodes,
  onFocusNode,
  reviewState,
  onSendRequest,
}: {
  nodes: { id: UUID; name: string }[];
  onFocusNode: (id: UUID) => void;
  reviewState?: ReviewState;
  onSendRequest: () => void;
}) {
  const total = reviewState?.counts.total ?? nodes.length;
  const approved = reviewState?.counts.approved ?? 0;
  const pct = total === 0 ? 0 : Math.round((approved / total) * 100);
  const byNode = reviewByNodeMap(reviewState?.nodes ?? []);
  const buckets = bucketNodes(nodes, byNode);
  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="mb-3 rounded-lg bg-gradient-to-br from-slate-800 to-slate-900 p-3 text-white">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Sign-off progress
        </div>
        <div className="mb-2 flex items-baseline gap-1.5">
          <span className="text-2xl font-bold tabular-nums">{approved}</span>
          <span className="text-xs text-slate-400">of {total} steps approved</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
          <div className="h-full bg-emerald-400 transition-all" style={{ width: `${pct}%` }} />
        </div>
        {reviewState?.request_status && (
          <div className="mt-2 text-[10px] uppercase tracking-wider text-slate-400">
            Status: {reviewState.version_status}
          </div>
        )}
        <button
          type="button"
          disabled={total === 0}
          onClick={onSendRequest}
          className="mt-2.5 w-full rounded-md bg-emerald-600 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500"
        >
          Send review request to stakeholders
        </button>
      </div>

      <Bucket title="Changes requested" count={buckets.changesRequested.length} colorDot="bg-rose-500" items={buckets.changesRequested} onFocusNode={onFocusNode} />
      <Bucket title="Pending" count={buckets.pending.length} colorDot="bg-slate-400" items={buckets.pending} onFocusNode={onFocusNode} />
      <Bucket title="Approved" count={buckets.approved.length} colorDot="bg-emerald-500" items={buckets.approved} onFocusNode={onFocusNode} />
    </div>
  );
}

function Bucket({
  title,
  count,
  colorDot,
  items,
  onFocusNode,
}: {
  title: string;
  count: number;
  colorDot: string;
  items?: { id: UUID; name: string }[];
  onFocusNode?: (id: UUID) => void;
}) {
  const [open, setOpen] = useState(title === "Pending");
  return (
    <div className="mb-2.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-1 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-900"
      >
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${colorDot}`} />
          {title} · {count}
        </span>
        <span className="text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {items && items.length > 0 ? (
            items.map((node) => (
              <div
                key={node.id}
                className="rounded-md border border-slate-200 bg-white px-2 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => onFocusNode?.(node.id)}
                    className="truncate text-left text-[11px] font-semibold text-slate-800 hover:underline"
                  >
                    {node.name}
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="px-1 text-[10.5px] italic text-slate-400">—</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sources tab ────────────────────────────────────────────
function SourcesTab({
  projectId,
  onOpenSource,
}: {
  projectId: UUID;
  onOpenSource: (target: ViewerTarget) => void;
}) {
  const inputsQuery = useQuery({
    queryKey: ["inputs", projectId],
    queryFn: () => api.listInputs(projectId, { limit: 200 }),
  });
  const items = inputsQuery.data?.items ?? [];
  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
        Source documents · {items.length}
      </div>
      {inputsQuery.isLoading && (
        <div className="text-[11px] italic text-slate-400">Loading…</div>
      )}
      <div className="space-y-1">
        {items.map((d) => (
          <DocumentRow key={d.id} input={d} onOpenSource={onOpenSource} />
        ))}
      </div>
      {!inputsQuery.isLoading && items.length === 0 && (
        <div className="py-8 text-center text-[11px] text-slate-400">
          No documents uploaded yet.
        </div>
      )}
      <div className="mt-4 text-center text-[10.5px] italic text-slate-400">
        Click a document to open it in the viewer. Per-node citations live in the
        Properties panel when a node is selected.
      </div>
    </div>
  );
}

function DocumentRow({
  input,
  onOpenSource,
}: {
  input: InputRow;
  onOpenSource: (target: ViewerTarget) => void;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        onOpenSource({
          inputId: input.id,
          inputName: input.name,
          sectionRef: null,
          quote: null,
        })
      }
      title="Open in viewer"
      className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left hover:border-violet-300 hover:bg-violet-50"
    >
      <FileText size={14} className="text-slate-500" />
      <span className="flex-1 truncate text-[11px] text-slate-700">
        {input.name}
      </span>
      {typeof input.claim_count === "number" && (
        <span className="text-[9.5px] tabular-nums text-slate-400">
          {input.claim_count} claim{input.claim_count === 1 ? "" : "s"}
        </span>
      )}
    </button>
  );
}

// ─── Refresh-from-claims tab ────────────────────────────────
function RefreshTab({
  projectId,
  modelId,
  versionId,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
}) {
  const queryClient = useQueryClient();
  const [batch, setBatch] = useState<ReconcileBatch | null>(null);
  const [resolved, setResolved] = useState<Record<string, "accepted" | "rejected" | "target_gone">>({});

  const invalidateCanvas = () => {
    queryClient.invalidateQueries({ queryKey: ["graph", projectId, modelId, versionId] });
    queryClient.invalidateQueries({ queryKey: ["issues", projectId, modelId, versionId] });
  };

  const reconcile = useMutation({
    mutationFn: () => api.reconcileMap(projectId, modelId, versionId),
    onSuccess: (data) => {
      setResolved({});
      setBatch(data);
    },
    onError: (e: Error) => toast.error(`Refresh failed: ${e.message}`),
  });

  const accept = useMutation({
    mutationFn: (id: UUID) => api.acceptSuggestion(projectId, id),
    onSuccess: (data, id) => {
      setResolved((r) => ({ ...r, [id]: data.outcome === "target_gone" ? "target_gone" : "accepted" }));
      invalidateCanvas();
    },
    onError: (e: Error) => toast.error(`Accept failed: ${e.message}`),
  });

  const reject = useMutation({
    mutationFn: (id: UUID) => api.rejectSuggestion(projectId, id),
    onSuccess: (_d, id) => {
      setResolved((r) => ({ ...r, [id]: "rejected" }));
      invalidateCanvas();
    },
    onError: (e: Error) => toast.error(`Reject failed: ${e.message}`),
  });

  const items: ReconcileSuggestion[] = batch && !batch.empty ? batch.suggestions : [];

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-slate-200 p-3">
        <button
          type="button"
          onClick={() => reconcile.mutate()}
          disabled={reconcile.isPending}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-violet-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-700 disabled:bg-slate-300"
        >
          <RotateCcw size={11} className={reconcile.isPending ? "animate-spin" : ""} />
          {reconcile.isPending ? "Checking claims…" : "Refresh from claims"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {!batch && !reconcile.isPending && (
          <p className="text-[11px] text-slate-500">
            Compare this map against its process&apos;s claims and propose targeted
            updates. Layout and hand edits are preserved.
          </p>
        )}
        {batch?.empty && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
            Map is in sync with its claims — nothing to reconcile.
          </div>
        )}
        {items.length > 0 && (
          <ul className="space-y-2">
            {items.map((s) => {
              const row = reconcileRow(s);
              const state = resolved[s.id];
              return (
                <li key={s.id} className="rounded border border-slate-200 p-2">
                  <div className="text-[12px] font-medium text-slate-800">{row.title}</div>
                  <div className="text-[11px] text-slate-500">{row.detail}</div>
                  {s.rationale && (
                    <p className="mt-1 text-[11px] text-slate-500">{s.rationale}</p>
                  )}
                  {state ? (
                    <span className="mt-1 inline-block text-[11px] font-medium text-slate-400">
                      {state === "accepted"
                        ? "Accepted"
                        : state === "target_gone"
                          ? "No change — target was deleted"
                          : "Rejected"}
                    </span>
                  ) : (
                    <div className="mt-1.5 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => accept.mutate(s.id)}
                        disabled={accept.isPending && accept.variables === s.id}
                        className="rounded bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white hover:bg-slate-700 disabled:bg-slate-300"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => reject.mutate(s.id)}
                        disabled={reject.isPending && reject.variables === s.id}
                        className="rounded px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Change Log tab ─────────────────────────────────────────
function ChangeLogTab({
  projectId,
  modelId,
  selected,
  onFocusNode,
}: {
  projectId: UUID;
  modelId: UUID;
  selected: { id: UUID; kind: "node" | "edge"; name?: string } | null;
  onFocusNode: (id: UUID) => void;
}) {
  // When a node or edge is selected, we default to showing only changes for
  // that object; the user can toggle back to the model-wide view.
  const [filterToSelection, setFilterToSelection] = useState(true);

  const targetId =
    selected !== null && filterToSelection ? selected.id : undefined;

  const query = useInfiniteQuery<ChangeLogPage>({
    queryKey: ["changelog", projectId, modelId, targetId],
    queryFn: ({ pageParam }) =>
      api.getChangeLog(projectId, modelId, {
        target_id: targetId,
        cursor: pageParam as string | undefined,
        limit: 50,
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });

  const allItems = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* Filter bar — only shown when something is selected */}
      {selected !== null && (
        <div className="shrink-0 border-b border-slate-100 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[10.5px] text-slate-500">
              {filterToSelection ? (
                <>
                  Changes for{" "}
                  <span className="font-semibold text-slate-700">
                    {selected.name ?? selected.id.slice(0, 8)}
                  </span>
                </>
              ) : (
                <span className="italic">All changes in this model</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => setFilterToSelection((v) => !v)}
              className="shrink-0 rounded border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
            >
              {filterToSelection ? "Show all" : "Show selected"}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Change Log
        </div>

        {query.isLoading && (
          <div className="text-[11px] italic text-slate-400">Loading…</div>
        )}
        {query.isError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
            {(query.error as Error).message}
          </div>
        )}
        {!query.isLoading && allItems.length === 0 && (
          <div className="py-8 text-center text-[11px] text-slate-400">
            No changes recorded yet.
          </div>
        )}

        <div className="space-y-1.5">
          {allItems.map((evt) => (
            <ChangeEntry
              key={evt.id}
              event={evt}
              onFocus={evt.target_type === "node" ? onFocusNode : undefined}
            />
          ))}
        </div>

        {query.hasNextPage && (
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="mt-3 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[10.5px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}

// Re-export type so consumers know the orchestrator's tab id list.
export type { ReactNode };
