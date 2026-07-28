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
}: ReasonPromptState) {
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
