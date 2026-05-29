"use client";

/**
 * Right-side panel with tabs: Chat, Versions, Issues, Review, Sources.
 * Mirrors the Claude Design prototype layout (poet-workspace/src/audit.jsx).
 *
 * Tabs are collapsed to icon-only when inactive; the active tab gets
 * `flex-1` plus its label. The whole panel can also collapse to a vertical
 * icon rail.
 *
 * Versions and Review are intentionally minimal until backend tracking
 * lands — UI is in place so users can see where those features will live.
 */

import {
  ChevronLeft,
  ChevronRight,
  FileText,
  GitBranch,
  Link2,
  MessageSquare,
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
import { useMutation, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type {
  ChatTurn,
  InputRow,
  NodeIssue,
  ProcessVersion,
  ReviewState,
  UUID,
} from "@/lib/types";
import { bucketNodes, reviewByNodeMap } from "./review-summary";

type TabId = "chat" | "versions" | "issues" | "review" | "sources";

const TAB_LABELS: Record<TabId, string> = {
  chat: "Chat",
  versions: "Versions",
  issues: "Issues",
  review: "Review",
  sources: "Sources",
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
  version,
  nodes,
  selected,
  onFocusNode,
  reviewState,
  onSendRequest,
  collapsed,
  onCollapsedChange,
  initialTab = "chat",
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  version: ProcessVersion | null;
  nodes: { id: UUID; name: string; type: string; lane_id: UUID | null }[];
  selected: SelectedRef | null;
  /** Sets the canvas selection. Used by Issues "→ Node" links. */
  onFocusNode: (id: UUID) => void;
  reviewState?: ReviewState;
  onSendRequest: () => void;
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
        {tab === "versions" && <VersionsTab version={version} />}
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
        {tab === "sources" && <SourcesTab projectId={projectId} />}
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
function VersionsTab({ version }: { version: ProcessVersion | null }) {
  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Version History
        </div>
        <button
          disabled
          title="Branching coming soon"
          className="rounded bg-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-500"
        >
          + Branch
        </button>
      </div>

      <div className="mb-4">
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-[11px] font-bold text-slate-800">main</span>
        </div>
        <div className="ml-1 space-y-1.5 border-l-2 border-slate-200 pl-3">
          {version ? (
            <div className="relative rounded-md border border-slate-300 bg-slate-100 px-2 py-1.5">
              <div className="absolute -left-[17px] top-2.5 h-2 w-2 rounded-full border-2 border-slate-400 bg-white" />
              <div className="mb-0.5 flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-slate-400">
                  v{version.version_number}
                </span>
                <span className="rounded bg-emerald-100 px-1 py-px text-[9px] font-bold text-emerald-700">
                  HEAD
                </span>
                <span className="rounded bg-slate-200 px-1 py-px text-[9px] font-bold text-slate-700">
                  {version.status}
                </span>
              </div>
              <div className="text-[11px] leading-snug text-slate-800">
                Initial map generation
              </div>
              <div className="mt-0.5 text-[10px] text-slate-400">
                {new Date(version.created_at).toLocaleString()}
              </div>
            </div>
          ) : (
            <div className="text-[11px] italic text-slate-400">
              No versions yet
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
        Branching, commits, and merge tooling are coming. For now you can see
        the active version above.
      </div>
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
function SourcesTab({ projectId }: { projectId: UUID }) {
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
          <DocumentRow key={d.id} input={d} />
        ))}
      </div>
      {!inputsQuery.isLoading && items.length === 0 && (
        <div className="py-8 text-center text-[11px] text-slate-400">
          No documents uploaded yet.
        </div>
      )}
      <div className="mt-4 text-center text-[10.5px] italic text-slate-400">
        Per-node citations live in the Properties panel when a node is selected.
      </div>
    </div>
  );
}

function DocumentRow({ input }: { input: InputRow }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5">
      <FileText size={14} className="text-slate-500" />
      <span className="flex-1 truncate text-[11px] text-slate-700">
        {input.name}
      </span>
      {typeof input.claim_count === "number" && (
        <span className="text-[9.5px] tabular-nums text-slate-400">
          {input.claim_count} claim{input.claim_count === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

// Re-export type so consumers know the orchestrator's tab id list.
export type { ReactNode };
