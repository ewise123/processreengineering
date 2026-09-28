"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { browserWorkingNoteStore, resolveReasonPrompt } from "./working-note";

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
 * Deletes use the same prompt with `{ destructive: true }`: because cancelling
 * aborts the pending delete, the prompt doubles as the confirm step.
 *
 * The hook returns plain state + handlers rather than JSX so the consuming
 * component can render `<ReasonPromptDialog {...reasonPrompt} />` once and keep
 * all the canvas markup in one place.
 */
export interface ReasonPromptOptions {
  /** Render as a destructive action: red confirm button labelled "Delete". */
  destructive?: boolean;
  /** Replace the modal's body copy (deletes explain what else they remove). */
  description?: string;
}

export interface ReasonPromptState {
  /** True while the dialog is open and awaiting input. */
  open: boolean;
  /** Human label for the action being explained, e.g. "Rename step". */
  actionLabel: string;
  /** True when the pending action destroys something (see ReasonPromptOptions). */
  destructive: boolean;
  /** Body copy override, or null for the dialog's default. */
  description: string | null;
  /** Text currently in the reason field. Owned here rather than by the dialog
   * so opening a prompt always clears it — see `promptReason`. */
  value: string;
  /** Update the reason field as the user types. */
  setValue: (next: string) => void;
  /** Submit the entered reason (empty/whitespace is treated as cancel). */
  submit: (reason: string) => void;
  /** Dismiss without a reason; aborts the pending edit. */
  cancel: () => void;
  /** The working note: one sentence covering this sitting. Blank = ask every
   * time. See `./working-note`. */
  note: string;
  /** Update the working note. */
  setNote: (next: string) => void;
  /** Open the prompt and await the result. */
  promptReason: (
    actionLabel: string,
    options?: ReasonPromptOptions
  ) => Promise<string | null>;
}

export function useReasonPrompt(versionId?: string): ReasonPromptState {
  const [open, setOpen] = useState(false);
  const [actionLabel, setActionLabel] = useState("");
  const [destructive, setDestructive] = useState(false);
  const [description, setDescription] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [note, setNoteState] = useState(() => (versionId ? browserWorkingNoteStore().load(versionId) : ""));
  // Holds the resolver for the in-flight promptReason() promise so submit /
  // cancel can settle it. Only one prompt is ever open at a time.
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const store = useMemo(() => browserWorkingNoteStore(), []);

  // The store, not React state, is the source of truth for the note:
  // `promptReason` reads it at the moment an edit fires, so it always sees the
  // current value while keeping a stable identity — it is a dependency of a
  // dozen memoised canvas callbacks, and rebuilding those on every keystroke in
  // the note field would be a needless re-render storm. The state below exists
  // only so the toolbar can display the note.
  const setNote = useCallback(
    (next: string) => {
      setNoteState(next);
      if (versionId) store.save(versionId, next);
    },
    [store, versionId]
  );

  // Re-read when the map version changes, so one version's note never stamps
  // another's edits. React's documented "adjust state when a prop changes"
  // pattern; the canvas is client-only, so there is no server render to differ
  // from. See https://react.dev/reference/react/useState
  const [noteLoadedFor, setNoteLoadedFor] = useState(versionId);
  if (versionId !== noteLoadedFor) {
    setNoteLoadedFor(versionId);
    setNoteState(versionId ? store.load(versionId) : "");
  }

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

  const promptReason = useCallback(
    (label: string, options?: ReasonPromptOptions) => {
      const resolution = resolveReasonPrompt({
        note: versionId ? store.load(versionId) : "",
        destructive: options?.destructive ?? false,
      });
      // A working note answers for every ordinary edit, so the dialog never
      // opens. Resolving without touching the open-prompt state matters: a
      // delete dialog may be open, and it owns a different pending action.
      if (resolution.mode === "auto") {
        return Promise.resolve<string | null>(resolution.reason);
      }
      // If a prompt is somehow already open, cancel it before opening the next.
      if (resolverRef.current) {
        const prev = resolverRef.current;
        resolverRef.current = null;
        prev(null);
      }
      setActionLabel(label);
      setDestructive(options?.destructive ?? false);
      setDescription(options?.description ?? null);
      // Every prompt opens from its own seed — the working note, or empty.
      // Assigning here rather than clearing on close covers the supersede path
      // above too: text typed for an abandoned prompt must never be sitting in
      // the box for the next one, which may be a destructive prompt whose
      // Delete button would submit a reason meant for some other action.
      setValue(resolution.seed);
      setOpen(true);
      return new Promise<string | null>((resolve) => {
        resolverRef.current = resolve;
      });
    },
    [store, versionId]
  );

  return {
    open,
    actionLabel,
    destructive,
    description,
    value,
    setValue,
    submit,
    cancel,
    note,
    setNote,
    promptReason,
  };
}
