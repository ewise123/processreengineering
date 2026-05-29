import type { VersionSummary } from "@/lib/types";

export interface TreeRow {
  version: VersionSummary;
  /** 0-based column for this version's dot in the commit-graph rail. */
  column: number;
  /** Column of this version's parent (for drawing the connector); null if root. */
  parentColumn: number | null;
}

/**
 * Assign each version a column for a compact commit-graph rail.
 *
 * Rule: a child reuses its parent's column iff it is the parent's FIRST child
 * (by ascending version_number); later children fork into a fresh column.
 * Roots (no parent, or a parent outside this set) take the next free column.
 * Columns are never recycled — a deep fork history simply uses more columns,
 * which is fine for the narrow side panel and keeps the algorithm simple.
 *
 * Rows are returned in ascending version_number order.
 */
export function buildVersionRows(versions: VersionSummary[]): TreeRow[] {
  const byNum = [...versions].sort(
    (a, b) => a.version_number - b.version_number
  );
  const columnOf = new Map<string, number>();
  const firstChildTaken = new Set<string>();
  let nextFreeColumn = 0;

  const rows: TreeRow[] = [];
  for (const version of byNum) {
    const parentId = version.parent_version_id;
    let column: number;
    let parentColumn: number | null = null;

    if (parentId && columnOf.has(parentId)) {
      parentColumn = columnOf.get(parentId)!;
      if (!firstChildTaken.has(parentId)) {
        firstChildTaken.add(parentId);
        column = parentColumn;
      } else {
        column = nextFreeColumn++;
      }
    } else {
      column = nextFreeColumn++;
    }

    columnOf.set(version.id, column);
    rows.push({ version, column, parentColumn });
  }
  return rows;
}
