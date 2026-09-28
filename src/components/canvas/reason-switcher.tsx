"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The reason switcher. Shown while a kept reason is in force: every change is logged with it and
 * the reason box stays closed. The menu switches to another of this
 * session's reasons (or a new one) between changes; Stop brings the box
 * back.
 */
export function ReasonSwitcher({
  working,
  recent,
  onSwitch,
  onStop,
}: {
  working: string;
  /** This session's reasons, newest first. */
  recent: string[];
  onSwitch: (reason: string) => void;
  onStop: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  function close() {
    setOpen(false);
    setAdding(false);
    setDraft("");
  }
  function pick(reason: string) {
    onSwitch(reason);
    close();
  }

  // Close on a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
        setDraft("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const options = recent.includes(working) ? recent : [working, ...recent];

  return (
    <div
      ref={rootRef}
      role="status"
      data-working-reason
      style={{
        position: "absolute",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 30,
        maxWidth: "min(460px, calc(100% - 32px))",
      }}
      // Typing a new reason must not reach the canvas's shortcuts.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 py-1 pl-3 pr-1 text-xs text-amber-900 shadow-sm">
        <span className="shrink-0 font-semibold">Reason for changes:</span>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
          title="Switch to another reason"
          className="flex min-w-0 items-center gap-1 rounded-full px-1.5 py-0.5 hover:bg-amber-100"
        >
          <span className="min-w-0 truncate">“{working}”</span>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="shrink-0">
            <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onStop}
          className="shrink-0 rounded-full bg-white px-2.5 py-0.5 font-medium text-amber-900 ring-1 ring-amber-300 hover:bg-amber-100"
        >
          Stop
        </button>
      </div>
      {open && (
        <div
          role="menu"
          className="absolute left-1/2 top-full mt-1.5 w-72 -translate-x-1/2 rounded-lg border border-slate-200 bg-white p-1 text-xs text-slate-700 shadow-lg"
        >
          <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Reasons this session
          </div>
          {options.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={r === working}
              data-reason-option={r}
              onClick={() => pick(r)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-100"
            >
              <span className="w-3 shrink-0 text-slate-900">{r === working ? "✓" : ""}</span>
              <span className="min-w-0 truncate" title={r}>
                {r}
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-slate-100" />
          {adding ? (
            <form
              className="flex items-center gap-1 px-1 py-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) pick(draft);
              }}
            >
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") close();
                }}
                placeholder="e.g. Per Jane's interview"
                aria-label="New reason"
                data-new-reason
                className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs outline-none focus:border-slate-500"
              />
              <button
                type="submit"
                disabled={!draft.trim()}
                className="rounded bg-slate-900 px-2 py-1 font-medium text-white disabled:opacity-40"
              >
                Use
              </button>
            </form>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setAdding(true)}
              className="w-full rounded px-2 py-1.5 text-left hover:bg-slate-100"
            >
              <span className="inline-block w-3" />+ New reason…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
