import { describe, expect, it } from "vitest";
import { laneAccent } from "./canvas-theme";
import { LANE_PALETTE } from "./layout";

describe("laneAccent", () => {
  it("turns the pastel blue lane into a mid-tone blue", () => {
    expect(laneAccent("#dbeafe")).toMatch(/^hsl\(21\d, \d+%, 50%\)$/);
  });

  it("gives every palette colour a saturated, mid-lightness accent", () => {
    for (const c of LANE_PALETTE) {
      const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(laneAccent(c));
      expect(m, c).not.toBeNull();
      expect(Number(m![2])).toBeGreaterThanOrEqual(65);
      expect(Number(m![3])).toBe(50);
    }
  });

  it("keeps a grey lane grey", () => {
    expect(laneAccent("#f1f5f9")).toBe("hsl(215, 16%, 47%)");
  });

  it("accepts 3-digit hex and falls back to slate on junk", () => {
    expect(laneAccent("#fcd")).toMatch(/^hsl\(/);
    expect(laneAccent("not a colour")).toBe("#64748b");
  });
});
