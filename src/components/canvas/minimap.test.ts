import { describe, expect, it } from "vitest";
import { centreOn, fromMinimap, minimapLayout, toMinimap, union, viewRect } from "./minimap";

describe("viewRect", () => {
  it("is the world area on screen", () => {
    expect(viewRect({ tx: -200, ty: 100, scale: 2 }, { w: 800, h: 600 })).toEqual({
      x: 100,
      y: -50,
      w: 400,
      h: 300,
    });
  });
});

describe("minimapLayout", () => {
  it("fits a wide map to the width and derives the height", () => {
    const l = minimapLayout({ x: 0, y: 0, w: 2000, h: 600 }, 200);
    // inner width 188 → scale 0.094; natural height 600*0.094 + 12 = 68.4
    expect(l.scale).toBeCloseTo(0.094);
    expect(l.h).toBeCloseTo(68.4);
  });

  it("caps a tall map's height and fits it to that instead", () => {
    const l = minimapLayout({ x: 0, y: 0, w: 500, h: 3000 }, 200);
    expect(l.h).toBe(150);
    expect(l.scale).toBeCloseTo(138 / 3000);
    // Centred horizontally in the spare width.
    expect(toMinimap(l, { x: 0, y: 0, w: 500, h: 0 }).x).toBeCloseTo((200 - 500 * l.scale) / 2);
  });

  it("round-trips points between the world and the minimap", () => {
    const l = minimapLayout({ x: -100, y: 40, w: 1200, h: 800 }, 200);
    const r = toMinimap(l, { x: 350, y: 420, w: 0, h: 0 });
    const back = fromMinimap(l, r);
    expect(back.x).toBeCloseTo(350);
    expect(back.y).toBeCloseTo(420);
  });
});

describe("union / centreOn", () => {
  it("covers both rects", () => {
    expect(union({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 20, h: 5 })).toEqual({
      x: 0,
      y: -5,
      w: 25,
      h: 15,
    });
  });

  it("puts the world point in the middle of the screen at the same zoom", () => {
    const v = centreOn({ tx: 0, ty: 0, scale: 0.5 }, { x: 1000, y: 400 }, { w: 800, h: 600 });
    expect(v).toEqual({ tx: 400 - 500, ty: 300 - 200, scale: 0.5 });
  });
});
