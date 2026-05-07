"use client";

import { Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { ChatTurn, UUID } from "@/lib/types";

/** Right-anchored conversational AI panel. History lives in this component
 * for now — clears on reload. Spec'd to swap in a persisted thread later
 * (per session memory: ai_assistant_vision.md). */
export function ChatSidebar({
  projectId,
  modelId,
  versionId,
  selectedNodeId,
  selectedEdgeId,
  selectedLabel,
  onClose,
}: {
  projectId: UUID;
  modelId: UUID;
  versionId: UUID;
  selectedNodeId?: UUID | null;
  selectedEdgeId?: UUID | null;
  /** Human-readable label of the current selection, for the context chip. */
  selectedLabel?: string | null;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const ask = useMutation({
    mutationFn: (input: { history: ChatTurn[]; userMessage: string }) =>
      api.chatWithMap(projectId, modelId, versionId, {
        history: input.history,
        user_message: input.userMessage,
        selected_node_id: selectedNodeId ?? null,
        selected_edge_id: selectedEdgeId ?? null,
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
    // Auto-scroll to the latest message whenever history grows.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, ask.isPending]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const text = draft.trim();
    if (!text || ask.isPending) return;
    setDraft("");
    ask.mutate({ history, userMessage: text });
  };

  return (
    <div
      className="flex h-full w-[360px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
      style={{
        boxShadow:
          "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
      }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Sparkles size={12} className="text-slate-700" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            Assistant
          </span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close assistant"
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <X size={14} />
        </button>
      </div>

      {selectedLabel && (
        <div className="shrink-0 border-b border-slate-100 bg-slate-50 px-3 py-1.5">
          <div className="text-[9px] uppercase tracking-wider text-slate-400">
            In context
          </div>
          <div className="truncate text-[11px] font-medium text-slate-700">
            {selectedLabel}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {history.length === 0 && !ask.isPending && (
          <div className="text-[12px] leading-relaxed text-slate-500">
            Ask about a step, challenge a transition, or look for gaps —
            <br />
            <span className="italic text-slate-400">
              &ldquo;Should there be a step before this?&rdquo;
              <br />
              &ldquo;How do we get from this step to the next? Looks like a gap.&rdquo;
              <br />
              &ldquo;Does this label match the SOP?&rdquo;
            </span>
            <br />
            <br />
            All answers are grounded in the project&rsquo;s sources. The AI
            will push back if your premise contradicts them.
          </div>
        )}

        <div className="space-y-3">
          {history.map((turn, i) => (
            <ChatBubble key={i} turn={turn} />
          ))}
          {ask.isPending && (
            <div className="text-[11px] italic text-slate-400">Thinking…</div>
          )}
          {ask.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
              {(ask.error as Error).message}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-slate-100 bg-white px-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask about this map…"
            rows={2}
            className="flex-1 resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] text-slate-800 focus:border-slate-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim() || ask.isPending}
            aria-label="Send"
            className="rounded-md bg-slate-900 p-2 text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
          >
            <Send size={14} />
          </button>
        </div>
        <div className="mt-1 text-[10px] text-slate-400">
          Enter to send · Shift+Enter for newline
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ turn }: { turn: ChatTurn }) {
  const isUser = turn.role === "user";
  return (
    <div
      className={
        isUser
          ? "ml-6 rounded-md bg-slate-900 px-2.5 py-1.5 text-[12px] leading-relaxed text-white"
          : "mr-6 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] leading-relaxed text-slate-800"
      }
    >
      {turn.content.split("\n").map((line, i) => (
        <p key={i} className={i > 0 ? "mt-2" : ""}>
          {line}
        </p>
      ))}
    </div>
  );
}
