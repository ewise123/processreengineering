import { describe, expect, it } from "vitest";
import { pointAlong, polylineLength, roundedPath, simplify } from "./rounded-path";

describe("simplify", () => {
  it("drops repeated points and points that don't turn", () => {
    expect(
      simplify([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
      ])
    ).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ]);
  });
});

describe("roundedPath", () => {
  it("draws a straight line unchanged", () => {
    expect(roundedPath([{ x: 0, y: 5 }, { x: 100, y: 5 }])).toBe("M 0 5 L 100 5");
  });

  it("rounds a right-angle corner with the default radius", () => {
    // Right 100, then down 100: the corner at (100,0) is cut 10 back on each leg.
    expect(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])).toBe(
      "M 0 0 L 90 0 Q 100 0 100 10 L 100 100"
    );
  });

  it("caps the radius at half the shorter neighbouring segment", () => {
    // The first leg is only 8 long, so the radius drops to 4.
    expect(roundedPath([{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 100 }], 10)).toBe(
      "M 0 0 L 4 0 Q 8 0 8 4 L 8 100"
    );
  });

  it("rounds every corner of a Z-shaped route", () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
      { x: 100, y: 40 },
    ]);
    expect(d.match(/Q/g)).toHaveLength(2);
    expect(d.startsWith("M 0 0")).toBe(true);
    expect(d.endsWith("L 100 40")).toBe(true);
  });

  it("returns an empty string for no points", () => {
    expect(roundedPath([])).toBe("");
  });
});

describe("pointAlong / polylineLength", () => {
  const route = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
  ];
  it("measures the whole route", () => {
    expect(polylineLength(route)).toBe(150);
  });
  it("walks across the corner onto the next segment", () => {
    expect(pointAlong(route, 120)).toEqual({ x: 100, y: 20 });
  });
  it("clamps past either end", () => {
    expect(pointAlong(route, -5)).toEqual({ x: 0, y: 0 });
    expect(pointAlong(route, 999)).toEqual({ x: 100, y: 50 });
  });
});
