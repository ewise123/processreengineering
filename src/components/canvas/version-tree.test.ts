import { describe, expect, it } from "vitest";

import { buildVersionRows } from "./version-tree";
import type { VersionSummary } from "@/lib/types";

function v(
  id: string,
  version_number: number,
  parent_version_id: string | null
): VersionSummary {
  return {
    id,
    version_number,
    parent_version_id,
    status: "draft",
    notes: null,
    created_at: "2026-05-29T00:00:00Z",
    node_count: 0,
    lane_count: 0,
    edge_count: 0,
  };
}

describe("buildVersionRows", () => {
  it("puts a linear chain in a single column", () => {
    const rows = buildVersionRows([
      v("a", 1, null),
      v("b", 2, "a"),
      v("c", 3, "b"),
    ]);
    expect(rows.map((r) => r.column)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.parentColumn)).toEqual([null, 0, 0]);
  });

  it("forks a parent's second child into a new column", () => {
    const rows = buildVersionRows([
      v("a", 1, null),
      v("b", 2, "a"),
      v("c", 3, "a"),
    ]);
    const col = Object.fromEntries(rows.map((r) => [r.version.id, r.column]));
    expect(col.a).toBe(0);
    expect(col.b).toBe(0);
    expect(col.c).toBe(1);
    const pcol = Object.fromEntries(rows.map((r) => [r.version.id, r.parentColumn]));
    expect(pcol.c).toBe(0);
  });

  it("assigns each additional child its own column", () => {
    const rows = buildVersionRows([
      v("a", 1, null),
      v("b", 2, "a"),
      v("c", 3, "a"),
      v("d", 4, "a"),
    ]);
    const col = Object.fromEntries(rows.map((r) => [r.version.id, r.column]));
    expect([col.b, col.c, col.d]).toEqual([0, 1, 2]);
  });

  it("gives a second root its own column", () => {
    const rows = buildVersionRows([v("a", 1, null), v("b", 2, null)]);
    expect(rows.map((r) => r.column)).toEqual([0, 1]);
  });

  it("returns rows in version_number order regardless of input order", () => {
    const rows = buildVersionRows([v("c", 3, "b"), v("a", 1, null), v("b", 2, "a")]);
    expect(rows.map((r) => r.version.version_number)).toEqual([1, 2, 3]);
  });

  it("treats a version whose parent is not in the input set as a root", () => {
    const rows = buildVersionRows([v("b", 2, "a"), v("c", 3, "b")]);
    // "a" is absent, so b is a root (column 0, null parent); c inherits b's column.
    expect(rows.map((r) => r.column)).toEqual([0, 0]);
    expect(rows[0].parentColumn).toBeNull();
  });
});
