"use client";

import { ChevronRight, Pause, Play, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type {
  ActivityStep,
  ChatSuggestion,
  ChatTurn,
  GroupSummary,
  MentionSource,
  ObjectRef,
  ProcessGraph,
  UUID,
  ViewerTarget,
} from "@/lib/types";
import { MentionMarkdown } from "./mention-view";
import { traceHeaderLabel, showUngroundedWarning } from "./agent-trace";
import {
  selectionChips,
  selectionToContextRefs,
  type ContextChip,
  type SelectedObject,
} from "./chat-context";
import { browserChatSessionStore } from "./chat-session";
import { toRequestHistory } from "./chat-history";
import { restoreAfterCancel, type PendingSend } from "./chat-cancel";
import { bundleSuggestions, indexGraph, planBundle, type Bundle, type BundlePlan, type BatchResult } from "./suggestion-apply";
import { bundleNewNames } from "./suggestion-display";
import { SuggestionList, type CardStatus } from "./suggestion-card";

export type ChatItem = ChatTurn & {
  contextNote?: string;
  /** The objects attached as grounding context when this turn was sent, rendered
   * as a collapsible row of clickable step links. `contextNote` is kept as a
   * plain-text fallback for turns persisted before refs were stored. */
  contextRefs?: ContextChip[];
  sources?: MentionSource[];
  suggestions?: ChatSuggestion[];
  suggestionStatus?: Record<string, CardStatus>;
  groupSummaries?: GroupSummary[];
  activityTrace?: ActivityStep[];
  grounded?: boolean;
  runId?: string | null;
};

const SUGGESTED_PROMPTS: Record<"ask" | "suggest", string[]> = {
  ask: [
    "Find any gaps in this flow",
    "Which steps lack source citations?",
    "Compare this against typical processes",
  ],
  suggest: [
    "Add the missing approval step",
    "Fix the order of these two steps",
    "Split this step into its sub-steps",
  ],
};

export function ChatTab({
  projectId,
  modelId,
  versionId,
  selected,
  nodes,
  onNavigate,
  onOpenSource,
  onApplySuggestions,
  graph,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  selected: SelectedObject[];
  nodes: { id: UUID; name: string; type: string; lane_id: UUID | null }[];
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  onOpenSource: (t: ViewerTarget) => void;
  onApplySuggestions: (plan: BundlePlan) => Promise<BatchResult>;
  graph: ProcessGraph;
}) {
  const sessionStore = useMemo(() => browserChatSessionStore(), []);
  const [showExamples, setShowExamples] = useState(false);
  const [mode, setMode] = useState<"ask" | "suggest">("ask");
  const [history, setHistory] = useState<ChatItem[]>(() => sessionStore.load(versionId) as ChatItem[]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  // Bumped whenever the thread is cleared. Each request carries the generation
  // it was sent under; a reply whose generation is stale is dropped so a
  // cleared conversation can't be rebuilt by a late-resolving request.
  const genRef = useRef(0);
  // The in-flight request's controller, so Pause can abort it.
  const abortRef = useRef<AbortController | null>(null);
  // Snapshot of what Pause must restore (pre-send transcript + the user's text).
  const pendingRef = useRef<PendingSend<ChatItem> | null>(null);
  // In-memory undo handles, keyed by bundle id. Not persisted — reloaded applied
  // cards won't show an inline Undo, by design.
  const undoHandles = useRef<Map<string, () => Promise<void>>>(new Map());
  // Per-bundle apply-failure message, shown on the card instead of a generic
  // "Failed". Keyed by bundle id (unique across the thread).
  const [bundleErrorById, setBundleErrorById] = useState<Record<string, string>>({});

  useEffect(() => {
    // Switching threads (version change): drop any in-flight reply from the old
    // version and clear ALL per-thread transient state, so stale undo handles or
    // apply errors can't leak into the new conversation if a bundle id recurs.
    genRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    pendingRef.current = null;
    undoHandles.current.clear();
    setBundleErrorById({});
    setHistory(sessionStore.load(versionId) as ChatItem[]);
  }, [versionId, sessionStore]);

  const labelById = useMemo(() => {
    const m = new Map<UUID, string>();
    for (const n of nodes) m.set(n.id, n.name);
    return m;
  }, [nodes]);

  // Lane id → name, so a suggestion card's [[lane:uuid]] mention (e.g. a
  // move-to-lane destination) renders the lane's name instead of being dropped.
  const laneNameById = useMemo(() => {
    const m = new Map<UUID, string>();
    for (const l of graph.lanes) m.set(l.id, l.name);
    return m;
  }, [graph]);

  const graphIndex = useMemo(() => indexGraph(graph), [graph]);

  // The chat keeps its OWN context list, decoupled from the live canvas
  // selection (#3). A non-empty canvas selection REPLACES it; deselecting
  // (clicking empty canvas, Escape, etc.) leaves it intact — so the attached
  // context isn't silently lost before the message is sent. The context tab's
  // ✕ controls edit THIS list only; they no longer deselect the canvas node or
  // close the Properties panel.
  const [chatContext, setChatContext] = useState<SelectedObject[]>([]);
  // Key on the SET of selected ids, not the array reference: a graph refetch
  // (e.g. after applying a suggestion) hands us a new `selected` array with the
  // same ids, and we must NOT re-sync then — otherwise a context the user cleared
  // by sending would silently re-attach. A real selection change (different ids)
  // replaces the list; deselecting (empty) leaves it intact.
  const selectedIdsKey = selected.map((s) => s.id).join("|");
  useEffect(() => {
    if (selected.length > 0) setChatContext(selected);
    // selectedIdsKey is derived from `selected`; re-sync only when the id SET
    // changes, hence the narrowed dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdsKey]);

  const chips = selectionChips(chatContext, labelById);

  // A stable per-version chat session id, persisted in sessionStorage alongside
  // the transcript (survives tab nav, resets on hard reload). Sent with each ask
  // so agent runs are groupable by conversation. Layer 1 will formalize richer
  // session lifecycle (new/compact/clear); this is the minimal grouping key.
  const sessionId = useMemo(() => {
    if (typeof window === "undefined" || !window.sessionStorage) return null;
    const k = `poet-chat-sid:${versionId}`;
    let sid = window.sessionStorage.getItem(k);
    if (!sid) {
      sid = crypto.randomUUID();
      window.sessionStorage.setItem(k, sid);
    }
    return sid;
  }, [versionId]);

  const ask = useMutation({
    mutationFn: (input: { history: ChatItem[]; userMessage: string; note?: string; contextChips?: ContextChip[]; contextRefs: ObjectRef[]; gen: number; signal: AbortSignal; mode: "ask" | "suggest" }) =>
      api.chatSuggest(
        projectId,
        modelId,
        versionId,
        {
          // Send only the backend contract fields (ChatTurn = role + content);
          // client-only metadata like contextNote/sources must not be resent.
          // toRequestHistory also coerces empty/whitespace content to a
          // placeholder — suggest-mode replies can have empty prose, and the
          // server rejects content shorter than 1 char (422).
          history: toRequestHistory(input.history),
          user_message: input.userMessage,
          mode: input.mode,
          context_refs: input.contextRefs,
          session_id: sessionId,
        },
        input.signal
      ),
    onSuccess: (data, vars) => {
      // Drop replies that resolve after the thread was cleared.
      if (vars.gen !== genRef.current) return;
      const next: ChatItem[] = [
        ...vars.history,
        { role: "user", content: vars.userMessage, contextNote: vars.note, contextRefs: vars.contextChips },
        // Carry this message's source mapping ON the message so it survives
        // reload and isn't lost when component state resets.
        {
          role: "assistant",
          content: data.message,
          sources: data.mention_sources,
          suggestions: data.suggestions.length ? data.suggestions : undefined,
          suggestionStatus: {},
          groupSummaries: data.group_summaries.length ? data.group_summaries : undefined,
          activityTrace: data.activity_trace ?? [],
          grounded: data.grounded,
          runId: data.run_id ?? null,
        },
      ];
      sessionStore.save(versionId, next);
      setHistory(next);
      // The send completed; drop the snapshot so pendingRef means "a send is in flight".
      pendingRef.current = null;
    },
    onError: (err) => {
      // Aborts are user-initiated cancels (Pause), not errors — ignore them.
      // (The render-time banner guard also masks AbortError; this keeps the
      // suppression intent local to the mutation and matches the design spec.)
      if (err instanceof DOMException && err.name === "AbortError") return;
    },
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, ask.isPending]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    // Capture the attached context refs + note NOW from the chat's own list.
    const contextRefs = selectionToContextRefs(chatContext);
    // Snapshot the display chips too, so the sent turn keeps a clickable context
    // row (and a plain-text note as a fallback for older persisted turns).
    const contextChips = chips.length ? chips : undefined;
    const note = chips.length ? chips.map((c) => c.label).join(", ") : undefined;
    // Capture mode at submit time so a later toggle doesn't change an in-flight request.
    const currentMode = mode;
    setDraft("");
    // Capture pre-send history snapshot before optimistic update
    const preSendHistory = history;
    // Snapshot what Pause needs to undo this send, and open an abort channel.
    pendingRef.current = { priorHistory: preSendHistory, text: trimmed };
    const controller = new AbortController();
    abortRef.current = controller;
    setHistory((curr) => [...curr, { role: "user", content: trimmed, contextNote: note, contextRefs: contextChips }]);
    ask.mutate({
      history: preSendHistory,
      userMessage: trimmed,
      note,
      contextChips,
      contextRefs,
      gen: genRef.current,
      signal: controller.signal,
      mode: currentMode,
    });
    // Clear the chat context on send: the tab slides away and the attached objects
    // are recorded on the message itself (contextNote, shown under the prompt). The
    // canvas selection is deliberately left alone — so the Properties panel stays
    // open and reflects an applied suggestion live, and selection stays decoupled
    // from chat context (#3).
    setChatContext([]);
  };

  const pause = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Bump the generation so any reply that still resolves after the abort is
    // dropped by onSuccess, and reset the mutation to clear the pending state.
    genRef.current += 1;
    ask.reset();
    const pending = pendingRef.current;
    if (pending) {
      const restored = restoreAfterCancel(pending);
      setHistory(restored.history);
      setDraft(restored.draft);
    }
    pendingRef.current = null;
  };

  const clearChat = () => {
    // Invalidate any in-flight reply so it isn't restored after the clear, and
    // reset the mutation so the "Thinking…" indicator stops immediately.
    genRef.current += 1;
    ask.reset();
    abortRef.current = null;
    pendingRef.current = null;
    // Clear per-thread transient state too, so a later bundle can't inherit a
    // stale Undo handle or error message from the cleared conversation.
    undoHandles.current.clear();
    setBundleErrorById({});
    sessionStore.clear(versionId);
    setHistory([]);
  };

  const setBundleStatus = (msgIndex: number, bundleId: string, status: CardStatus) => {
    setHistory((curr) => {
      const next = curr.map((m, i) =>
        i === msgIndex
          ? { ...m, suggestionStatus: { ...(m.suggestionStatus ?? {}), [bundleId]: status } }
          : m
      );
      sessionStore.save(versionId, next);
      return next;
    });
  };

  const applyBundle = async (msgIndex: number, bundle: Bundle) => {
    setBundleStatus(msgIndex, bundle.id, "applying");
    const plan = planBundle(bundle, graphIndex);
    const res = await onApplySuggestions(plan);
    if (res.ok) {
      if (res.undo) undoHandles.current.set(bundle.id, res.undo);
      setBundleErrorById((prev) => {
        if (!(bundle.id in prev)) return prev;
        const next = { ...prev };
        delete next[bundle.id];
        return next;
      });
      setBundleStatus(msgIndex, bundle.id, "applied");
    } else {
      const msg = res.error ?? "Couldn't apply this change.";
      toast.error(msg);
      setBundleErrorById((prev) => ({ ...prev, [bundle.id]: msg }));
      setBundleStatus(msgIndex, bundle.id, "failed");
    }
  };

  const undoBundle = async (bundleId: string) => {
    const fn = undoHandles.current.get(bundleId);
    if (!fn) return;
    try {
      await fn();
    } catch (err) {
      // A failed undo means the canvas is still in the applied state — keep the
      // card "applied" and retain the handle so Undo can be retried. Do NOT
      // blanket-reset to "pending".
      toast.error("Couldn't undo that change — try refreshing the map.");
      return;
    }
    undoHandles.current.delete(bundleId);
    // Reflect revert in whichever message owns this bundle.
    setHistory((curr) => {
      const next = curr.map((m) =>
        m.suggestionStatus?.[bundleId]
          ? { ...m, suggestionStatus: { ...m.suggestionStatus, [bundleId]: "pending" as CardStatus } }
          : m
      );
      sessionStore.save(versionId, next);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-3 py-3"
        style={{ paddingBottom: chips.length ? 44 : undefined }}
      >
        <div className="flex items-start justify-between gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5">
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-indigo-700">
              POET Assistant
            </div>
            <div className="text-[11.5px] leading-relaxed text-indigo-900/80">
              Grounded in this map&apos;s claims and citations. I link the steps
              and transitions I mention — click to jump to them.
            </div>
          </div>
          {history.length > 0 && (
            <button
              onClick={clearChat}
              className="shrink-0 rounded-full border border-indigo-200 px-2 py-0.5 text-[10px] text-indigo-700 hover:bg-indigo-100"
            >
              Clear
            </button>
          )}
        </div>

        {history.map((m, i) => {
          // User turns render right-aligned with no avatar.
          if (m.role !== "assistant") {
            return (
              <ChatMsg key={i} turn={m} labelById={labelById} onNavigate={onNavigate} onOpenSource={onOpenSource} />
            );
          }
          // Assistant turns: one ✨ avatar fronting the prose bubble (if any) and
          // the suggestion cards. A cards-only reply still gets the avatar.
          const bundles = m.suggestions ? bundleSuggestions(m.suggestions) : null;
          // Per-message maps so card title/rationale render the same named links
          // as prose, and a group's purpose summary can be looked up.
          const sourceNameByClaim = new Map<UUID, string>((m.sources ?? []).map((s) => [s.claim_id, s.input_name]));
          const sourceTargetByClaim = new Map<UUID, ViewerTarget>(
            (m.sources ?? []).map((s) => [
              s.claim_id,
              { inputId: s.input_id, inputName: s.input_name, sectionRef: s.section_ref, quote: s.quote },
            ])
          );
          // Planned names for objects the suggestions create, so a card's
          // `[[new:<ref>]]` chip shows the real name instead of "new step".
          const newNameByRef = m.suggestions ? bundleNewNames(m.suggestions) : undefined;
          const renderText = (text: string) => (
            <MentionMarkdown
              text={text}
              labelById={labelById}
              sourceNameByClaim={sourceNameByClaim}
              sourceTargetByClaim={sourceTargetByClaim}
              laneNameById={laneNameById}
              newNameByRef={newNameByRef}
              onNavigate={onNavigate}
              onOpenSource={onOpenSource}
            />
          );
          const summaryById = new Map((m.groupSummaries ?? []).map((g) => [g.id, g.summary]));
          return (
            <div key={i} className="flex items-start gap-2">
              <Sparkles size={16} className="mt-1 flex-shrink-0 text-indigo-500" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <ChatMsg turn={m} labelById={labelById} onNavigate={onNavigate} onOpenSource={onOpenSource} />
                {m.role === "assistant" && showUngroundedWarning(m.grounded) && (
                  <div className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[9.5px] font-medium text-amber-700">
                    Not grounded in your sources
                  </div>
                )}
                {m.role === "assistant" && m.activityTrace && m.activityTrace.length > 0 && (
                  <ActivityTrace steps={m.activityTrace} />
                )}
                {bundles && (
                  <SuggestionList
                    bundles={bundles}
                    statusById={m.suggestionStatus ?? {}}
                    canUndoById={Object.fromEntries(bundles.map((b) => [b.id, undoHandles.current.has(b.id)]))}
                    onApply={(b) => applyBundle(i, b)}
                    onUndo={undoBundle}
                    onDismiss={(id) => setBundleStatus(i, id, "dismissed")}
                    onRestore={(id) => setBundleStatus(i, id, "pending")}
                    renderText={renderText}
                    summaryById={summaryById}
                    errorById={bundleErrorById}
                  />
                )}
              </div>
            </div>
          );
        })}

        {ask.isPending && (
          <div className="flex items-start gap-2">
            <Sparkles size={16} className="mt-1 flex-shrink-0 text-indigo-500" />
            <div className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "0s" }} />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "0.15s" }} />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "0.3s" }} />
                <span className="ml-2 text-[11px] text-slate-500">Thinking…</span>
              </div>
            </div>
          </div>
        )}

        {ask.isError &&
          !(ask.error instanceof DOMException && ask.error.name === "AbortError") && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
              {ask.error instanceof Error ? ask.error.message : "An error occurred"}
            </div>
          )}
      </div>

      <div className="relative shrink-0">
        {/* Context tab — sits behind the composer and slides up when objects
            are selected; tucks back down (hidden) when the selection clears. */}
        <div
          className={
            "absolute inset-x-2 bottom-full z-0 transition-transform duration-200 ease-out " +
            (chips.length > 0
              ? "translate-y-0"
              : "translate-y-full pointer-events-none")
          }
        >
          <div className="rounded-t-lg border border-b-0 border-slate-200 bg-slate-50 px-2 pb-3 pt-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">
                Context
              </span>
              {chips.map((c) => (
                <span key={`${c.kind}:${c.id}`} className="group relative inline-flex">
                  <button
                    onClick={() => onNavigate({ kind: c.kind, id: c.id })}
                    className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white py-0.5 pl-2 pr-5 text-[10px] text-slate-700 hover:bg-slate-100"
                    title="Jump to this step"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                    {c.label}
                  </button>
                  <button
                    onClick={() =>
                      setChatContext((curr) => curr.filter((s) => s.id !== c.id))
                    }
                    title="Remove from context"
                    className="absolute right-0.5 top-1/2 hidden -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 group-hover:block"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              <button
                onClick={() => setChatContext([])}
                title="Clear context"
                className="ml-auto flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700"
              >
                <X size={11} />
              </button>
            </div>
          </div>
        </div>

        {/* Composer — in front (z-10), casts a soft shadow up onto the tab. */}
        <div
          className="relative z-10 border-t border-slate-200 bg-white p-2"
          style={{ boxShadow: "0 -6px 14px -8px rgba(15, 23, 42, 0.18)" }}
        >
          {showExamples && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {SUGGESTED_PROMPTS[mode].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setShowExamples(false);
                    submit(s);
                  }}
                  className="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-200"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="mb-1.5 inline-flex rounded-md border border-slate-200 p-0.5 text-[10px]">
            {(["ask", "suggest"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={
                  "rounded px-2 py-0.5 font-semibold capitalize transition " +
                  (mode === m ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-800")
                }
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-1.5">
            <button
              onClick={() => setShowExamples((v) => !v)}
              title="Example prompts"
              aria-label="Toggle example prompts"
              className={
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition " +
                (showExamples
                  ? "border-indigo-300 bg-indigo-50 text-indigo-600"
                  : "border-slate-200 text-slate-400 hover:bg-slate-50 hover:text-slate-700")
              }
            >
              <Sparkles size={14} />
            </button>
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
              // Cancel is click-only by design: Enter sends; the button toggles to
              // Pause mid-flight, but Enter never cancels.
              onClick={() => (ask.isPending ? pause() : submit(draft))}
              disabled={!ask.isPending && !draft.trim()}
              title={ask.isPending ? "Stop" : "Send"}
              aria-label={ask.isPending ? "Stop generating" : "Send message"}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              {ask.isPending ? <Pause size={14} /> : <Play size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The grounding context attached to a sent user turn: collapsed to a
 * "Context · N ▸" summary, expanding to clickable step links that teleport +
 * flash the object on the canvas. Default collapsed to keep the turn compact. */
function ContextRow({
  chips,
  onNavigate,
}: {
  chips: ContextChip[];
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-0.5 text-[9.5px] font-medium text-slate-400 hover:text-slate-600"
      >
        <ChevronRight size={10} className={"transition-transform " + (open ? "rotate-90" : "")} />
        Context · {chips.length}
      </button>
      {open && (
        <div className="flex flex-wrap justify-end gap-1">
          {chips.map((c) => (
            <button
              key={`${c.kind}:${c.id}`}
              type="button"
              onClick={() => onNavigate({ kind: c.kind, id: c.id })}
              title="Jump to this step"
              className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px] text-slate-700 hover:bg-slate-100"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The AI's tool-use trace for an ask-mode answer: collapsed to a "How I found
 * this · N steps ▸" summary, expanding to an ordered list of tool-call
 * summaries. Default collapsed to match ContextRow's disclosure style. */
function ActivityTrace({ steps }: { steps: ActivityStep[] }) {
  const [open, setOpen] = useState(false);
  const label = traceHeaderLabel(steps);
  if (!label) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-0.5 text-[9.5px] font-medium text-slate-400 hover:text-slate-600"
      >
        <ChevronRight size={10} className={"transition-transform " + (open ? "rotate-90" : "")} />
        {label}
      </button>
      {open && (
        <ol className="mt-0.5 space-y-0.5 pl-3">
          {steps.map((s, idx) => (
            <li key={idx} className="text-[10px] leading-snug text-slate-500" title={s.detail ?? undefined}>
              {s.summary}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ChatMsg({
  turn,
  labelById,
  onNavigate,
  onOpenSource,
}: {
  turn: ChatItem;
  labelById: Map<UUID, string>;
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  onOpenSource: (t: ViewerTarget) => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-lg bg-slate-900 px-3 py-2 text-[11.5px] leading-relaxed text-white">
          {turn.content}
        </div>
        {turn.contextRefs && turn.contextRefs.length > 0 ? (
          <ContextRow chips={turn.contextRefs} onNavigate={onNavigate} />
        ) : (
          // Fallback for turns persisted before context refs were stored.
          turn.contextNote && (
            <div className="text-[9.5px] text-slate-400">Context: {turn.contextNote}</div>
          )
        )}
      </div>
    );
  }
  // A suggest-mode reply can have empty prose (only suggestion cards). Don't
  // render an empty assistant bubble — the cards render separately beneath it.
  if (!turn.content.trim()) return null;
  // Build this message's own claim→source maps from the sources attached to it.
  const sourceNameByClaim = new Map<UUID, string>(
    (turn.sources ?? []).map((s) => [s.claim_id, s.input_name])
  );
  const sourceTargetByClaim = new Map<UUID, ViewerTarget>(
    (turn.sources ?? []).map((s) => [
      s.claim_id,
      { inputId: s.input_id, inputName: s.input_name, sectionRef: s.section_ref, quote: s.quote },
    ])
  );
  // Just the prose bubble — the ✨ avatar is rendered once at the row level so
  // it also fronts a cards-only (empty-prose) reply.
  return (
    <div className="poet-chat-md rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11.5px] leading-relaxed text-slate-800">
      <MentionMarkdown
        text={turn.content}
        labelById={labelById}
        sourceNameByClaim={sourceNameByClaim}
        sourceTargetByClaim={sourceTargetByClaim}
        onNavigate={onNavigate}
        onOpenSource={onOpenSource}
      />
    </div>
  );
}
