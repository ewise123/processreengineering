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
 * The two stacks behind undo/redo, as plain data. Kept outside React state
 * so `undo()` always sees the entry `record()` just pushed: reading it back
 * through a state updater only works when React happens to run the updater
 * immediately, and it doesn't when the entry was recorded from a timer (an
 * arrow-key nudge burst) — undo then silently did nothing.
 */
export function createUndoHistory(max = MAX_HISTORY) {
  let undoStack: UndoAction[] = [];
  let redoStack: UndoAction[] = [];
  return {
    record(action: UndoAction) {
      undoStack = [...undoStack, action].slice(-max);
      redoStack = [];
    },
    /** Take the entry to undo, moving it to the redo stack. */
    takeUndo(): UndoAction | undefined {
      const action = undoStack[undoStack.length - 1];
      if (!action) return undefined;
      undoStack = undoStack.slice(0, -1);
      redoStack = [...redoStack, action];
      return action;
    },
    /** Take the entry to redo, moving it back to the undo stack. */
    takeRedo(): UndoAction | undefined {
      const action = redoStack[redoStack.length - 1];
      if (!action) return undefined;
      redoStack = redoStack.slice(0, -1);
      undoStack = [...undoStack, action];
      return action;
    },
    clear() {
      undoStack = [];
      redoStack = [];
    },
    /** True while `action` is the next thing undo would revert. */
    isLatest(action: UndoAction) {
      return undoStack[undoStack.length - 1] === action;
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
  };
}

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
  // One history per canvas, created once and mutated in place.
  const [history] = useState(() => createUndoHistory());
  // Mirrors of the stack sizes, so the Undo/Redo buttons re-render.
  const [flags, setFlags] = useState({ canUndo: false, canRedo: false });
  const sync = useCallback(
    () => setFlags({ canUndo: history.canUndo, canRedo: history.canRedo }),
    [history]
  );

  const record = useCallback(
    (action: UndoAction) => {
      history.record(action);
      sync();
    },
    [history, sync]
  );

  const undo = useCallback(async () => {
    const action = history.takeUndo();
    if (!action) return;
    sync();
    await action.undo();
  }, [history, sync]);

  const redo = useCallback(async () => {
    const action = history.takeRedo();
    if (!action) return;
    sync();
    await action.do();
  }, [history, sync]);

  const clear = useCallback(() => {
    history.clear();
    sync();
  }, [history, sync]);

  const isLatest = useCallback((action: UndoAction) => history.isLatest(action), [history]);

  return {
    record,
    undo,
    redo,
    clear,
    isLatest,
    canUndo: flags.canUndo,
    canRedo: flags.canRedo,
  };
}
