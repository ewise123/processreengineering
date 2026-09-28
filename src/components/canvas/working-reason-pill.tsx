"use client";

/**
 * Shown while a kept reason is in force: every change is logged with it and
 * the reason box stays closed. Stop brings the box back.
 */
export function WorkingReasonPill({ reason, onStop }: { reason: string; onStop: () => void }) {
  return (
    <div
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
      className="flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 py-1 pl-3 pr-1 text-xs text-amber-900 shadow-sm"
    >
      <span className="shrink-0 font-semibold">Reason for changes:</span>
      <span className="min-w-0 truncate" title={reason}>
        “{reason}”
      </span>
      <button
        type="button"
        onClick={onStop}
        className="shrink-0 rounded-full bg-white px-2.5 py-0.5 font-medium text-amber-900 ring-1 ring-amber-300 hover:bg-amber-100"
      >
        Stop
      </button>
    </div>
  );
}
