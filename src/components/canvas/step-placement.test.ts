import { describe, expect, it } from "vitest";
import { nextStepSlot, pointToLaneSlot, STEP_GAP } from "./step-placement";

const task = { w: 170, h: 64 };

describe("nextStepSlot", () => {
  it("puts the next task one gap to the right, on the source's centre line", () => {
    const source = { x: 100, relativeY: 68, w: 170, h: 64 };
    expect(nextStepSlot(source, task, [source], 200)).toEqual({
      x: 100 + 170 + STEP_GAP,
      relativeY: 68,
    });
  });

  it("centres on a smaller source (a gateway or event) instead of copying its top", () => {
    const gateway = { x: 100, relativeY: 70, w: 60, h: 60 }; // centre y = 100
    const slot = nextStepSlot(gateway, task, [gateway], 200);
    expect(slot.relativeY + task.h / 2).toBe(100);
  });

  it("drops lower in the lane when the slot beside the source is taken", () => {
    const source = { x: 100, relativeY: 20, w: 170, h: 64 };
    const taken = { x: 350, relativeY: 20, w: 170, h: 64 };
    const slot = nextStepSlot(source, task, [source, taken], 300);
    expect(slot.x).toBe(350);
    expect(slot.relativeY).toBe(20 + 64 + 24);
  });

  it("moves a column right when the lane is full at that column", () => {
    const source = { x: 100, relativeY: 68, w: 170, h: 64 };
    const taken = { x: 350, relativeY: 68, w: 170, h: 64 };
    const slot = nextStepSlot(source, task, [source, taken], 200);
    expect(slot.x).toBe(350 + 170 + STEP_GAP);
  });

  it("stays inside a short lane", () => {
    const source = { x: 100, relativeY: 150, w: 170, h: 64 };
    const slot = nextStepSlot(source, task, [source], 180);
    expect(slot.relativeY).toBeLessThanOrEqual(180 - 64);
    expect(slot.relativeY).toBeGreaterThanOrEqual(0);
  });
});

describe("pointToLaneSlot", () => {
  const lanes = [
    { id: "a", y: 0, h: 200 },
    { id: "b", y: 200, h: 200 },
    { id: "c", y: 400, h: 28, collapsed: true },
  ];

  it("centres the new step on the point, in the lane under it", () => {
    expect(pointToLaneSlot({ x: 500, y: 300 }, lanes, task)).toEqual({
      laneId: "b",
      x: 500 - 85,
      relativeY: 100 - 32,
    });
  });

  it("keeps the step inside its lane near an edge", () => {
    expect(pointToLaneSlot({ x: 500, y: 5 }, lanes, task)!.relativeY).toBe(0);
    expect(pointToLaneSlot({ x: 500, y: 199 }, lanes, task)!.relativeY).toBe(200 - 64);
  });

  it("returns null over the lane headers, a collapsed lane, or outside all lanes", () => {
    expect(pointToLaneSlot({ x: 20, y: 100 }, lanes, task)).toBeNull();
    expect(pointToLaneSlot({ x: 500, y: 410 }, lanes, task)).toBeNull();
    expect(pointToLaneSlot({ x: 500, y: 900 }, lanes, task)).toBeNull();
  });

  it("doesn't let a step overlap the header strip", () => {
    expect(pointToLaneSlot({ x: 60, y: 100 }, lanes, task)!.x).toBe(52);
  });
});
