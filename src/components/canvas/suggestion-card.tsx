"use client";

import { Check, ChevronRight, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { OpKind, ProcessLane } from "@/lib/types";
import { isDeleteOp, type Bundle } from "./suggestion-apply";
import {
  isProposalGrounded,
  laneReassignmentTarget,
  opPayload,
  opTarget,
  renameTransition,
  suggestedChangesSuffix,
} from "./suggestion-display";

export type CardStatus = "pending" | "applying" | "applied" | "failed" | "dismissed";

/** Human-readable verb for each op kind, shown as the per-change badge. */
const ACTION_LABEL: Record<OpKind, string> = {
  relabel_node: "Rename",
  describe_node: "Describe",
  add_node: "Add step",
  remove_node: "Remove step",
  add_edge: "Connect",
  remove_edge: "Remove link",
  relabel_edge: "Label link",
  reroute_edge: "Reroute",
  move_to_lane: "Move to lane",
  add_lane: "Add lane",
  rename_lane: "Rename lane",
  decompose: "Break down",
  change_node_type: "Change type",
  remove_lane: "Remove lane",
  set_edge_condition: "Set condition",
};

export function SuggestionList({
  bundles,
  statusById,
  canUndoById,
  onApply,
  onUndo,
  onDismiss,
  onRestore,
  renderText,
  summaryById,
  errorById,
  lanes,
}: {
  bundles: Bundle[];
  statusById: Record<string, CardStatus>;
  canUndoById: Record<string, boolean>;
  onApply: (bundle: Bundle) => void | Promise<void>;
  onUndo: (bundleId: string) => void;
  onDismiss: (bundleId: string) => void;
  onRestore: (bundleId: string) => void;
  /** Render text with `[[kind:uuid]]` mentions as named, clickable links. */
  renderText: (text: string) => ReactNode;
  /** group id → one-line purpose of that bundle. */
  summaryById: Map<string, string>;
  /** bundle id → the apply-failure message to show on a failed card. */
  errorById: Record<string, string>;
  /** The map's lanes, so a remove_lane card can name the lane its steps get
   * reassigned to. */
  lanes: ProcessLane[];
}) {
  if (bundles.length === 0) return null;
  // Dismissed cards stay visible (dimmed); only still-pending ones feed "Apply all".
  const pending = bundles.filter((b) => (statusById[b.id] ?? "pending") === "pending");
  const applied = bundles.filter((b) => statusById[b.id] === "applied").length;
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-violet-700">
          Suggested changes · {suggestedChangesSuffix(bundles.length, applied)}
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
      {bundles.map((b) => (
        <SuggestionCard
          key={b.id}
          bundle={b}
          status={statusById[b.id] ?? "pending"}
          canUndo={!!canUndoById[b.id]}
          summary={bundleSummary(b, summaryById)}
          error={errorById[b.id]}
          onApply={() => onApply(b)}
          onUndo={() => onUndo(b.id)}
          onDismiss={() => onDismiss(b.id)}
          onRestore={() => onRestore(b.id)}
          renderText={renderText}
          lanes={lanes}
        />
      ))}
    </div>
  );
}

/** The purpose statement for a bundle: the summary of the first member group
 * that has one (a bundle may span groups when linked by a tmp_id dependency). */
function bundleSummary(bundle: Bundle, summaryById: Map<string, string>): string | undefined {
  for (const s of bundle.suggestions) {
    if (s.group && summaryById.has(s.group)) return summaryById.get(s.group);
  }
  return undefined;
}

