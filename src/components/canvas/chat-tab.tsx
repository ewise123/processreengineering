"use client";

import { ChevronRight, Pause, Play, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type {
  ActivityStep,
  AgentQuestion,
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
import { mentionsToPlainText } from "./mention-markdown";
import { traceHeaderLabel } from "./agent-trace";
import {
  buildSendContext,
  pruneMissingContext,
  selectionChips,
  type ContextChip,
  type SelectedObject,
} from "./chat-context";
import { browserChatSessionStore } from "./chat-session";
import { toRequestHistory } from "./chat-history";
import { restoreAfterCancel, type PendingSend } from "./chat-cancel";
import { bundleSuggestions, indexGraph, planBundle, type Bundle, type BundlePlan, type BatchResult } from "./suggestion-apply";
import { bundleNewNames } from "./suggestion-display";
import { SuggestionList, type CardStatus } from "./suggestion-card";
import { assistantItemFromResponse } from "./chat-tab-helpers";
import { QuestionSet } from "./question-set";

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
  /** Present when this assistant turn asked one or more clarifying questions. */
  questions?: AgentQuestion[];
  /** Set once the user has submitted answers to `questions` (locks the set). */
  questionsAnswered?: boolean;
};

const SUGGESTED_PROMPTS: string[] = [
  "Find any gaps in this flow",
  "Which steps lack source citations?",
  "Add the missing approval step",
  "Fix the order of these two steps",
  "Split this step into its sub-steps",
  "Compare this against typical processes",
];

const sidKey = (versionId: UUID) => `poet-chat-sid:${versionId}`;

/** Read the version's stored chat-session id, minting one if absent. */
function readOrMintSessionId(versionId: UUID): string | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  let sid = window.sessionStorage.getItem(sidKey(versionId));
  if (!sid) {
    sid = crypto.randomUUID();
    window.sessionStorage.setItem(sidKey(versionId), sid);
  }
  return sid;
}

