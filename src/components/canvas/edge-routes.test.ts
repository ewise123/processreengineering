import { describe, expect, it } from "vitest";
import { buildEdgePath } from "./edge-path";
import { computeEdgeRoutes, sideOf, type RoutableNode } from "./edge-routes";

// The invoice map from the "before" screenshot (issue #95): two lanes, a
// decision whose No branch goes back to a correction step, and a rework loop
// from that step up to "Match invoice to PO".
const match: RoutableNode = { id: "match", kind: "task", x: 450, y: 68, w: 170, h: 64 };
const gw: RoutableNode = { id: "gw", kind: "gateway", x: 690, y: 70, w: 60, h: 60 };
const approve: RoutableNode = { id: "approve", kind: "task", x: 820, y: 268, w: 170, h: 64 };
const correct: RoutableNode = { id: "correct", kind: "task", x: 450, y: 268, w: 170, h: 64 };
const nodes = [match, gw, approve, correct];

const flow = (id: string, from: string, to: string) => ({ id, from, to });
const edges = [
  flow("e-in", "match", "gw"),
  flow("e-yes", "gw", "approve"),
  flow("e-no", "gw", "correct"),
  { id: "e-rework", from: "correct", to: "match", sourceSide: "top" as const, targetSide: "bottom" as const },
];

describe("computeEdgeRoutes — gateway branches", () => {
  const routes = computeEdgeRoutes(edges, nodes);

  it("sends Yes and No out of different corners of the diamond", () => {
    expect(routes.get("e-yes")!.sourceSide).toBe("right");
    expect(routes.get("e-no")!.sourceSide).toBe("bottom");
  });

  it("keeps the corner the incoming connector uses free", () => {
    expect(routes.get("e-in")!.targetSide).toBe("left");
    expect(routes.get("e-yes")!.sourceSide).not.toBe("left");
    expect(routes.get("e-no")!.sourceSide).not.toBe("left");
  });

  it("routes Yes right-then-down into the top of Approve", () => {
    expect(routes.get("e-yes")!.points).toEqual([
      { x: 750, y: 100 },
      { x: 905, y: 100 },
      { x: 905, y: 268 },
    ]);
  });

  it("routes No down-then-left into the side of the correction step, off the rework loop", () => {
    const no = routes.get("e-no")!;
    expect(no.points[no.points.length - 1]).toEqual({ x: 620, y: 300 });
    expect(no.targetSide).toBe("right");
    // The rework loop leaves the correction step's top — a different face.
    expect(routes.get("e-rework")!.sourceSide).toBe("top");
  });

  it("puts a branch label near the gateway, not mid-route", () => {
    expect(routes.get("e-yes")!.labelAt).toEqual({ x: 780, y: 100 });
  });
});

describe("computeEdgeRoutes — shared sides", () => {
  const a: RoutableNode = { id: "a", kind: "task", x: 0, y: 0, w: 170, h: 64 };
  const b: RoutableNode = { id: "b", kind: "task", x: 400, y: 0, w: 170, h: 64 };

  it("pulls an A→B / B→A pair apart instead of drawing one double-headed line", () => {
    const r = computeEdgeRoutes([flow("ab", "a", "b"), flow("ba", "b", "a")], [a, b]);
    const ab = r.get("ab")!;
    const ba = r.get("ba")!;
    const abY = ab.points.map((p) => p.y);
    const baY = ba.points.map((p) => p.y);
    expect(new Set(abY).size).toBe(1); // still straight
    expect(new Set(baY).size).toBe(1);
    expect(abY[0]).not.toBe(baY[0]);
    expect(Math.abs(abY[0] - baY[0])).toBeGreaterThanOrEqual(8);
  });

  it("orders connectors on one side by where they're going, so they don't cross", () => {
    const hub: RoutableNode = { id: "hub", kind: "task", x: 0, y: 200, w: 170, h: 64 };
    const up: RoutableNode = { id: "up", kind: "task", x: 400, y: 0, w: 170, h: 64 };
    const down: RoutableNode = { id: "down", kind: "task", x: 400, y: 400, w: 170, h: 64 };
    const r = computeEdgeRoutes([flow("to-down", "hub", "down"), flow("to-up", "hub", "up")], [hub, up, down]);
    expect(r.get("to-up")!.points[0].y).toBeLessThan(r.get("to-down")!.points[0].y);
  });

  it("leaves a lone connector exactly where plain routing puts it", () => {
    const r = computeEdgeRoutes([flow("ab", "a", "b")], [a, b]);
    expect(r.get("ab")!.d).toBe(buildEdgePath(a, b).d);
  });
});

describe("computeEdgeRoutes — respects the user's hand", () => {
  it("does not force a gateway exit on a branch the user has bent", () => {
    const bent = [
      flow("e-in", "match", "gw"),
      { id: "e-yes", from: "gw", to: "approve", bendY: 220 },
      flow("e-no", "gw", "correct"),
    ];
    const r = computeEdgeRoutes(bent, nodes);
    expect(r.get("e-yes")!.d).toBe(buildEdgePath(gw, approve, { bendY: 220 }).d);
  });

  it("keeps a pinned rework loop on its pinned faces", () => {
    const r = computeEdgeRoutes(edges, nodes).get("e-rework")!;
    expect(r.sourceSide).toBe("top");
    expect(r.targetSide).toBe("bottom");
  });

  it("skips edges whose ends aren't on the canvas (collapsed lanes)", () => {
    const r = computeEdgeRoutes([flow("x", "match", "gone")], nodes);
    expect(r.size).toBe(0);
  });
});

describe("sideOf", () => {
  const r = { x: 0, y: 0, w: 100, h: 50 };
  it("classifies points on each face", () => {
    expect(sideOf(r, { x: 50, y: 0 })).toBe("top");
    expect(sideOf(r, { x: 100, y: 25 })).toBe("right");
    expect(sideOf(r, { x: 50, y: 50 })).toBe("bottom");
    expect(sideOf(r, { x: 0, y: 25 })).toBe("left");
  });
});
