import { describe, expect, it } from "vitest";
import {
  boundsOf,
  contentBounds,
  ensureVisible,
  fitRect,
  interpretWheel,
  MAX_SCALE,
  MIN_SCALE,
  scaleAt,
  zoomAt,
  type WheelInput,
} from "./viewport-math";

const wheel = (over: Partial<WheelInput>): WheelInput => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

describe("zoomAt / scaleAt", () => {
  it("keeps the world point under the cursor fixed", () => {
    const v = { tx: 100, ty: 50, scale: 1 };
    const anchor = { x: 400, y: 300 };
    const before = { x: (anchor.x - v.tx) / v.scale, y: (anchor.y - v.ty) / v.scale };
    const z = zoomAt(v, 1.5, anchor);
    expect((anchor.x - z.tx) / z.scale).toBeCloseTo(before.x);
    expect((anchor.y - z.ty) / z.scale).toBeCloseTo(before.y);
    expect(z.scale).toBe(1.5);
  });

  it("clamps to the allowed zoom range", () => {
    expect(zoomAt({ tx: 0, ty: 0, scale: 2 }, 10, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
    expect(scaleAt({ tx: 0, ty: 0, scale: 1 }, 0.01, { x: 0, y: 0 }).scale).toBe(MIN_SCALE);
  });
});

describe("fitRect", () => {
  it("centres the rect and fits its larger dimension", () => {
    const v = fitRect({ x: 0, y: 0, w: 1000, h: 400 }, { w: 1096, h: 800 }, 48, 5);
    expect(v.scale).toBe(1); // (1096 - 96) / 1000
    expect(v.tx).toBe(1096 / 2 - 500);
    expect(v.ty).toBe(800 / 2 - 200);
  });

  it("never zooms in past maxScale on a tiny map", () => {
    expect(fitRect({ x: 0, y: 0, w: 50, h: 50 }, { w: 1000, h: 800 }).scale).toBe(1);
  });
});

describe("contentBounds", () => {
  const lanes = [
    { y: 0, h: 200 },
    { y: 200, h: 200 },
  ];

  it("runs from the lane headers to the right-most node, across every lane", () => {
    expect(contentBounds([{ x: 300, y: 50, w: 170, h: 64 }], lanes)).toEqual({
      x: 0,
      y: 0,
      w: 300 + 170 + 40,
      h: 400,
    });
  });

  it("falls back to a readable width for a map with lanes but no nodes", () => {
    expect(contentBounds([], lanes)!.w).toBe(844);
  });

  it("returns null for an empty map", () => {
    expect(contentBounds([], [])).toBeNull();
  });
});

describe("boundsOf", () => {
  it("wraps a selection", () => {
    expect(
      boundsOf([
        { x: 10, y: 20, w: 100, h: 50 },
        { x: 200, y: 0, w: 60, h: 60 },
      ])
    ).toEqual({ x: 10, y: 0, w: 250, h: 70 });
  });
});

describe("interpretWheel", () => {
  it("trackpad mode: a plain wheel pans on both axes (today's behaviour)", () => {
    expect(interpretWheel(wheel({ deltaX: 5, deltaY: 40 }), "trackpad")).toEqual({
      kind: "pan",
      dx: 5,
      dy: 40,
    });
  });

  it("ctrl or cmd + wheel zooms in either mode (pinch arrives as ctrl+wheel)", () => {
    for (const mode of ["trackpad", "mouse"] as const) {
      const a = interpretWheel(wheel({ deltaY: -100, ctrlKey: true }), mode);
      expect(a.kind).toBe("zoom");
      const b = interpretWheel(wheel({ deltaY: -100, metaKey: true }), mode);
      expect(b.kind).toBe("zoom");
    }
  });

  it("mouse mode: a plain wheel zooms — one notch up is roughly +22%", () => {
    const a = interpretWheel(wheel({ deltaY: -100 }), "mouse");
    expect(a.kind).toBe("zoom");
    if (a.kind === "zoom") expect(a.factor).toBeCloseTo(Math.exp(0.2));
  });

  it("mouse mode: shift+wheel pans sideways, whichever axis the browser reports", () => {
    expect(interpretWheel(wheel({ deltaX: 60, shiftKey: true }), "mouse")).toEqual({ kind: "pan", dx: 60, dy: 0 });
    expect(interpretWheel(wheel({ deltaY: 60, shiftKey: true }), "mouse")).toEqual({ kind: "pan", dx: 60, dy: 0 });
  });

  it("converts line- and page-based deltas to pixels", () => {
    expect(interpretWheel(wheel({ deltaY: 3, deltaMode: 1 }), "trackpad")).toEqual({ kind: "pan", dx: 0, dy: 48 });
    expect(interpretWheel(wheel({ deltaY: 1, deltaMode: 2 }), "trackpad", 700)).toEqual({ kind: "pan", dx: 0, dy: 700 });
  });
});

describe("ensureVisible", () => {
  const size = { w: 1000, h: 800 };
  it("leaves the view alone when the rect is on screen", () => {
    const v = { tx: 0, ty: 0, scale: 1 };
    expect(ensureVisible(v, { x: 100, y: 100, w: 170, h: 64 }, size)).toBe(v);
  });
  it("pans just enough to bring an off-screen step into view", () => {
    const v = { tx: 0, ty: 0, scale: 1 };
    const next = ensureVisible(v, { x: 950, y: 100, w: 170, h: 64 }, size);
    expect(next.tx).toBe(1000 - 48 - 1120);
    expect(next.ty).toBe(0);
  });
});
