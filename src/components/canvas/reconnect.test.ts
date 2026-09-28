import { describe, expect, it } from "vitest";
import { edgeEnds, planReconnect, reconnectReason } from "./reconnect";
import type { CanvasEdge } from "./types";

// A → B → C left to right in one row, D below A.
const boxes = new Map([
  ["A", { x: 0, y: 0, w: 100, h: 60 }],
  ["B", { x: 200, y: 0, w: 100, h: 60 }],
  ["C", { x: 400, y: 0, w: 100, h: 60 }],
  ["D", { x: 0, y: 200, w: 100, h: 60 }],
]);
const ab: CanvasEdge = { id: "e1", from: "A", to: "B", label: "yes", bendX: 150, color: "#1d4ed8" };
const bc: CanvasEdge = { id: "e2", from: "B", to: "C", label: null };
const edges = [ab, bc];
const plan = (edge: CanvasEdge, end: "source" | "target", dropId: string | null, dropY = 30) =>
  planReconnect({ edge, end, dropId, dropY, boxes, edges, fixedSide: "right" });

describe("planReconnect", () => {
  it("moves the head forward: a plain flow, bend reset", () => {
    expect(plan(ab, "target", "C")).toEqual({
      ok: true,
      next: { from: "A", to: "C", kind: "flow", sourceSide: null, targetSide: null, bendX: null, bendY: null },
    });
  });

  it("moves the tail to another step", () => {
    const r = plan(ab, "source", "D");
    expect(r.ok && r.next.from).toBe("D");
    expect(r.ok && r.next.to).toBe("B");
    expect(r.ok && r.next.kind).toBe("flow");
  });

  it("a backward head becomes a loop, landing on the face the drop was nearer", () => {
    const r = planReconnect({ edge: bc, end: "target", dropId: "A", dropY: 50, boxes, edges, fixedSide: "bottom" });
    expect(r).toEqual({
      ok: true,
      next: { from: "B", to: "A", kind: "rework", sourceSide: "bottom", targetSide: "bottom", bendX: null, bendY: null },
    });
  });

  it("a backward tail loops from the face nearest the drop", () => {
    // Move A→B's tail onto C: C → B runs backwards.
    const r = plan(ab, "source", "C", 5);
    expect(r.ok && r.next).toMatchObject({ from: "C", to: "B", kind: "rework", sourceSide: "top", targetSide: "top" });
  });

  it("a loop moved forward drops its pinned faces", () => {
    const loop: CanvasEdge = { id: "e3", from: "C", to: "A", label: null, kind: "rework", sourceSide: "bottom", targetSide: "bottom" };
    const r = planReconnect({ edge: loop, end: "source", dropId: "D", dropY: 230, boxes, edges: [...edges, loop], fixedSide: "bottom" });
    // D (x 0) → A (x 0) isn't backwards.
    expect(r.ok && r.next).toMatchObject({ kind: "flow", sourceSide: null, targetSide: null });
  });

  it("snaps back on empty canvas, the same step, its own other end, or an existing pair", () => {
    expect(plan(ab, "target", null)).toEqual({ ok: false, why: "none" });
    expect(plan(ab, "target", "B")).toEqual({ ok: false, why: "same" });
    expect(plan(ab, "target", "A")).toEqual({ ok: false, why: "self" });
    // B → C already exists, so moving B→D's head onto C would duplicate it.
    const bd: CanvasEdge = { id: "e4", from: "B", to: "D", label: null };
    expect(planReconnect({ edge: bd, end: "target", dropId: "C", dropY: 30, boxes, edges: [...edges, bd], fixedSide: "right" }))
      .toEqual({ ok: false, why: "duplicate" });
  });
});

describe("edgeEnds", () => {
  it("captures what undo needs, with defaults filled in", () => {
    expect(edgeEnds(ab)).toEqual({ from: "A", to: "B", kind: "flow", sourceSide: null, targetSide: null, bendX: 150, bendY: null });
  });
});

describe("reconnectReason", () => {
  it("names the old and new pair", () => {
    const names = new Map([["A", "Review"], ["B", "File"], ["C", "Approve"]]);
    expect(reconnectReason(names, { from: "A", to: "B" }, { from: "A", to: "C" }))
      .toBe("Reconnected: Review → Approve (was Review → File)");
  });

  it("falls back for an unnamed step", () => {
    expect(reconnectReason(new Map([["A", " "]]), { from: "A", to: "B" }, { from: "A", to: "C" }))
      .toBe("Reconnected: Untitled step → Untitled step (was Untitled step → Untitled step)");
  });
});
