"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

import { reasonChips } from "./auto-reason";
import { REASON_PROMPT_DESCRIPTION } from "./delete-reason";
import type { ReasonPromptState } from "./use-reason-prompt";

/**
 * Modal that captures the `reason` for a semantic edit. Driven entirely by
 * `useReasonPrompt()` — render one instance and spread the hook's state into
 * it, including the field's own text. Closing via the X / overlay / Escape
 * counts as a cancel.
 *
 * The view holds no state of its own: the hook clears the field when it opens a
 * prompt, so a prompt superseded mid-typing cannot leave its text behind for
 * the next one.
 */
export function ReasonPromptDialog({
  open,
  actionLabel,
  destructive,
  description,
  value,
  setValue,
  submit,
  cancel,
  keep,
  setKeep,
  recentReasons,
}: ReasonPromptState) {
  // One click logs one of these. This session's reasons come first, so the
  // same reason for a run of changes is a single click each time.
  const chips = reasonChips(recentReasons);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
    >
      <DialogContent
        // Keep canvas-level keyboard shortcuts (Delete, Cmd+Z) from firing
        // while the user types their reason.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription>
            {description ?? REASON_PROMPT_DESCRIPTION}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick reasons">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              data-reason-chip
              onClick={() => submit(chip)}
              title={chip}
              className="max-w-full truncate rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 hover:border-slate-300 hover:bg-slate-100"
            >
              {chip}
            </button>
          ))}
        </div>
        <Textarea
          autoFocus
          value={value}
          placeholder={
            destructive
              ? "e.g. Duplicate of the intake step"
              : "e.g. Corrected per the SOP review"
          }
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter submits; plain Enter keeps a newline.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit(value);
            }
          }}
        />
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={keep}
            onChange={(e) => setKeep(e.target.checked)}
            className="size-4 accent-slate-900"
            data-keep-reason
          />
          Use this reason for my next changes
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => submit(value)}
            disabled={value.trim() === ""}
          >
            {destructive ? "Delete" : "Save change"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
