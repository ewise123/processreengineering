import { describe, expect, it } from "vitest";
import { pickDropTarget } from "./drop-target";

// ── Helpers ──────────────────────────────────────────────────────

interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Single 100×100 rectangle at (0,0). */
const boxA: Rect = { id: "a", x: 0, y: 0, width: 100, height: 100 };

/** A smaller rectangle fully inside A. */
const boxB: Rect = { id: "b", x: 10, y: 10, width: 30, height: 30 };

/** Another 100×100 rectangle far away from A. */
const boxC: Rect = { id: "c", x: 500, y: 0, width: 100, height: 100 };

// ── Inside a rectangle ───────────────────────────────────────────

describe("pickDropTarget — inside a rectangle", () => {
  it("targets the rectangle when the cursor is at the center", () => {
    expect(pickDropTarget({ x: 50, y: 50 }, [boxA], 0)).toBe("a");
  });

  it("targets the rectangle when the cursor is at an edge", () => {
    // pixel (100,50) is on the right edge — should still count as inside
    expect(pickDropTarget({ x: 100, y: 50 }, [boxA], 0)).toBe("a");
  });

  it("targets the rectangle when the cursor is at a corner", () => {
    expect(pickDropTarget({ x: 100, y: 100 }, [boxA], 0)).toBe("a");
  });

  it("targets the rectangle when the cursor is at (0,0) — top-left origin", () => {
    expect(pickDropTarget({ x: 0, y: 0 }, [boxA], 0)).toBe("a");
  });
});

// ── Inside overlapping rectangles ─────────────────────────────────

describe("pickDropTarget — overlapping rectangles (prefer smaller)", () => {
  it("prefers the smaller rectangle when the cursor is inside both", () => {
    // boxB is fully inside boxA
    expect(pickDropTarget({ x: 25, y: 25 }, [boxA, boxB], 0)).toBe("b");
  });

  it("returns the single candidate when only one contains the cursor", () => {
    // cursor at (95, 95) is inside A but outside B
    expect(pickDropTarget({ x: 95, y: 95 }, [boxA, boxB], 0)).toBe("a");
  });
});

// ── Outside every rectangle — tolerance distance ─────────────────

describe("pickDropTarget — outside but within tolerance distance", () => {
  it("targets the nearest rectangle when within tolerance", () => {
    // cursor 5px to the right of A's right edge
    expect(pickDropTarget({ x: 105, y: 50 }, [boxA], 10)).toBe("a");
  });

  it("targets the nearest rectangle when within tolerance above", () => {
    expect(pickDropTarget({ x: 50, y: -5 }, [boxA], 10)).toBe("a");
  });

  it("targets the nearest rectangle when within tolerance diagonally", () => {
    // (102, -2) is 2px right and 2px above A — distance to edge ≈ 2.8
    expect(pickDropTarget({ x: 102, y: -2 }, [boxA], 5)).toBe("a");
  });

  it("prefers the closest rectangle by edge distance when both are within tolerance", () => {
    // A at (0,0) 100×100; a second rect at (200,0) 100×100; cursor at (55,105)
    // distance to A's bottom edge = 5; distance to second rect = much larger
    const second: Rect = { id: "z", x: 200, y: 0, width: 100, height: 100 };
    const candidates = [boxA, second];
    expect(pickDropTarget({ x: 55, y: 105 }, candidates, 50)).toBe("a");
  });

  it("returns null when the cursor has no tolerance", () => {
    expect(pickDropTarget({ x: 101, y: 50 }, [boxA], 0)).toBeNull();
  });
});

// ── Beyond tolerance → null ──────────────────────────────────────

describe("pickDropTarget — beyond tolerance", () => {
  it("returns null when the nearest rectangle is farther than tolerance", () => {
    expect(pickDropTarget({ x: 200, y: 50 }, [boxA], 10)).toBeNull();
  });

  it("returns null when no rectangle exists", () => {
    expect(pickDropTarget({ x: 50, y: 50 }, [], 100)).toBeNull();
  });

  it("returns null when all rectangles are far away", () => {
    expect(pickDropTarget({ x: 9999, y: 9999 }, [boxA, boxC], 10)).toBeNull();
  });
});