/** Rotate to a fresh chat-session id (new conversation), persisting it. */
function mintSessionId(versionId: UUID): string | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  const sid = crypto.randomUUID();
  window.sessionStorage.setItem(sidKey(versionId), sid);
  return sid;
}

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
    setSessionId(readOrMintSessionId(versionId));
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

  // The pending attachment for the NEXT message only — consumable, not a
  // working set. It's decoupled from the live canvas selection (#3): a
  // non-empty canvas selection REPLACES it; deselecting (clicking empty
  // canvas, Escape, etc.) leaves it intact, so the attached context isn't
  // silently lost before the message is sent. The context tab's ✕ controls
  // edit THIS list only; they no longer deselect the canvas node or close the
  // Properties panel. `submit` consumes it into that one message's
  // context_refs and clears it immediately after — it never accumulates
  // across messages, and later messages send no context_refs unless the user
  // makes a new selection.
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

  // Prune attached context whose object was deleted from the map, so a stale
  // chip doesn't linger (and a deleted node isn't sent as context). Keyed on the
  // live node/edge id sets.
  const existingObjectIdsKey =
    graph.nodes.map((n) => n.id).join("|") + "#" + graph.edges.map((e) => e.id).join("|");
  useEffect(() => {
    const ids = new Set<string>([...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id)]);
    setChatContext((curr) => pruneMissingContext(curr, ids));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingObjectIdsKey]);

  const chips = selectionChips(chatContext, labelById);

  // Per-conversation chat session id (grouping key for agent_runs), persisted in
  // sessionStorage per version. Resettable state so it rotates on Clear (new
  // conversation) and re-derives on version switch. Layer 1 formalizes richer
  // session lifecycle later.
  const [sessionId, setSessionId] = useState<string | null>(() => readOrMintSessionId(versionId));

  const ask = useMutation({
    mutationFn: (input: { history: ChatItem[]; userMessage: string; note?: string; contextChips?: ContextChip[]; contextRefs: ObjectRef[]; gen: number; signal: AbortSignal }) =>
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
          // `mode` deliberately omitted: the backend's agent loop always
          // investigates-and-proposes and ignores it (see ChatSuggestRequest).
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
        assistantItemFromResponse(data),
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

  // `baseHistory` overrides the pre-send snapshot when the caller has already
  // computed the history this send should build on — e.g. answering a clarifying
  // question marks that question `questionsAnswered` and must carry that flag
  // through onSuccess (which rebuilds from this snapshot); otherwise the flag,
  // set via a separate setHistory, is clobbered when the reply lands and the
  // question re-renders unanswered.
  const submit = (text: string, baseHistory?: ChatItem[]) => {
    const trimmed = text.trim();
    if (!trimmed || ask.isPending) return;
    // Context is consumable, not a persistent working set: this send's
    // context_refs come from whatever is pending right now (and nothing else).
    // A follow-up with no new selection sends no context_refs — the agent
    // relies on this turn's refs already being in the conversation history.
    const { refs: contextRefs, chips: contextChips, note } = buildSendContext(chatContext, labelById);
    setDraft("");
    // Capture pre-send history snapshot before optimistic update
    const preSendHistory = baseHistory ?? history;
    // Snapshot what Pause must undo this send, and open an abort channel.
    pendingRef.current = { priorHistory: preSendHistory, text: trimmed };
    const controller = new AbortController();
    abortRef.current = controller;
    setHistory(() => [...preSendHistory, { role: "user", content: trimmed, contextNote: note, contextRefs: contextChips }]);
    ask.mutate({
      history: preSendHistory,
      userMessage: trimmed,
      note,
      contextChips,
      contextRefs,
      gen: genRef.current,
      signal: controller.signal,
    });
    // Clear the pending attachment on send: the tab slides away and the attached
    // objects are recorded on the message itself (contextNote/contextRefs, shown
    // under the prompt). The canvas selection is deliberately left alone — so the
    // Properties panel stays open and reflects an applied suggestion live, and
    // selection stays decoupled from chat context (#3). Nothing is retained as a
    // working set: the next message sends no context_refs unless the user makes
    // a new selection.
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
    // Clear = a new conversation: rotate the session id so its agent_runs aren't
    // grouped under the previous chat on this version.
    setSessionId(mintSessionId(versionId));
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
              <ChatMsg key={`${versionId}-${i}`} turn={m} labelById={labelById} onNavigate={onNavigate} onOpenSource={onOpenSource} />
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
              sources={m.sources}
              laneNameById={laneNameById}
              newNameByRef={newNameByRef}
              onNavigate={onNavigate}
              onOpenSource={onOpenSource}
            />
          );
          // Same maps as renderText, but flattening mentions to plain names — used
          // when composing the answer message so it reads as prose (not [[uuid]]).
          const plainText = (text: string) =>
            mentionsToPlainText(text, labelById, sourceNameByClaim, laneNameById, newNameByRef);
          const summaryById = new Map((m.groupSummaries ?? []).map((g) => [g.id, g.summary]));
          return (
            <div key={`${versionId}-${i}`} className="flex items-start gap-2">
              <Sparkles size={16} className="mt-1 flex-shrink-0 text-indigo-500" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <ChatMsg turn={m} labelById={labelById} onNavigate={onNavigate} onOpenSource={onOpenSource} />
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
                    lanes={graph.lanes}
                  />
                )}
                {m.role === "assistant" && m.questions && m.questions.length > 0 && (
                  <QuestionSet
                    questions={m.questions}
                    renderText={renderText}
                    plainText={plainText}
                    disabled={ask.isPending}
                    answered={m.questionsAnswered}
                    onSubmit={(composed) => {
                      // Mark this question answered on the SEND's base history so the
                      // flag survives onSuccess (which rebuilds from that snapshot) and
                      // is persisted — the question stays closed across reloads/remounts.
                      const flagged = history.map((it, idx) => (idx === i ? { ...it, questionsAnswered: true } : it));
                      submit(composed, flagged);
                    }}
                  />
                )}
                {m.role === "assistant" && m.activityTrace && m.activityTrace.length > 0 && (
                  <ActivityTrace steps={m.activityTrace} />
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
                    className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 opacity-0 transition-opacity hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-slate-400"
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
              {SUGGESTED_PROMPTS.map((s) => (
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
        sources={turn.sources}
        onNavigate={onNavigate}
        onOpenSource={onOpenSource}
      />
    </div>
  );
}
