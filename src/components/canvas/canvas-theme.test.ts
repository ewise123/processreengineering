import { describe, expect, it } from "vitest";
import {
  CONNECTOR_PALETTE,
  DEFAULT_CONNECTOR,
  edgeStroke,
  laneAccent,
  markerIdFor,
  storedConnectorColor,
  THEME,
} from "./canvas-theme";
import { LANE_PALETTE } from "./layout";

describe("laneAccent", () => {
  it("turns the pastel blue lane into a mid-tone blue", () => {
    expect(laneAccent("#dbeafe")).toMatch(/^hsl\(21\d, \d+%, 50%\)$/);
  });

  it("gives every palette colour a saturated, mid-lightness accent", () => {
    for (const c of LANE_PALETTE) {
      const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(laneAccent(c));
      expect(m, c).not.toBeNull();
      expect(Number(m![2])).toBeGreaterThanOrEqual(65);
      expect(Number(m![3])).toBe(50);
    }
  });

  it("keeps a grey lane grey", () => {
    expect(laneAccent("#f1f5f9")).toBe("hsl(215, 16%, 47%)");
  });

  it("accepts 3-digit hex and falls back to slate on junk", () => {
    expect(laneAccent("#fcd")).toMatch(/^hsl\(/);
    expect(laneAccent("not a colour")).toBe("#64748b");
  });
});

describe("connector colours", () => {
  it("draws a connector with no colour black, and its own colour when set", () => {
    expect(edgeStroke({})).toBe(DEFAULT_CONNECTOR);
    expect(edgeStroke({ color: "#15803D" })).toBe("#15803d");
  });

  it("starts a rework loop amber, but lets a picked colour win", () => {
    expect(edgeStroke({ kind: "rework" })).toBe(THEME.rework);
    expect(edgeStroke({ kind: "rework", color: "#1d4ed8" })).toBe("#1d4ed8");
  });

  it("keeps an AI-proposed connector purple whatever its colour", () => {
    expect(edgeStroke({ color: "#15803d" }, { proposed: true })).toBe(THEME.proposed);
  });

  it("stores Black as 'no colour' so it follows the default", () => {
    expect(storedConnectorColor("#0F172A")).toBeNull();
    expect(storedConnectorColor("#B91C1C")).toBe("#b91c1c");
  });

  it("gives each palette colour its own arrowhead id", () => {
    const ids = CONNECTOR_PALETTE.map((p) => markerIdFor(p.color));
    expect(new Set(ids).size).toBe(CONNECTOR_PALETTE.length);
    expect(markerIdFor("#15803D")).toBe("poet-arrow-c15803d");
  });
});
