import type { OpKind, SuggestionOp } from "@/lib/types";

/** Pure presentation helpers for suggestion cards: given an op, derive the
 * target object (as a `[[kind:uuid]]` mention string for the mention renderer)
 * and the proposed new value to preview. Kept separate from the React card so
 * the mapping is unit-testable. */

// A tmp/sub ref points at an object being created in the same bundle — there's
// no live id to link, so callers show plain text ("the new step") instead.
export const isTmpRef = (r?: string | null): boolean =>
  !!r && (r.startsWith("tmp:") || r.includes("::sub"));

const nodeMention = (r?: string | null) => (r && !isTmpRef(r) ? `[[node:${r}]]` : null);
const edgeMention = (r?: string | null) => (r && !isTmpRef(r) ? `[[edge:${r}]]` : null);
const laneMention = (r?: string | null) => (r && !isTmpRef(r) ? `[[lane:${r}]]` : null);

/** The object(s) a suggestion acts on, as a mention string for the renderer. The
 * action verb lives in the card's badge, so the target never repeats it. `null`
 * → the op has no clean structural target and the card falls back to the title. */
export function opTarget(op: SuggestionOp): string | null {
  switch (op.kind) {
    case "describe_node":
    case "relabel_node":
    case "move_to_lane":
    case "remove_node":
    case "decompose":
      return nodeMention(op.node_ref);
    case "relabel_edge":
    case "remove_edge":
    case "reroute_edge":
      return edgeMention(op.edge_ref);
    case "add_edge":
      return `${nodeMention(op.from_ref) ?? "the new step"} → ${nodeMention(op.to_ref) ?? "the new step"}`;
    case "rename_lane":
      return laneMention(op.lane_ref);
    case "add_node":
      return op.near_node_ref ? `after ${nodeMention(op.near_node_ref) ?? "the new step"}` : null;
    default:
      return null;
  }
}

/** Ops that rename an existing object — the one attribute they change IS the
 * name the target mention displays, so the card shows a frozen "old → new"
 * transition for them instead of a live mention that collapses after apply. */
const RENAME_KINDS = new Set<OpKind>(["relabel_node", "rename_lane", "relabel_edge"]);

export function isRenameOp(kind: OpKind): boolean {
  return RENAME_KINDS.has(kind);
}

/** The frozen before → after for a rename-family op. `before` is the target's
 * label when proposed (the suggestion's `before_label`), so it stays stable
 * after the change applies; `null` for non-rename ops. An empty/absent before
 * (e.g. a previously unlabeled edge) renders as a "(no label)" placeholder. */
export function renameTransition(
  op: SuggestionOp,
  beforeLabel: string | null | undefined
): { before: string; after: string } | null {
  if (!isRenameOp(op.kind)) return null;
  const after = (op.kind === "rename_lane" ? op.name : op.new_label) ?? "";
  return { before: beforeLabel?.trim() ? beforeLabel : "(no label)", after };
}

/** The proposed new value to preview under the target (the label/description/etc.
 * that Apply would write). `hasMention` marks values carrying a `[[…]]` link so
 * the card renders them through the mention renderer. */
export function opPayload(op: SuggestionOp): { value: string; hasMention: boolean } | null {
  switch (op.kind) {
    case "describe_node":
      return op.description ? { value: op.description, hasMention: false } : null;
    case "relabel_node":
    case "relabel_edge":
    case "add_node":
      return op.new_label ? { value: op.new_label, hasMention: false } : null;
    case "add_lane":
    case "rename_lane":
      return op.name ? { value: op.name, hasMention: false } : null;
    case "move_to_lane": {
      const lane = laneMention(op.lane_ref);
      return lane ? { value: `→ ${lane}`, hasMention: true } : null;
    }
    case "add_edge":
      return op.edge_label ? { value: op.edge_label, hasMention: false } : null;
    default:
      return null;
  }
}
