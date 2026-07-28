"use client";

import { useState } from "react";

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

import type { ReasonPromptState } from "./use-reason-prompt";

/**
 * Modal that captures the `reason` for a semantic edit. Driven entirely by
 * `useReasonPrompt()` — render one instance and spread the hook's state into
 * it. Closing via the X / overlay / Escape counts as a cancel.
 */
export function ReasonPromptDialog({
  open,
  actionLabel,
  destructive,
  description,
  submit,
  cancel,
}: ReasonPromptState) {
  const [value, setValue] = useState("");

  // Clear the field as the dialog closes so the next prompt opens empty. This
  // keeps the reset out of an effect (no cascading render) — the field is only
  // ever shown while `open`, and every close path routes through here.
  const submitAndReset = (reason: string) => {
    setValue("");
    submit(reason);
  };
  const cancelAndReset = () => {
    setValue("");
    cancel();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancelAndReset();
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
            {description ??
              "Add a short reason for this change. It is saved to the change log so the edit history stays explainable."}
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
              submitAndReset(value);
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={cancelAndReset}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => submitAndReset(value)}
            disabled={value.trim() === ""}
          >
            {destructive ? "Delete" : "Save change"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
