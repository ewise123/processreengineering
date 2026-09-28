import { describe, expect, it } from "vitest";
import { resolveShortcut, SHORTCUTS, type KeyInput } from "./keymap";

const press = (key: string, over: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code: over.code ?? "",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("resolveShortcut — shortcuts the canvas already had", () => {
  it.each([
    [press("z", { ctrlKey: true }), "undo"],
    [press("z", { metaKey: true }), "undo"],
    [press("Z", { metaKey: true, shiftKey: true }), "redo"],
    [press("y", { ctrlKey: true }), "redo"],
    [press("c", { ctrlKey: true }), "copy"],
    [press("v", { metaKey: true }), "paste"],
    [press("v"), "tool-select"],
    [press("H"), "tool-pan"],
    [press("c"), "tool-connect"],
    [press("Escape"), "escape"],
    [press("Delete"), "delete"],
    [press("Backspace"), "delete"],
  ] as const)("%j → %s", (ev, action) => {
    expect(resolveShortcut(ev)).toBe(action);
  });
});

describe("resolveShortcut — new navigation keys", () => {
  it("zooms in on Mod+= and Mod++ and the numpad plus", () => {
    expect(resolveShortcut(press("=", { ctrlKey: true }))).toBe("zoom-in");
    expect(resolveShortcut(press("+", { metaKey: true, shiftKey: true }))).toBe("zoom-in");
    expect(resolveShortcut(press("+", { ctrlKey: true, code: "NumpadAdd" }))).toBe("zoom-in");
  });

  it("zooms out on Mod+- and resets on Mod+0", () => {
    expect(resolveShortcut(press("-", { ctrlKey: true }))).toBe("zoom-out");
    expect(resolveShortcut(press("0", { metaKey: true, code: "Digit0" }))).toBe("zoom-reset");
  });

  it("fits on Shift+1 and zooms to selection on Shift+2, by key position", () => {
    expect(resolveShortcut(press("!", { shiftKey: true, code: "Digit1" }))).toBe("fit");
    expect(resolveShortcut(press("@", { shiftKey: true, code: "Digit2" }))).toBe("zoom-selection");
    // A layout that types something else on Shift+1 still fits.
    expect(resolveShortcut(press("+", { shiftKey: true, code: "Digit1" }))).toBe("fit");
  });

  it("selects all on Mod+A", () => {
    expect(resolveShortcut(press("a", { metaKey: true }))).toBe("select-all");
  });
});

describe("resolveShortcut — fast creation keys", () => {
  it("Tab adds the next step; Shift+Tab is left for the browser", () => {
    expect(resolveShortcut(press("Tab"))).toBe("next-step");
    expect(resolveShortcut(press("Tab", { shiftKey: true }))).toBeNull();
    expect(resolveShortcut(press("Tab", { ctrlKey: true }))).toBeNull();
  });

  it("Enter and F2 rename", () => {
    expect(resolveShortcut(press("Enter"))).toBe("rename");
    expect(resolveShortcut(press("F2"))).toBe("rename");
    expect(resolveShortcut(press("Enter", { shiftKey: true }))).toBeNull();
  });
});

describe("resolveShortcut — leaves other keys alone", () => {
  it("ignores Alt/Option combinations (text input on a Mac)", () => {
    expect(resolveShortcut(press("z", { metaKey: true, altKey: true }))).toBeNull();
    expect(resolveShortcut(press("c", { altKey: true }))).toBeNull();
  });

  it("ignores unmapped keys, including plain digits and letters", () => {
    expect(resolveShortcut(press("1", { code: "Digit1" }))).toBeNull();
    expect(resolveShortcut(press("x"))).toBeNull();
    expect(resolveShortcut(press("s", { ctrlKey: true }))).toBeNull();
  });
});

describe("SHORTCUTS table", () => {
  it("lists every action exactly once", () => {
    const actions = SHORTCUTS.map((s) => s.action);
    expect(new Set(actions).size).toBe(actions.length);
  });
});
