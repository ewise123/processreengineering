/**
 * When a change can skip the "why?" box and log a reason on its own. Pure:
 * the canvas passes in what it knows (a working reason, what is being
 * changed, when each thing was made) and shows the box only when this
 * returns null. Every change still reaches the log with a reason.
 */

/** Something the user made counts as fresh for this long. */
export const FRESH_MS = 5 * 60 * 1000;

export type TargetKind = "step" | "connection" | "lane";
export interface ReasonTarget {
  id: string;
  kind: TargetKind;
}

/** One-click reasons offered in the box. */
export const QUICK_REASONS = ["Fixing a mistake", "From interview", "Tidying the map"] as const;

export const SPELLING_REASON = "Fixed spelling";

/** Edit distance where a swap of two neighbouring letters counts as one
 * change (optimal string alignment). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** A rename that only fixes a letter or two: "Reveiw" → "Review". Short
 * names are left out, where two letters can make a different word. */
export function isSpellingFix(before: string, after: string): boolean {
  const a = before.trim();
  const b = after.trim();
  if (a === b || a.length < 4) return false;
  if (words(a) !== words(b)) return false;
  return editDistance(a, b) <= 2;
}

const NOUN: Record<TargetKind, [string, string]> = {
  step: ["step", "steps"],
  connection: ["connection", "connections"],
  lane: ["lane", "lanes"],
};

/** The logged reason for changing things made moments earlier. */
export function freshReason(action: "delete" | "edit", targets: ReasonTarget[]): string {
  const kinds = new Set(targets.map((t) => t.kind));
  const verb = action === "delete" ? "Removed" : "Adjusted";
  if (kinds.size !== 1) return `${verb} items added moments earlier`;
  const [one, many] = NOUN[targets[0].kind];
  return targets.length === 1
    ? `${verb} a ${one} added moments earlier`
    : `${verb} ${targets.length} ${many} added moments earlier`;
}

/**
 * The reason to log without asking, or null to show the box. In order: the
 * working reason the user chose to keep, then "everything touched is fresh",
 * then a spelling-only rename.
 */
export function pickAutoReason({
  working,
  action,
  targets,
  createdAt,
  now,
  rename,
}: {
  working: string | null;
  action: "delete" | "edit";
  targets: ReasonTarget[];
  /** When this tab made each item (ms). Items it didn't make are absent. */
  createdAt: ReadonlyMap<string, number>;
  now: number;
  rename?: { before: string; after: string };
}): string | null {
  if (working) return working;
  if (
    targets.length > 0 &&
    targets.every((t) => {
      const at = createdAt.get(t.id);
      return at !== undefined && now - at < FRESH_MS;
    })
  ) {
    return freshReason(action, targets);
  }
  if (rename && isSpellingFix(rename.before, rename.after)) return SPELLING_REASON;
  return null;
}
