import { describe, expect, it } from "vitest";
import { arrowDirection, clampNudge, type NudgeMember } from "./nudge";

const m = (over: Partial<NudgeMember> = {}): NudgeMember => ({
  id: "a",
  x: 200,
  relativeY: 40,
  h: 64,
  laneH: 200,
  ...over,
});

describe("arrowDirection", () => {
  it("maps the four arrows and ignores other keys", () => {
    expect(arrowDirection("ArrowRight")).toEqual({ dx: 1, dy: 0 });
    expect(arrowDirection("ArrowUp")).toEqual({ dx: 0, dy: -1 });
    expect(arrowDirection("a")).toBeNull();
  });
});

describe("clampNudge", () => {
  it("passes a move through when there's room", () => {
    expect(clampNudge([m()], 4, 24, 44)).toEqual({ dx: 4, dy: 24 });
  });

  it("stops at the bottom of the lane", () => {
    // 200 − 64 − 130 = 6 left before the bottom.
    expect(clampNudge([m({ relativeY: 130 })], 0, 24, 44)).toEqual({ dx: 0, dy: 6 });
    expect(clampNudge([m({ relativeY: 136 })], 0, 4, 44)).toEqual({ dx: 0, dy: 0 });
  });

  it("stops at the top of the lane and at the lane headers", () => {
    expect(clampNudge([m({ relativeY: 2 })], 0, -4, 44)).toEqual({ dx: 0, dy: -2 });
    expect(clampNudge([m({ x: 50 })], -24, 0, 44)).toEqual({ dx: -6, dy: 0 });
  });

  it("moves a group rigidly: the tightest member limits everyone", () => {
    const group = [m({ id: "a", relativeY: 10 }), m({ id: "b", relativeY: 120, laneH: 200 })];
    expect(clampNudge(group, 0, 24, 44)).toEqual({ dx: 0, dy: 16 });
  });

  it("doesn't trap a step that already sits past a limit", () => {
    // Left of the headers from an old drag: can still move right, not further left.
    expect(clampNudge([m({ x: 10 })], 4, 0, 44)).toEqual({ dx: 4, dy: 0 });
    expect(clampNudge([m({ x: 10 })], -4, 0, 44)).toEqual({ dx: 0, dy: 0 });
  });

  it("has no bottom limit for a step without a lane", () => {
    expect(clampNudge([m({ laneH: null, relativeY: 5000 })], 0, 24, 44)).toEqual({ dx: 0, dy: 24 });
  });
});
