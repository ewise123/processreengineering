import { describe, expect, it } from "vitest";
import { spreadUnplaced } from "./layout";

const node = (id: string, laneId: string, x: number, w = 50) => ({
  id,
  laneId,
  x,
  relativeY: 50,
  w,
  h: 50,
});

describe("spreadUnplaced", () => {
  it("pulls a blank map's Start and End apart instead of stacking them", () => {
    const start = node("start", "lane", 110);
    const end = node("end", "lane", 110);
    spreadUnplaced([start, end], new Map([["start", 0], ["end", 1]]));
    expect(start.x).toBe(110);
    expect(end.x).toBe(110 + 50 + 60);
  });

  it("never moves a node the user has placed", () => {
    const placed = node("placed", "lane", 110);
    const fresh = node("fresh", "lane", 110);
    spreadUnplaced([placed, fresh], new Map([["fresh", 0]]));
    expect(placed.x).toBe(110);
    expect(fresh.x).toBe(220);
  });

  it("leaves nodes in different lanes alone", () => {
    const a = node("a", "lane-1", 110);
    const b = node("b", "lane-2", 110);
    spreadUnplaced([a, b], new Map([["a", 0], ["b", 0]]));
    expect(a.x).toBe(110);
    expect(b.x).toBe(110);
  });

  it("orders by the saved column hint, then by x", () => {
    const later = node("later", "lane", 110);
    const first = node("first", "lane", 110);
    spreadUnplaced([later, first], new Map([["later", 2], ["first", 0]]));
    expect(first.x).toBe(110);
    expect(later.x).toBe(220);
  });
});
