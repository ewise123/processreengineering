import { describe, it, expect } from "vitest";
import { buildEdgePath, buildPinnedEdgePath, isReworkEdge } from "./shapes";

// Two nodes side by side on the same row. "to" sits to the LEFT of "from",
// i.e. a backtrack: the user drags from the later step back to an earlier one.
const later = { x: 400, y: 100, w: 120, h: 60 };  // center (460, 130)
const earlier = { x: 0, y: 100, w: 120, h: 60 };  // center (60, 130)

describe("buildPinnedEdgePath", () => {
  it("bottom→bottom loops below both nodes and enters the target's bottom face", () => {
    const r = buildPinnedEdgePath(later, earlier, "bottom", "bottom");
    // exit at source bottom-center, enter at target bottom-center
    expect(r.d).toBe("M 460 160 L 460 216 L 60 216 L 60 160");
    expect(r.orientation).toBe("vertical");
    // channel sits one LOOP_OFFSET (56) below the lower of the two bottoms (160)
    expect(r.midY).toBe(216);
    expect(r.midSegment).toEqual({ x1: 460, y1: 216, x2: 60, y2: 216 });
  });

  it("top→top loops above both nodes and enters the target's top face", () => {
    const r = buildPinnedEdgePath(later, earlier, "top", "top");
    expect(r.d).toBe("M 460 100 L 460 44 L 60 44 L 60 100");
    expect(r.midY).toBe(44);
  });

  it("honors a user-dragged bend (bend_y) as the channel position", () => {
    const r = buildPinnedEdgePath(later, earlier, "bottom", "bottom", 300);
    expect(r.d).toBe("M 460 160 L 460 300 L 60 300 L 60 160");
    expect(r.midY).toBe(300);
  });

  it("mixed faces bias the channel to the source's exit direction", () => {
    // source exits bottom (160) → channel 56 below = 216; target enters top (100)
    const r = buildPinnedEdgePath(later, earlier, "bottom", "top");
    expect(r.d).toBe("M 460 160 L 460 216 L 60 216 L 60 100");
  });
});

describe("isReworkEdge", () => {
  it("returns true when kind is rework, even with no sides pinned", () => {
    expect(isReworkEdge({ kind: "rework", sourceSide: null, targetSide: null })).toBe(true);
  });

  it("returns true when both sides are pinned, even if kind is flow", () => {
    expect(isReworkEdge({ kind: "flow", sourceSide: "bottom", targetSide: "bottom" })).toBe(true);
  });

  it("returns false when only one side is pinned", () => {
    expect(isReworkEdge({ kind: "flow", sourceSide: "bottom", targetSide: null })).toBe(false);
  });

  it("returns false when neither side is pinned and kind is flow", () => {
    expect(isReworkEdge({ kind: "flow", sourceSide: null, targetSide: null })).toBe(false);
  });
});

describe("buildEdgePath delegation", () => {
  it("routes through the pinned path only when BOTH sides are set", () => {
    const pinned = buildEdgePath(later, earlier, {
      sourceSide: "bottom",
      targetSide: "bottom",
    });
    expect(pinned.d).toBe(buildPinnedEdgePath(later, earlier, "bottom", "bottom").d);
  });

  it("falls back to geometric routing when a side is missing", () => {
    const onlyOne = buildEdgePath(later, earlier, { sourceSide: "bottom" });
    const geometric = buildEdgePath(later, earlier);
    expect(onlyOne.d).toBe(geometric.d);
    // geometric backtrack on the same row is a straight horizontal segment
    expect(geometric.orientation).toBe("horizontal");
  });
});
