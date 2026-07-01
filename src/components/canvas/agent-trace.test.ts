import { describe, it, expect } from "vitest";
import { traceHeaderLabel, showUngroundedWarning } from "./agent-trace";

describe("traceHeaderLabel", () => {
  it("counts steps", () => {
    expect(traceHeaderLabel([{ tool: "a", summary: "x" }, { tool: "b", summary: "y" }])).toBe(
      "How I found this · 2 steps"
    );
  });
  it("uses singular for one step", () => {
    expect(traceHeaderLabel([{ tool: "a", summary: "x" }])).toBe("How I found this · 1 step");
  });
  it("returns empty string for no steps", () => {
    expect(traceHeaderLabel([])).toBe("");
    expect(traceHeaderLabel(undefined)).toBe("");
  });
});

describe("showUngroundedWarning", () => {
  it("warns only when explicitly not grounded", () => {
    expect(showUngroundedWarning(false)).toBe(true);
    expect(showUngroundedWarning(true)).toBe(false);
    expect(showUngroundedWarning(undefined)).toBe(false);
  });
});
