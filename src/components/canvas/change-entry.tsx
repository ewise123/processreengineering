"use client";

/**
 * Shared presentational component for a single ChangeEvent row.
 * Used by PropertiesPanel (History section) and the Change Log tab.
 */

import { Bot, Cpu, User } from "lucide-react";
import type { ChangeActorKind, ChangeEvent, UUID } from "@/lib/types";

const ACTOR_ICON: Record<ChangeActorKind, React.ReactNode> = {
  user: <User size={10} className="shrink-0 text-slate-500" />,
  ai: <Bot size={10} className="shrink-0 text-violet-500" />,
  system: <Cpu size={10} className="shrink-0 text-slate-400" />,
};

const ACTOR_LABEL: Record<ChangeActorKind, string> = {
  user: "User",
  ai: "AI",
  system: "System",
};

export function formatRelativeTime(isoString: string): string {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(isoString).toLocaleDateString();
}

/**
 * Render a single ChangeEvent row.
 *
 * `onFocus` — if provided and the event targets a node, clicking the row
 * calls `onFocus(event.target_id)` to jump the canvas to that node.
 * Only fires for `target_type === "node"` events (edges/lanes have no
 * canvas focus handler today).
 */
export function ChangeEntry({
  event,
  onFocus,
}: {
  event: ChangeEvent;
  onFocus?: (id: UUID) => void;
}) {
  const actorIcon = ACTOR_ICON[event.actor_kind];
  const actorLabel = ACTOR_LABEL[event.actor_kind] ?? event.actor_kind;
  const relTime = formatRelativeTime(event.created_at);
  const canFocus = event.target_type === "node" && onFocus != null;

  return (
    <div
      role={canFocus ? "button" : undefined}
      tabIndex={canFocus ? 0 : undefined}
      onClick={canFocus ? () => onFocus!(event.target_id) : undefined}
      onKeyDown={
        canFocus
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onFocus!(event.target_id);
              }
            }
          : undefined
      }
      className={
        "rounded-md border border-slate-100 bg-slate-50 px-2 py-1.5 text-[10.5px]" +
        (canFocus
          ? " cursor-pointer hover:border-violet-200 hover:bg-violet-50 focus:outline-none focus:ring-1 focus:ring-violet-400"
          : "")
      }
    >
      {/* Top row: actor + kind + timestamp */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex min-w-0 items-center gap-1">
          {actorIcon}
          <span className="font-semibold text-slate-600">{actorLabel}</span>
          <span className="rounded bg-slate-200 px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-slate-600">
            {event.kind.replace(/_/g, " ")}
          </span>
        </div>
        <span
          className="shrink-0 text-[9px] tabular-nums text-slate-400"
          title={new Date(event.created_at).toLocaleString()}
        >
          {relTime}
        </span>
      </div>
      {/* Reason */}
      {event.reason && (
        <div className="mt-0.5 leading-snug text-slate-500">{event.reason}</div>
      )}
      {/* Cited claim chips */}
      {event.cited_claim_ids && event.cited_claim_ids.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {event.cited_claim_ids.map((cid) => (
            <span
              key={cid}
              title={cid}
              className="rounded bg-violet-100 px-1 py-[1px] text-[9px] font-mono font-semibold text-violet-700"
            >
              {cid.slice(0, 8)}
            </span>
          ))}
        </div>
      )}
      {/* Show thinking disclosure */}
      {event.has_thinking && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[9px] font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-600">
            Show thinking
          </summary>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-1 text-[9px] leading-relaxed text-slate-500">
            {JSON.stringify(event.reasoning_trace, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
