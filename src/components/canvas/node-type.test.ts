import { describe, expect, it } from "vitest";

import { NODE_TYPE_OPTIONS, sizeForNodeType } from "./node-type";

// Mirrors the backend NodeUpdate/NodeCreate allow-list.
const BACKEND_TYPES = [
  "task",
  "event_start",
  "event_end",
  "event_intermediate",
  "gateway_exclusive",
  "gateway_parallel",
  "gateway_inclusive",
  "subprocess",
];

describe("NODE_TYPE_OPTIONS", () => {
  it("offers exactly the backend NodeType values", () => {
    const values = NODE_TYPE_OPTIONS.map((o) => o.value).sort();
    expect(values).toEqual([...BACKEND_TYPES].sort());
  });

  it("gives every option a non-empty label", () => {
    for (const o of NODE_TYPE_OPTIONS) {
      expect(o.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("sizeForNodeType", () => {
  it("sizes gateways at 60x60", () => {
    expect(sizeForNodeType("gateway_exclusive")).toEqual({ w: 60, h: 60 });
    expect(sizeForNodeType("gateway_parallel")).toEqual({ w: 60, h: 60 });
  });

  it("sizes tasks/subprocess at 170x64", () => {
    expect(sizeForNodeType("task")).toEqual({ w: 170, h: 64 });
    expect(sizeForNodeType("subprocess")).toEqual({ w: 170, h: 64 });
  });

  it("sizes events at 50x50", () => {
    expect(sizeForNodeType("event_start")).toEqual({ w: 50, h: 50 });
    expect(sizeForNodeType("event_end")).toEqual({ w: 50, h: 50 });
    expect(sizeForNodeType("event_intermediate")).toEqual({ w: 50, h: 50 });
  });

  it("falls back to task size for unknown types", () => {
    expect(sizeForNodeType("nonsense")).toEqual({ w: 170, h: 64 });
  });
});
