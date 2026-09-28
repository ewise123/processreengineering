import { describe, expect, it } from "vitest";
import { formatKeys } from "./shortcuts-panel";

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
