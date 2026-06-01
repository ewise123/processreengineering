import { describe, expect, it } from "vitest";

import { diffChangeCount, isEmptyDiff } from "./version-diff";
import type { VersionDiff } from "@/lib/types";

const empty: VersionDiff = {
  nodes: { added: [], removed: [], renamed: [], moved: [], unchanged_count: 7 },
  edges: { added: [], removed: [] },
  lanes: { added: [], removed: [] },
};

const some: VersionDiff = {
  nodes: {
    added: [{ name: "x" }],
    removed: [],
    renamed: [{ name: "b", from_name: "a" }],
    moved: [{ name: "c", from_lane: "L1", to_lane: "L2" }],
    unchanged_count: 3,
  },
  edges: { added: [{ source: "x", target: "y" }], removed: [] },
  lanes: { added: [], removed: [{ name: "Old" }] },
};

describe("diffChangeCount", () => {
  it("counts every change kind, ignoring unchanged_count", () => {
    expect(diffChangeCount(some)).toBe(5); // 1 added + 1 renamed + 1 moved + 1 edge added + 1 lane removed
  });
  it("is zero for an all-unchanged diff", () => {
    expect(diffChangeCount(empty)).toBe(0);
  });
});

describe("isEmptyDiff", () => {
  it("true when nothing changed", () => {
    expect(isEmptyDiff(empty)).toBe(true);
  });
  it("false when there are changes", () => {
    expect(isEmptyDiff(some)).toBe(false);
  });
});
