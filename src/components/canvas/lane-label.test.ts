import { describe, expect, it } from "vitest";
import {
  COLLAPSED_END_PAD,
  COLLAPSED_LANE_MAX,
  COLLAPSED_TOGGLE_ZONE,
  collapsedLaneHeight,
  measureLaneLabel,
} from "./lane-label";

describe("collapsedLaneHeight", () => {
  it("fits the arrow, the name and a little room after it", () => {
    // "Finance" at 10px/600 renders about 40px wide.
    expect(collapsedLaneHeight(40)).toBe(40 + COLLAPSED_TOGGLE_ZONE + COLLAPSED_END_PAD);
    expect(collapsedLaneHeight(40.2)).toBe(41 + COLLAPSED_TOGGLE_ZONE + COLLAPSED_END_PAD);
  });

  it("always leaves room for the arrow, and stops at the cap", () => {
    expect(collapsedLaneHeight(0)).toBe(COLLAPSED_TOGGLE_ZONE + COLLAPSED_END_PAD);
    expect(collapsedLaneHeight(2000)).toBe(COLLAPSED_LANE_MAX);
  });
});

describe("measureLaneLabel", () => {
  it("falls back to an estimate without a browser, longer names measuring longer", () => {
    expect(measureLaneLabel("Finance")).toBeGreaterThan(0);
    expect(measureLaneLabel("Accounts Payable")).toBeGreaterThan(measureLaneLabel("Finance"));
  });
});
