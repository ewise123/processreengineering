import { describe, expect, it } from "vitest";
import { routesToReset } from "./routes";

const edges = [
  { id: "e1", from: "a", to: "b", bendX: 300, bendY: null },
  { id: "e2", from: "b", to: "c", bendX: null, bendY: null },
  { id: "e3", from: "c", to: "d", bendX: null, bendY: 120 },
  { id: "e4", from: "a", to: "d", bendX: 50 },
];

describe("routesToReset", () => {
  it("takes bent connectors whose two ends are both selected", () => {
    expect(routesToReset(edges, new Set(["a", "b", "c"]))).toEqual([
      { id: "e1", bendX: 300, bendY: null },
    ]);
  });

  it("takes a bent connector that is itself selected, whatever its ends", () => {
    expect(routesToReset(edges, new Set(["e3"]))).toEqual([{ id: "e3", bendX: null, bendY: 120 }]);
  });

  it("skips connectors with no bend and ones with only one end selected", () => {
    expect(routesToReset(edges, new Set(["b", "c"]))).toEqual([]);
    expect(routesToReset(edges, new Set(["a"]))).toEqual([]);
  });

  it("treats a missing bend field as no bend", () => {
    expect(routesToReset([{ id: "e", from: "a", to: "b" }], new Set(["e"]))).toEqual([]);
  });
});
