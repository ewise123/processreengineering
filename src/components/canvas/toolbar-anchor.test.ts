import { describe, expect, it } from "vitest";
import { anchorToolbar } from "./toolbar-anchor";

const limits = { width: 1200, height: 800, occludedRight: 300, top: 56 };
const bar = { w: 320, h: 40 };

describe("anchorToolbar", () => {
  it("centres above the selection when there's room", () => {
    expect(anchorToolbar({ x: 300, y: 300, w: 200, h: 64 }, bar, limits)).toEqual({
      left: 240,
      top: 248,
      placement: "above",
    });
  });

  it("flips below a selection near the top", () => {
    const r = anchorToolbar({ x: 300, y: 80, w: 200, h: 64 }, bar, limits);
    expect(r.placement).toBe("below");
    expect(r.top).toBe(80 + 64 + 12);
  });

  it("stays clear of the right-hand panel and the left edge", () => {
    expect(anchorToolbar({ x: 850, y: 300, w: 100, h: 64 }, bar, limits).left).toBe(1200 - 300 - 8 - 320);
    expect(anchorToolbar({ x: -200, y: 300, w: 100, h: 64 }, bar, limits).left).toBe(8);
  });

  it("pins to the top when the selection fills the screen", () => {
    const r = anchorToolbar({ x: 100, y: 20, w: 400, h: 900 }, bar, limits);
    expect(r).toMatchObject({ top: 64, placement: "above" });
  });
});
