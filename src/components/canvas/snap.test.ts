import { describe, expect, it } from "vitest";
import { computeSnap, guidesFor } from "./snap";

const task = (x: number, y: number) => ({ x, y, w: 170, h: 64 });

describe("computeSnap", () => {
  it("pulls a step onto a neighbour's centre line when within the threshold", () => {
    // Neighbour's vertical middle is y=132; moving middle is 135 → shift −3.
    const r = computeSnap(task(400, 103), [task(100, 100)], 6);
    expect(r.dy).toBe(-3);
    expect(r.dx).toBe(0);
    expect(r.guides).toContainEqual({ axis: "y", at: 100, from: 100, to: 570 });
    expect(r.guides.some((g) => g.axis === "y" && g.at === 132)).toBe(true);
  });

  it("leaves an axis alone when nothing is in range", () => {
    const r = computeSnap(task(400, 120), [task(100, 100)], 6);
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("snaps each axis independently to different neighbours", () => {
    // Left edge near A's left (x 100 vs 104); top near B's top (y 300 vs 297).
    const r = computeSnap(task(104, 297), [task(100, 0), task(600, 300)], 6);
    expect(r.dx).toBe(-4);
    expect(r.dy).toBe(3);
  });

  it("picks the closest line when several are in range", () => {
    // Moving edges 404/489/574: the x=400 neighbour is 4 away, x=402 is 2 away.
    const r = computeSnap(task(404, 0), [task(400, 500), task(402, 900)], 6);
    expect(r.dx).toBe(-2);
  });

  it("matches centres against edges too (a step centred under another's edge)", () => {
    // Moving centre = 103 + 85 = 188; neighbour's right edge = 15 + 170 = 185.
    const r = computeSnap(task(103, 0), [task(15, 300)], 6);
    expect(r.dx).toBe(-3);
  });

  it("does nothing with no neighbours or a zero threshold", () => {
    expect(computeSnap(task(0, 0), [], 6)).toEqual({ dx: 0, dy: 0, guides: [] });
    expect(computeSnap(task(0, 1), [task(0, 0)], 0)).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});

describe("guidesFor", () => {
  it("merges one line shared with several steps into a single guide spanning them all", () => {
    const g = guidesFor(task(100, 200), [task(100, 0), task(100, 500)]);
    const left = g.filter((gg) => gg.axis === "x" && gg.at === 100);
    expect(left).toEqual([{ axis: "x", at: 100, from: 0, to: 564 }]);
  });

  it("returns nothing when the step lines up with nobody", () => {
    expect(guidesFor(task(13, 17), [task(300, 300)])).toEqual([]);
  });
});
