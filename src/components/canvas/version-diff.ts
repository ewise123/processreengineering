import type { VersionDiff } from "@/lib/types";

/** Total number of changes across nodes, edges, and lanes. Excludes
 *  unchanged nodes — this is the "how much moved" number for a badge. */
export function diffChangeCount(d: VersionDiff): number {
  return (
    d.nodes.added.length +
    d.nodes.removed.length +
    d.nodes.renamed.length +
    d.nodes.moved.length +
    d.edges.added.length +
    d.edges.removed.length +
    d.lanes.added.length +
    d.lanes.removed.length
  );
}

export function isEmptyDiff(d: VersionDiff): boolean {
  return diffChangeCount(d) === 0;
}
