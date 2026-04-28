"use client";

import { useCallback, useState } from "react";

export interface UndoAction {
  /** Re-apply the change (used by redo). */
  do: () => void | Promise<void>;
  /** Revert the change (used by undo). */
  undo: () => void | Promise<void>;
  /** Optional human label for debugging / future toast surfacing. */
  description?: string;
}

const MAX_HISTORY = 50;

/**
 * Two-stack undo/redo runtime. Each user mutation calls `record(action)`,
 * passing functions that re-apply or revert the change. `undo()` and
 * `redo()` move actions between the stacks and invoke the right callback.
 *
 * The action callbacks must NOT call `record()` themselves — otherwise an
 * undo would clear the redo stack. They should call the low-level state
 * mutators directly.
 */
export function useUndoStack() {
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoAction[]>([]);

  const record = useCallback((action: UndoAction) => {
    setUndoStack((s) => {
      const next = [...s, action];
      if (next.length > MAX_HISTORY) next.shift();
      return next;
    });
    setRedoStack([]);
  }, []);

  const undo = useCallback(async () => {
    let action: UndoAction | undefined;
    setUndoStack((s) => {
      if (s.length === 0) return s;
      action = s[s.length - 1];
      return s.slice(0, -1);
    });
    if (!action) return;
    await action.undo();
    setRedoStack((r) => [...r, action!]);
  }, []);

  const redo = useCallback(async () => {
    let action: UndoAction | undefined;
    setRedoStack((r) => {
      if (r.length === 0) return r;
      action = r[r.length - 1];
      return r.slice(0, -1);
    });
    if (!action) return;
    await action.do();
    setUndoStack((s) => [...s, action!]);
  }, []);

  const clear = useCallback(() => {
    setUndoStack([]);
    setRedoStack([]);
  }, []);

  return {
    record,
    undo,
    redo,
    clear,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  };
}
