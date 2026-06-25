"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Backing state for a single reusable "why did you make this change?" prompt.
 *
 * Semantic edits (renaming a step, changing its type/lane, editing an edge
 * label, renaming a lane) require a `reason` or the backend rejects them with
 * a 422. `promptReason(label)` opens a modal and resolves to the entered text,
 * or `null` if the user cancels — in which case the caller must abort the edit
 * and send nothing. Cosmetic edits (drag-to-reposition, bend, recolor) never
 * call this.
 *
 * The hook returns plain state + handlers rather than JSX so the consuming
 * component can render `<ReasonPromptDialog {...reasonPrompt} />` once and keep
 * all the canvas markup in one place.
 */
export interface ReasonPromptState {
  /** True while the dialog is open and awaiting input. */
  open: boolean;
  /** Human label for the action being explained, e.g. "Rename step". */
  actionLabel: string;
  /** Submit the entered reason (empty/whitespace is treated as cancel). */
  submit: (reason: string) => void;
  /** Dismiss without a reason; aborts the pending edit. */
  cancel: () => void;
  /** Open the prompt and await the result. */
  promptReason: (actionLabel: string) => Promise<string | null>;
}

export function useReasonPrompt(): ReasonPromptState {
  const [open, setOpen] = useState(false);
  const [actionLabel, setActionLabel] = useState("");
  // Holds the resolver for the in-flight promptReason() promise so submit /
  // cancel can settle it. Only one prompt is ever open at a time.
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const settle = useCallback((value: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  const submit = useCallback(
    (reason: string) => {
      const trimmed = reason.trim();
      // An empty reason can't satisfy the 422 rule, so treat it as a cancel.
      settle(trimmed === "" ? null : trimmed);
    },
    [settle]
  );

  const cancel = useCallback(() => settle(null), [settle]);

  const promptReason = useCallback((label: string) => {
    // If a prompt is somehow already open, cancel it before opening the next.
    if (resolverRef.current) {
      const prev = resolverRef.current;
      resolverRef.current = null;
      prev(null);
    }
    setActionLabel(label);
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  return { open, actionLabel, submit, cancel, promptReason };
}
