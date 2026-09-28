import { describe, expect, it } from "vitest";
import { creationReason, resolveDraftCommit, type DraftTrigger, type DraftVia } from "./draft-step";

const commit = (text: string, via: DraftVia, trigger: DraftTrigger) =>
  resolveDraftCommit({ text, via, trigger, defaultName: "New task" });

describe("resolveDraftCommit", () => {
  it("creates the step with the typed, trimmed name on Enter, Tab or clicking away", () => {
    for (const trigger of ["enter", "tab", "blur"] as const) {
      expect(commit("  Receive invoice ", "dblclick", trigger)).toEqual({
        kind: "create",
        name: "Receive invoice",
      });
    }
  });

  it("discards on Esc, even with text typed", () => {
    for (const via of ["dblclick", "tab", "palette-click", "palette-drop"] as const) {
      expect(commit("Receive invoice", via, "escape")).toEqual({ kind: "discard" });
    }
  });

  it("discards an empty or whitespace name, so a stray double-click leaves nothing", () => {
    expect(commit("", "dblclick", "blur")).toEqual({ kind: "discard" });
    expect(commit("   ", "tab", "enter")).toEqual({ kind: "discard" });
    expect(commit("", "palette-click", "enter")).toEqual({ kind: "discard" });
  });

  it("keeps a dropped shape with its default name when no name is typed", () => {
    expect(commit("", "palette-drop", "blur")).toEqual({ kind: "create", name: "New task" });
  });
});

describe("creationReason", () => {
  it("says how the step was made", () => {
    expect(creationReason("dblclick")).toBe("Added via double-click");
    expect(creationReason("tab")).toBe("Added as next step (Tab)");
    expect(creationReason("plus")).toBe("Added with the + on a step");
    expect(creationReason("palette-click")).toBe("Added from the shape palette");
    expect(creationReason("palette-drop")).toBe("Added from the shape palette");
  });
});
