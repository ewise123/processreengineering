import { describe, expect, it } from "vitest";
import { createUndoHistory, type UndoAction } from "./use-undo-stack";

const act = (label: string, log: string[]): UndoAction => ({
  description: label,
  do: () => void log.push(`do ${label}`),
  undo: () => void log.push(`undo ${label}`),
});

describe("createUndoHistory", () => {
  it("undoes the entry recorded just before, with no render in between", () => {
    const h = createUndoHistory();
    const log: string[] = [];
    h.record(act("a", log));
    h.record(act("b", log));
    void h.takeUndo()!.undo();
    expect(log).toEqual(["undo b"]);
  });

  it("moves entries between the stacks and clears redo on a new record", () => {
    const h = createUndoHistory();
    const log: string[] = [];
    h.record(act("a", log));
    expect(h.takeUndo()?.description).toBe("a");
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(true);
    expect(h.takeRedo()?.description).toBe("a");
    h.takeUndo();
    h.record(act("b", log));
    expect(h.canRedo).toBe(false);
    expect(h.takeRedo()).toBeUndefined();
  });

  it("returns nothing on an empty stack", () => {
    const h = createUndoHistory();
    expect(h.takeUndo()).toBeUndefined();
    expect(h.takeRedo()).toBeUndefined();
  });

  it("keeps only the most recent entries", () => {
    const h = createUndoHistory(2);
    const log: string[] = [];
    h.record(act("a", log));
    h.record(act("b", log));
    h.record(act("c", log));
    expect(h.takeUndo()?.description).toBe("c");
    expect(h.takeUndo()?.description).toBe("b");
    expect(h.takeUndo()).toBeUndefined();
  });

  it("knows whether an entry is still the latest", () => {
    const h = createUndoHistory();
    const log: string[] = [];
    const a = act("a", log);
    h.record(a);
    expect(h.isLatest(a)).toBe(true);
    h.record(act("b", log));
    expect(h.isLatest(a)).toBe(false);
    h.takeUndo();
    expect(h.isLatest(a)).toBe(true);
  });
});
