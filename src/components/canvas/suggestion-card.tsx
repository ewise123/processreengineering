"use client";

import { Check, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ChatSuggestion, ObjectRef, UUID } from "@/lib/types";
import type { Bundle } from "./suggestion-apply";

export type CardStatus = "pending" | "applying" | "applied" | "failed" | "dismissed";

export function SuggestionList({
  bundles,
  statusById,
  canUndoById,
  onApply,
  onUndo,
  onDismiss,
  onNavigate,
  nodeLabel,
}: {
  bundles: Bundle[];
  statusById: Record<string, CardStatus>;
  canUndoById: Record<string, boolean>;
  onApply: (bundle: Bundle) => void | Promise<void>;
  onUndo: (bundleId: string) => void;
  onDismiss: (bundleId: string) => void;
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  nodeLabel?: (id: UUID) => string | undefined;
}) {
  const visible = bundles.filter((b) => statusById[b.id] !== "dismissed");
  if (visible.length === 0) return null;
  const pending = visible.filter((b) => (statusById[b.id] ?? "pending") === "pending");
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-violet-700">
          Suggested changes · {visible.length}
        </span>
        {pending.length > 1 && (
          <button
            type="button"
            onClick={async () => {
              // Sequential, not concurrent: each apply runs canvas mutations +
              // API calls that must not interleave with the next bundle's.
              for (const b of pending) await onApply(b);
            }}
            className="rounded-full border border-violet-200 px-2 py-0.5 text-[10px] font-semibold text-violet-700 hover:bg-violet-50"
          >
            Apply all
          </button>
        )}
      </div>
      {visible.map((b) => (
        <SuggestionCard
          key={b.id}
          bundle={b}
          status={statusById[b.id] ?? "pending"}
          canUndo={!!canUndoById[b.id]}
          onApply={() => onApply(b)}
          onUndo={() => onUndo(b.id)}
          onDismiss={() => onDismiss(b.id)}
          onNavigate={onNavigate}
          nodeLabel={nodeLabel}
        />
      ))}
    </div>
  );
}

function SuggestionCard({
  bundle,
  status,
  canUndo,
  onApply,
  onUndo,
  onDismiss,
  onNavigate,
  nodeLabel,
}: {
  bundle: Bundle;
  status: CardStatus;
  canUndo: boolean;
  onApply: () => void | Promise<void>;
  onUndo: () => void;
  onDismiss: () => void;
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  nodeLabel?: (id: UUID) => string | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const isDelete = !bundle.undoable;
  const head = bundle.suggestions[0];
  const extra = bundle.suggestions.length - 1;

  // Synchronous double-click guard: `applyBundle` is async and only commits
  // "applying" after a render, so a second click before that commit would
  // re-fire the apply (clobbering the undo handle). This ref flips
  // synchronously on the first click and clears once the apply settles.
  const applyingRef = useRef(false);
  const runApply = () => {
    if (applyingRef.current || status === "applying") return;
    applyingRef.current = true;
    Promise.resolve(onApply()).finally(() => {
      applyingRef.current = false;
    });
  };

  useEffect(() => {
    if (status !== "pending") setConfirming(false);
  }, [status]);

  return (
    <div
      className={
        "rounded-md border p-2 " +
        (status === "applied"
          ? "border-emerald-200 bg-emerald-50/50"
          : status === "failed"
          ? "border-rose-200 bg-rose-50/50"
          : "border-slate-200 bg-slate-50/60")
      }
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold text-slate-800">
          {head.title}
          {extra > 0 && <span className="ml-1 text-[10px] font-normal text-slate-500">+{extra} more</span>}
        </p>
        {isDelete && status === "pending" && (
          <span className="shrink-0 rounded bg-rose-100 px-1 py-px text-[9px] font-bold text-rose-700">removes</span>
        )}
      </div>

      {bundle.suggestions.map((s) =>
        s.rationale ? (
          <p key={s.id} className="mt-0.5 text-[10px] text-slate-500">{s.rationale}</p>
        ) : null
      )}

      <AffectedRefs suggestions={bundle.suggestions} onNavigate={onNavigate} nodeLabel={nodeLabel} />

      {status === "applied" ? (
        <div className="mt-2 flex items-center gap-2 text-[10px] font-semibold text-emerald-700">
          <Check size={12} /> Applied
          {canUndo && (
            <button type="button" onClick={onUndo} className="flex items-center gap-1 text-slate-500 hover:text-slate-800">
              <RotateCcw size={11} /> Undo
            </button>
          )}
        </div>
      ) : status === "applying" ? (
        <div className="mt-2 text-[10px] text-slate-500">Applying…</div>
      ) : confirming ? (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="text-[10px] text-rose-700">Can&apos;t be undone.</span>
          <button
            type="button"
            onClick={runApply}
            className="rounded bg-rose-600 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50"
          >
            Apply anyway
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-600">
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            onClick={() => (isDelete ? setConfirming(true) : runApply())}
            className="rounded bg-slate-800 px-2 py-1 text-[10px] font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Apply
          </button>
          <button type="button" onClick={onDismiss} className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-600 hover:bg-slate-100">
            Dismiss
          </button>
          {status === "failed" && <span className="self-center text-[10px] text-rose-600">Failed — try again</span>}
        </div>
      )}
    </div>
  );
}

function AffectedRefs({
  suggestions,
  onNavigate,
  nodeLabel,
}: {
  suggestions: ChatSuggestion[];
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  nodeLabel?: (id: UUID) => string | undefined;
}) {
  const refs: ObjectRef[] = suggestions.flatMap((s) => s.affected_refs).filter((r) => r.kind !== "lane");
  if (refs.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {refs.map((r) => (
        <button
          key={`${r.kind}:${r.id}`}
          type="button"
          onClick={() => onNavigate({ kind: r.kind as "node" | "edge", id: r.id })}
          className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[9px] text-slate-600 hover:bg-slate-100"
          title="Jump to this object"
        >
          {r.kind === "node" ? (nodeLabel?.(r.id) ?? "node") : "edge"}
        </button>
      ))}
    </div>
  );
}
