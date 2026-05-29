import type { NodeReview, ReviewDecision } from "@/lib/types";

export type ReviewByNode = Record<string, ReviewDecision>;

export function reviewByNodeMap(reviews: NodeReview[]): ReviewByNode {
  const out: ReviewByNode = {};
  for (const r of reviews) out[r.node_id] = r.status;
  return out;
}

export interface NamedNode {
  id: string;
  name: string;
}

export function bucketNodes(
  nodes: NamedNode[],
  byNode: ReviewByNode
): { approved: NamedNode[]; changesRequested: NamedNode[]; pending: NamedNode[] } {
  const approved: NamedNode[] = [];
  const changesRequested: NamedNode[] = [];
  const pending: NamedNode[] = [];
  for (const n of nodes) {
    const d = byNode[n.id];
    if (d === "approved") approved.push(n);
    else if (d === "changes_requested") changesRequested.push(n);
    else pending.push(n);
  }
  return { approved, changesRequested, pending };
}