function SuggestionCard({
  bundle,
  status,
  canUndo,
  summary,
  error,
  onApply,
  onUndo,
  onDismiss,
  onRestore,
  renderText,
  lanes,
}: {
  bundle: Bundle;
  status: CardStatus;
  canUndo: boolean;
  summary?: string;
  error?: string;
  onApply: () => void | Promise<void>;
  onUndo: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  renderText: (text: string) => ReactNode;
  lanes: ProcessLane[];
}) {
  const [confirming, setConfirming] = useState(false);
  const isDelete = !bundle.undoable;
  const dismissed = status === "dismissed";
  const multi = bundle.suggestions.length > 1;

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
        (dismissed
          ? "border-slate-200 bg-slate-50/40 opacity-60"
          : status === "applied"
          ? "border-emerald-200 bg-emerald-50/50"
          : status === "failed"
          ? "border-rose-200 bg-rose-50/50"
          : "border-slate-200 bg-slate-50/60")
      }
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
          {multi ? `Bundle · ${bundle.suggestions.length} changes` : "Suggested change"}
        </span>
        {isDelete && !dismissed && status === "pending" && (
          <span className="shrink-0 rounded bg-rose-100 px-1 py-px text-[9px] font-bold text-rose-700">
            not undoable
          </span>
        )}
      </div>

      {/* What the bundle does as a whole, before the individual changes. */}
      {summary && (
        <p className="mb-1.5 text-[11px] font-medium leading-snug text-slate-700">{summary}</p>
      )}

      {/* Every change in the bundle: the action badge + target object, the
          proposed new value, and collapsible reasoning. */}
      <div className="space-y-1">
        {bundle.suggestions.map((s) => {
          const target = opTarget(s.op);
          // Rename-family ops show a frozen "old → new" so the preview stays
          // meaningful after apply (a live mention would collapse to the new
          // name, reading as a rename to the same name). Other ops keep the
          // live mention target + proposed-value preview.
          const transition = renameTransition(s.op, s.before_label);
          const payload = transition ? null : opPayload(s.op);
          // remove_lane doesn't otherwise preview a value; this reassures the
          // user the removed lane's steps aren't lost, naming where they land.
          const reassignTarget = laneReassignmentTarget(s.op, lanes);
          return (
            <div key={s.id} className="rounded border border-slate-200 bg-white/70 px-1.5 py-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={
                    "shrink-0 rounded px-1 py-px text-[8.5px] font-bold uppercase tracking-wide " +
                    (isDeleteOp(s.op.kind) ? "bg-rose-100 text-rose-700" : "bg-slate-200 text-slate-600")
                  }
                >
                  {ACTION_LABEL[s.op.kind] ?? s.op.kind}
                </span>
                <span className="min-w-0 text-[11px] font-medium leading-snug text-slate-800">
                  {target ? renderText(target) : renderText(s.title)}
                </span>
                {!isProposalGrounded(s) && (
                  <span
                    className="shrink-0 rounded px-1 py-px text-[8.5px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700"
                    title="This change draws on general process knowledge, not your uploaded sources."
                  >
                    Not grounded in your sources
                  </span>
                )}
              </div>
              {transition ? (
                <div className="mt-1 flex flex-wrap items-center gap-1 rounded bg-slate-100/80 px-1.5 py-1 text-[11px] leading-snug">
                  <span className="text-slate-400 line-through">{transition.before}</span>
                  <span className="text-slate-400">→</span>
                  <span className="font-medium text-slate-700">{transition.after}</span>
                </div>
              ) : payload ? (
                <div className="mt-1 whitespace-pre-wrap rounded bg-slate-100/80 px-1.5 py-1 text-[11px] leading-snug text-slate-700">
                  {payload.hasMention ? renderText(payload.value) : payload.value}
                </div>
              ) : null}
              {reassignTarget && (
                <div className="mt-1 whitespace-pre-wrap rounded bg-slate-100/80 px-1.5 py-1 text-[11px] leading-snug text-slate-700">
                  → its steps move to {renderText(`[[lane:${reassignTarget}]]`)}
                </div>
              )}
              {s.rationale && <Reasoning rationale={s.rationale} renderText={renderText} />}
            </div>
          );
        })}
      </div>

      {dismissed ? (
        <div className="mt-2 flex items-center gap-2 text-[10px] font-semibold text-slate-500">
          Dismissed
          <button type="button" onClick={onRestore} className="font-normal text-slate-500 underline hover:text-slate-800">
            Restore
          </button>
        </div>
      ) : status === "applied" ? (
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
        <div className="mt-2 flex items-center gap-1.5">
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
          {status === "failed" && (
            <span className="self-center text-[10px] text-rose-600">{error ?? "Failed — try again"}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** A change's rationale, collapsed behind a "Reasoning" disclosure that expands
 * inside the card. Collapsed by default so the card leads with the change itself. */
function Reasoning({
  rationale,
  renderText,
}: {
  rationale: string;
  renderText: (text: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-0.5 text-[10px] font-medium text-slate-500 hover:text-slate-700"
      >
        <ChevronRight size={10} className={"transition-transform " + (open ? "rotate-90" : "")} />
        Reasoning
      </button>
      {open && (
        <div className="mt-0.5 pl-3 text-[10px] leading-snug text-slate-500">{renderText(rationale)}</div>
      )}
    </div>
  );
}
