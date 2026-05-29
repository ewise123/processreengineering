import { describe, expect, it } from "vitest";

import { bucketNodes, reviewByNodeMap } from "./review-summary";
import type { NodeReview } from "@/lib/types";

const reviews: NodeReview[] = [
  { node_id: "a", status: "approved", note: null },
  { node_id: "b", status: "changes_requested", note: "fix" },
];
const nodes = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" },
];

describe("reviewByNodeMap", () => {
  it("maps node id to decision", () => {
    expect(reviewByNodeMap(reviews)).toEqual({ a: "approved", b: "changes_requested" });
  });
  it("empty in, empty out", () => {
    expect(reviewByNodeMap([])).toEqual({});
  });
});

describe("bucketNodes", () => {
  it("sorts nodes into approved / changesRequested / pending", () => {
    const r = bucketNodes(nodes, reviewByNodeMap(reviews));
    expect(r.approved.map((n) => n.id)).toEqual(["a"]);
    expect(r.changesRequested.map((n) => n.id)).toEqual(["b"]);
    expect(r.pending.map((n) => n.id)).toEqual(["c"]);
  });
  it("all pending when no reviews", () => {
    const r = bucketNodes(nodes, {});
    expect(r.pending).toHaveLength(3);
    expect(r.approved).toHaveLength(0);
    expect(r.changesRequested).toHaveLength(0);
  });
});
