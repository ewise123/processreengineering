import { describe, expect, it } from "vitest";

import { toggleSelection, selectAll, clearSelection, isSelected } from "./triage-selection";

describe("triage selection state", () => {
  it("toggles a single id on and off", () => {
    let sel = new Set<string>();
    sel = toggleSelection(sel, "a");
    expect(isSelected(sel, "a")).toBe(true);
    sel = toggleSelection(sel, "a");
    expect(isSelected(sel, "a")).toBe(false);
  });

  it("does not mutate the input set", () => {
    const sel = new Set<string>(["a"]);
    const next = toggleSelection(sel, "b");
    expect(sel.has("b")).toBe(false);
    expect(next.has("b")).toBe(true);
  });

  it("selectAll adds every id; clearSelection empties", () => {
    const all = selectAll(["a", "b", "c"]);
    expect(all.size).toBe(3);
    expect(clearSelection().size).toBe(0);
  });
});
