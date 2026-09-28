import { describe, expect, it } from "vitest";
import type { ChangeEvent } from "@/lib/types";
import { describeChange } from "./change-summary";

const names = new Map([
  ["n1", "Review"],
  ["n2", "Approve"],
  ["n3", "File"],
  ["l2", "Finance"],
]);

function ev(p: Partial<ChangeEvent>): ChangeEvent {
  return {
    id: "e",
    created_at: "2026-09-28T12:00:00Z",
    target_type: "node",
    target_id: "n1",
    kind: "relabel",
    reason: "Awaiting reason",
    actor_kind: "user",
    before: null,
    after: null,
    cited_claim_ids: null,
    has_thinking: false,
    reasoning_trace: null,
    source: "manual",
    version_id: null,
    ...p,
  };
}

describe("describeChange", () => {
  it("says what a step edit did", () => {
    expect(describeChange(ev({ before: { name: "File" }, after: { name: "File invoice" } }), names)).toBe(
      "Renamed “File” → “File invoice”"
    );
    expect(describeChange(ev({ kind: "relane", before: { lane_id: "l1" }, after: { lane_id: "l2" } }), names)).toBe(
      "“Review”: moved to lane “Finance”"
    );
    expect(
      describeChange(ev({ kind: "retype", before: { type: "task" }, after: { type: "gateway_exclusive" } }), names)
    ).toBe("“Review”: type task → gateway exclusive");
  });

  it("names deleted things from what the log kept", () => {
    expect(describeChange(ev({ kind: "delete", before: { name: "Pay", type: "task" } }), names)).toBe(
      "Deleted step “Pay”"
    );
    expect(
      describeChange(
        ev({ kind: "delete", target_type: "edge", target_id: "x", before: { source_node_id: "n1", target_node_id: "n2" } }),
        names
      )
    ).toBe("Deleted arrow Review → Approve");
    expect(describeChange(ev({ kind: "delete", target_type: "lane", before: { name: "Legal" } }), names)).toBe(
      "Deleted lane “Legal”"
    );
  });

  it("covers arrows", () => {
    expect(
      describeChange(ev({ target_type: "edge", target_id: "x", before: { label: null }, after: { label: "yes" } }), names)
    ).toBe("Label none → “yes”");
    expect(
      describeChange(
        ev({
          kind: "reconnect",
          target_type: "edge",
          target_id: "x",
          before: { source_node_id: "n1", target_node_id: "n3" },
          after: { source_node_id: "n1", target_node_id: "n2" },
        }),
        names
      )
    ).toBe("Moved arrow to Review → Approve (was Review → File)");
  });

  it("says which change an explanation is for", () => {
    expect(
      describeChange(
        ev({ kind: "explain", reason: "Per Jane", before: { kind: "relabel", before: { name: "File" }, after: { name: "File invoice" } } }),
        names
      )
    ).toBe("Reason given later for: Renamed “File” → “File invoice”");
    expect(describeChange(ev({ kind: "explain", before: null }), names)).toBe("Reason given later");
  });

  it("falls back to the kind for anything else", () => {
    expect(describeChange(ev({ kind: "link_claim", after: { claim_ids: ["c"] } }), names)).toBe("link claim “Review”");
  });
});
