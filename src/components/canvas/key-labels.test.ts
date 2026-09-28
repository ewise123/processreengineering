import { describe, expect, it } from "vitest";
import { formatKeys, isMacPlatform, keysFor } from "./key-labels";

describe("formatKeys", () => {
  it("spells modifiers out on Windows and Linux", () => {
    expect(formatKeys("Mod+Shift+Z", false)).toBe("Ctrl+Shift+Z");
    expect(formatKeys("Shift+1", false)).toBe("Shift+1");
  });

  it("uses Mac symbols with no plus signs", () => {
    expect(formatKeys("Mod+Shift+Z", true)).toBe("⌘⇧Z");
    expect(formatKeys("Mod+=", true)).toBe("⌘=");
    expect(formatKeys("Shift+2", true)).toBe("⇧2");
  });

  it("leaves plain keys and phrases alone", () => {
    expect(formatKeys("Delete", true)).toBe("Delete");
    expect(formatKeys("?", false)).toBe("?");
    expect(formatKeys("Space+drag or middle-drag", false)).toBe("Space+drag or middle-drag");
    expect(formatKeys("Space+drag or middle-drag", true)).toBe("Space+drag or middle-drag");
    expect(formatKeys("Mod+drag a step", true)).toBe("⌘drag a step");
  });
});

describe("isMacPlatform", () => {
  it("recognises Mac and iPad/iPhone browsers, and nothing else", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPad")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });
});

describe("keysFor", () => {
  it("reads an action's keys from the shortcut table, per platform", () => {
    expect(keysFor("undo", false)).toBe("Ctrl+Z");
    expect(keysFor("undo", true)).toBe("⌘Z");
    expect(keysFor("redo", true)).toBe("⌘⇧Z");
    expect(keysFor("fit", false)).toBe("Shift+1");
    expect(keysFor("delete", true)).toBe("Delete");
    expect(keysFor("zoom-in", true)).toBe("⌘+");
    expect(keysFor("zoom-in", false)).toBe("Ctrl++");
    expect(keysFor("zoom-out", true)).toBe("⌘−");
  });
});
