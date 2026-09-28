import { describe, expect, it } from "vitest";
import {
  COLLAPSED_ARROW_BOTTOM,
  COLLAPSED_GAP,
  COLLAPSED_LANE_MAX,
  collapsedLaneHeight,
  measureLaneLabel,
} from "./lane-label";

describe("collapsedLaneHeight", () => {
  it("fits the arrow, the name and a little room after it", () => {
    // "Finance" at 10px/600 renders about 40px wide.
    // arrow, gap, name, the same gap again.
    expect(collapsedLaneHeight(40)).toBe(COLLAPSED_ARROW_BOTTOM + COLLAPSED_GAP + 40 + COLLAPSED_GAP);
    expect(collapsedLaneHeight(40.2)).toBe(COLLAPSED_ARROW_BOTTOM + COLLAPSED_GAP + 41 + COLLAPSED_GAP);
  });

  it("always leaves room for the arrow, and stops at the cap", () => {
    expect(collapsedLaneHeight(0)).toBe(COLLAPSED_ARROW_BOTTOM + COLLAPSED_GAP * 2);
    expect(collapsedLaneHeight(2000)).toBe(COLLAPSED_LANE_MAX);
  });
});

describe("measureLaneLabel", () => {
  it("falls back to an estimate without a browser, longer names measuring longer", () => {
    expect(measureLaneLabel("Finance")).toBeGreaterThan(0);
    expect(measureLaneLabel("Accounts Payable")).toBeGreaterThan(measureLaneLabel("Finance"));
  });
});
