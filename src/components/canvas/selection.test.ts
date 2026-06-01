import { describe, it, expect } from "vitest";
import { normalizeMarquee, rectsIntersect, nodesInMarquee } from "./selection";

describe("normalizeMarquee", () => {
  it("normalizes a top-left → bottom-right drag", () => {
    expect(normalizeMarquee(10, 20, 40, 60)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
  it("normalizes a bottom-right → top-left drag", () => {
    expect(normalizeMarquee(40, 60, 10, 20)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
  it("normalizes a bottom-left → top-right drag", () => {
    expect(normalizeMarquee(10, 60, 40, 20)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
  it("handles a zero-size drag", () => {
    expect(normalizeMarquee(5, 5, 5, 5)).toEqual({ x: 5, y: 5, w: 0, h: 0 });
  });
});

describe("rectsIntersect", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  it("true when overlapping", () => {
    expect(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });
  it("true when edges touch", () => {
    expect(rectsIntersect(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(true);
  });
  it("false when fully apart", () => {
    expect(rectsIntersect(a, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
  });
  it("true when one contains the other", () => {
    expect(rectsIntersect(a, { x: 2, y: 2, w: 2, h: 2 })).toBe(true);
  });
});

describe("nodesInMarquee", () => {
  const nodes = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 100, y: 100, w: 10, h: 10 },
    { id: "c", x: 5, y: 5, w: 10, h: 10 },
  ];
  it("returns ids of nodes overlapping the marquee, in input order", () => {
    expect(nodesInMarquee(nodes, { x: -1, y: -1, w: 8, h: 8 })).toEqual(["a", "c"]);
  });
  it("returns empty when nothing overlaps", () => {
    expect(nodesInMarquee(nodes, { x: 200, y: 200, w: 5, h: 5 })).toEqual([]);
  });
});
