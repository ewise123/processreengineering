import type { SuggestionOp } from "@/lib/types";

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
