import { describe, expect, it } from "vitest";

import { groupByBatch } from "./inbox-grouping";
import type { ProcessSuggestion } from "@/lib/types";

function sug(partial: Partial<ProcessSuggestion>): ProcessSuggestion {
  return {
    id: "s",
    batch_id: "b1",
    project_id: "p",
    kind: "process_discovery",
    process_id: null,
    version_id: null,
    op: "create_process",
    payload: {},
    rationale: "",
    confidence: null,
    status: "pending",
    outcome: null,
    created_at: "2026-06-11T00:00:00Z",
    resolved_at: null,
    ...partial,
  };
}

describe("groupByBatch", () => {
  it("groups suggestions by batch_id, newest batch first", () => {
    const groups = groupByBatch([
      sug({ id: "1", batch_id: "old", created_at: "2026-06-10T00:00:00Z" }),
      sug({ id: "2", batch_id: "new", created_at: "2026-06-11T00:00:00Z" }),
      sug({ id: "3", batch_id: "new", created_at: "2026-06-11T00:01:00Z" }),
    ]);
    expect(groups.map((g) => g.batchId)).toEqual(["new", "old"]);
    expect(groups[0].suggestions.map((s) => s.id)).toEqual(["2", "3"]);
  });

  it("counts pending per batch", () => {
    const groups = groupByBatch([
      sug({ id: "1", batch_id: "b", status: "pending" }),
      sug({ id: "2", batch_id: "b", status: "accepted" }),
    ]);
    expect(groups[0].pendingCount).toBe(1);
  });

  it("counts pending per batch independently, not globally", () => {
    const groups = groupByBatch([
      sug({ id: "1", batch_id: "a", status: "pending" }),
      sug({ id: "2", batch_id: "a", status: "pending" }),
      sug({ id: "3", batch_id: "b", status: "accepted" }),
    ]);
    expect(groups.find((g) => g.batchId === "a")!.pendingCount).toBe(2);
    expect(groups.find((g) => g.batchId === "b")!.pendingCount).toBe(0);
  });

  it("returns [] for empty input", () => {
    expect(groupByBatch([])).toEqual([]);
  });
});