// ── Preference tie-breakers ──────────────────────────────────────

describe("pickDropTarget — tie-breakers", () => {
  it("when two rectangles are at equal distance, prefers the smaller one", () => {
    // Two separate, non-overlapping rects of different sizes, cursor equidistant.
    // rect-1: (0,0) 100×100  → center (50,50)
    // rect-2: (300,0) 50×50  → center (325,25)
    // cursor at (150, 150) is roughly equidistant from both edges on the bottom side.
    // Both distances should be similar, so the smaller (50×50) should win.
    const r1: Rect = { id: "r1", x: 0, y: 0, width: 100, height: 100 };
    const r2: Rect = { id: "r2", x: 300, y: 0, width: 50, height: 50 };

    // (150, 50): distance to r1's right edge = 150 - 100 = 50
    // distance to r2's left edge = 300 - 150 = 150
    // They aren't equal — we need a point truly equidistant.
    // Point (200, 25): distance to r1 right edge = 100, distance to r2 left edge = 100.
    // r1 area = 10000, r2 area = 2500 → r2 is smaller, should win.
    expect(pickDropTarget({ x: 200, y: 25 }, [r1, r2], 100)).toBe("r2");
  });

  it("when an inside candidate exists, outside candidates are ignored regardless of size", () => {
    // boxB (small) is at (10,10) 30×30. boxA (large) is at (0,0) 100×100.
    // Cursor at (95,95) — inside A, outside B.
    // A should win even though B is smaller, because B doesn't contain the point.
    expect(pickDropTarget({ x: 95, y: 95 }, [boxA, boxB], 10)).toBe("a");
  });
});

// ── Edge cases ───────────────────────────────────────────────────

describe("pickDropTarget — edge cases", () => {
  it("handles a zero-sized rectangle gracefully — point exactly at origin is inside", () => {
    const dot: Rect = { id: "d", x: 5, y: 5, width: 0, height: 0 };
    expect(pickDropTarget({ x: 5, y: 5 }, [dot], 10)).toBe("d");
  });

  it("returns null for a zero-sized rectangle when point is different but within tolerance", () => {
    // distance from (7, 5) to the zero-area rect at (5,5) = 2 — within tolerance 10
    // The function should still return it because the edge distance is 2.
    const dot: Rect = { id: "d", x: 5, y: 5, width: 0, height: 0 };
    expect(pickDropTarget({ x: 7, y: 5 }, [dot], 10)).toBe("d");
  });

  it("works with float coordinates", () => {
    // A rectangle at (0,0) 100×100, cursor at (100.5, 50.0)
    // distance = 0.5 to right edge; tolerance=1 → should match
    expect(pickDropTarget({ x: 100.5, y: 50 }, [boxA], 1)).toBe("a");
  });

  it("returns a consistent result regardless of candidate ordering", () => {
    // The same two candidates, shuffled — same result.
    const r1: Rect = { id: "r1", x: 0, y: 0, width: 10, height: 10 };
    const r2: Rect = { id: "r2", x: 5, y: 5, width: 100, height: 100 };
    // Cursor at (7, 7) is inside both — r1 is smaller, should always win.
    expect(pickDropTarget({ x: 7, y: 7 }, [r1, r2], 0)).toBe("r1");
    expect(pickDropTarget({ x: 7, y: 7 }, [r2, r1], 0)).toBe("r1");
  });
});

// ── Tolerance defaults ───────────────────────────────────────────

describe("pickDropTarget — tolerance default", () => {
  it("defaults tolerance to 0 when not provided, so only interior hits count", () => {
    // Without an explicit tolerance the function should not accept outside hits.
    // We call with 3 args (omit tolerance).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = pickDropTarget as any;
    // cursor 1px outside — should not match with default tolerance
    expect(fn({ x: 101, y: 50 }, [boxA])).toBeNull();
  });
});