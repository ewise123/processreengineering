import { describe, expect, it } from "vitest";
import {
  nextStepSlot,
  occupiedSides,
  pointToLaneSlot,
  quickAddShape,
  quickAddSlot,
  STEP_GAP,
} from "./step-placement";

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

describe("quick add (+ on a step)", () => {
  // Three lanes, 200 tall. Tasks are 170×64; the source sits mid-lane in B.
  const lanes = [
    { id: "A", y: 0, h: 200 },
    { id: "B", y: 200, h: 200 },
    { id: "C", y: 400, h: 200 },
  ];
  const task = { w: 170, h: 64 };
  const src = { id: "s", laneId: "B", x: 500, relativeY: 68, w: 170, h: 64 };

  it("right: the next step in the same lane, source → new", () => {
    const p = quickAddSlot({ side: "right", source: src, size: task, lanes, steps: [src] });
    expect(p).toMatchObject({ laneId: "B", x: 500 + 170 + 80, relativeY: 68, link: "after", moves: [], growLane: null });
  });

  it("left with room: a step before it, new → source", () => {
    const p = quickAddSlot({ side: "left", source: src, size: task, lanes, steps: [src] });
    expect(p).toMatchObject({ laneId: "B", x: 500 - 80 - 170, relativeY: 68, link: "before", moves: [] });
  });

  it("left with no room: takes the source's place and shifts it and later steps right", () => {
    const tight = { ...src, x: 100 };
    const later = { id: "l", laneId: "B", x: 400, relativeY: 68, w: 170, h: 64 };
    const earlierOtherLane = { id: "o", laneId: "A", x: 400, relativeY: 68, w: 170, h: 64 };
    const p = quickAddSlot({ side: "left", source: tight, size: task, lanes, steps: [tight, later, earlierOtherLane] });
    expect(p.x).toBe(100);
    expect(p.link).toBe("before");
    expect(p.moves).toEqual([
      { id: "l", dx: 250, dy: 0 },
      { id: "s", dx: 250, dy: 0 },
    ]);
  });

  it("bottom / top: a hand-off into the lane below / above, level with the source", () => {
    const down = quickAddSlot({ side: "bottom", source: src, size: task, lanes, steps: [src] });
    expect(down).toMatchObject({ laneId: "C", x: 500, relativeY: 68, link: "after" });
    const up = quickAddSlot({ side: "top", source: src, size: task, lanes, steps: [src] });
    expect(up).toMatchObject({ laneId: "A", x: 500 });
  });

  it("slides along in the neighbouring lane when the spot is taken", () => {
    const blocker = { id: "b", laneId: "C", x: 520, relativeY: 68, w: 170, h: 64 };
    const p = quickAddSlot({ side: "bottom", source: src, size: task, lanes, steps: [src, blocker] });
    expect(p.laneId).toBe("C");
    expect(p.x).toBe(500 + 170 + 80);
  });

  it("skips a collapsed lane", () => {
    const withCollapsed = [lanes[0], lanes[1], { ...lanes[2], collapsed: true }, { id: "D", y: 428, h: 200 }];
    const p = quickAddSlot({ side: "bottom", source: src, size: task, lanes: withCollapsed, steps: [src] });
    expect(p.laneId).toBe("D");
  });

  it("no lane below: stacks under the source and grows the lane if it doesn't fit", () => {
    const inC = { ...src, laneId: "C" };
    const p = quickAddSlot({ side: "bottom", source: inC, size: task, lanes, steps: [inC] });
    // 68 + 64 + 24 = 156; needs 156 + 64 + 16 = 236 > 200.
    expect(p).toMatchObject({ laneId: "C", relativeY: 156, growLane: { laneId: "C", toH: 236 } });
  });

  it("no lane above and no room: grows the lane and pushes its steps down", () => {
    const inA = { ...src, laneId: "A", relativeY: 20 };
    const other = { id: "o", laneId: "A", x: 900, relativeY: 20, w: 170, h: 64 };
    const p = quickAddSlot({ side: "top", source: inA, size: task, lanes, steps: [inA, other] });
    // Wanted y = 20 − 24 − 64 = −68 → push everything down 68, lane +68.
    expect(p.relativeY).toBe(0);
    expect(p.growLane).toEqual({ laneId: "A", toH: 268 });
    expect(p.moves).toEqual([
      { id: "o", dx: 0, dy: 68 },
      { id: "s", dx: 0, dy: 68 },
    ]);
  });

  it("no lane above but room: stacks above in the same lane, nothing moves", () => {
    const inA = { ...src, laneId: "A", relativeY: 120 };
    const p = quickAddSlot({ side: "top", source: inA, size: task, lanes, steps: [inA] });
    expect(p).toMatchObject({ laneId: "A", relativeY: 32, moves: [], growLane: null });
  });
});

describe("occupiedSides / quickAddShape", () => {
  it("collects the sides each connector uses at both ends", () => {
    const routes = new Map([["e1", { sourceSide: "right" as const, targetSide: "left" as const }]]);
    const m = occupiedSides([{ id: "e1", from: "a", to: "b" }], routes);
    expect([...m.get("a")!]).toEqual(["right"]);
    expect([...m.get("b")!]).toEqual(["left"]);
  });

  it("adds the same shape, but a task from a Start or End event", () => {
    expect(quickAddShape("task")).toBe("task");
    expect(quickAddShape("gateway_exclusive")).toBe("gateway_exclusive");
    expect(quickAddShape("event_start")).toBe("task");
    expect(quickAddShape("event_end")).toBe("task");
  });
});
