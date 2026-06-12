import { describe, expect, it } from "vitest";

import { reconcileRow } from "./reconcile";
import type { ReconcileSuggestion } from "@/lib/types";

function sug(op: ReconcileSuggestion["op"], payload: Record<string, unknown>): ReconcileSuggestion {
  return {
    id: "s" as never,
    batch_id: "b" as never,
    op,
    payload,
    rationale: "because",
    confidence: 0.7,
    status: "pending",
  };
}

describe("reconcileRow", () => {
  it("describes add_step", () => {
    const row = reconcileRow(sug("add_step", { name: "Verify budget", cited_claim_ids: ["c1", "c2"] }));
    expect(row.title).toBe("Add step: Verify budget");
    expect(row.detail).toContain("2 cited claim");
  });

  it("describes recite_node with add/remove counts", () => {
    const row = reconcileRow(sug("recite_node", { add_claim_ids: ["a"], remove_claim_ids: ["x", "y"] }));
    expect(row.title).toBe("Update citations");
    expect(row.detail).toContain("+1");
    expect(row.detail).toContain("-2");
  });

  it("describes flag_stale_node", () => {
    const row = reconcileRow(sug("flag_stale_node", { vanished_claim_ids: ["a", "b", "c"] }));
    expect(row.title).toBe("Flag evidence stale");
    expect(row.detail).toContain("3");
  });

  it("describes relabel_node", () => {
    const row = reconcileRow(sug("relabel_node", { proposed_name: "Receive PO" }));
    expect(row.title).toBe("Relabel: Receive PO");
  });

  it("falls back gracefully on unknown payload", () => {
    const row = reconcileRow(sug("add_step", {}));
    expect(row.title).toBe("Add step: (unnamed)");
  });
});
