import type { ChatSuggestion, OpKind, SuggestionOp } from "@/lib/types";

/** Pure presentation helpers for suggestion cards: given an op, derive the
 * target object (as a `[[kind:uuid]]` mention string for the mention renderer)
 * and the proposed new value to preview. Kept separate from the React card so
 * the mapping is unit-testable. */

// A tmp/sub ref points at an object being created in the same bundle — there's
// no live id to link. It renders as a distinct `[[new:<ref>]]` chip (the planned
// name, resolved from the bundle's producers) instead of a clickable mention.
export const isTmpRef = (r?: string | null): boolean =>
  !!r && (r.startsWith("tmp:") || r.includes("::sub"));

// A structural ref → its mention token: a `[[new:<ref>]]` chip when the ref
// points at an object being created in the same bundle, otherwise a clickable
// `[[kind:uuid]]` mention of the live object. `null` only when the ref is absent.
const refMention = (kind: "node" | "edge" | "lane", r?: string | null): string | null =>
  !r ? null : isTmpRef(r) ? `[[new:${r}]]` : `[[${kind}:${r}]]`;

const nodeMention = (r?: string | null) => refMention("node", r);
const edgeMention = (r?: string | null) => refMention("edge", r);
const laneMention = (r?: string | null) => refMention("lane", r);

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
    case "change_node_type":
      return nodeMention(op.node_ref);
    case "remove_lane":
      return laneMention(op.lane_ref);
    case "set_edge_condition":
      return edgeMention(op.edge_ref);
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
    case "change_node_type":
      return op.node_type ? { value: op.node_type, hasMention: false } : null;
    case "set_edge_condition":
      return op.condition_text ? { value: op.condition_text, hasMention: false } : null;
    default:
      return null;
  }
}

/** The planned name for every object a bundle creates, keyed by the tmp ref the
 * consuming ops use to point at it. Mirrors the tmp-id scheme in
 * `suggestion-apply.ts` (add_node/add_lane → `temp_id`; decompose sub-steps →
 * `<node_ref>::sub<i>`), so a `[[new:<ref>]]` chip can show the real name. */
export function bundleNewNames(suggestions: ChatSuggestion[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const { op } of suggestions) {
    if (op.kind === "add_node" && op.temp_id) {
      names.set(op.temp_id, op.new_label?.trim() || "new step");
    } else if (op.kind === "add_lane" && op.temp_id) {
      names.set(op.temp_id, op.name?.trim() || "new lane");
    } else if (op.kind === "decompose" && op.node_ref) {
      (op.sub_steps ?? []).forEach((s, i) =>
        names.set(`${op.node_ref}::sub${i}`, s.proposed_name?.trim() || "new step")
      );
    }
  }
  return names;
}

/** The suggestion-list header suffix, always showing how many of the bundles
 * have been applied (e.g. "0 of 3 applied", "1 of 3 applied"). */
export function suggestedChangesSuffix(total: number, applied: number): string {
  return `${applied} of ${total} applied`;
}

/** A proposed change is "grounded" when it cites at least one source claim.
 * Ungrounded proposals (general process knowledge, not from the user's sources)
 * get a distinct chip on the card — labeled, never hidden. */
export function isProposalGrounded(s: Pick<ChatSuggestion, "cited_claim_ids">): boolean {
  return (s.cited_claim_ids?.length ?? 0) > 0;
}

export type GroundingChip = { label: string } | null;

/** The grounding chip to show on a proposed change, or null for none.
 * A change that cites a claim is "supported" (deterministic) → no chip. An
 * uncited change is flagged regardless of who initiated it; the copy differs by
 * origin: the agent volunteered it vs the user directly asked for it. */
export function groundingChip(
  s: Pick<ChatSuggestion, "cited_claim_ids" | "origin">,
): GroundingChip {
  if ((s.cited_claim_ids?.length ?? 0) > 0) return null;
  if (s.origin === "ai_volunteered") return { label: "AI suggestion · not in your sources" };
  return { label: "Not in your sources" };
}

/** For a remove_lane op, the lane its steps get reassigned to: the first
 * REMAINING lane by order_index (mirrors the backend's fallback). Returns the
 * target lane id, or null if the op isn't remove_lane or there's no other lane. */
export function laneReassignmentTarget(
  op: SuggestionOp,
  lanes: { id: string; order_index: number }[]
): string | null {
  if (op.kind !== "remove_lane" || !op.lane_ref) return null;
  const others = lanes.filter((l) => l.id !== op.lane_ref).sort((a, b) => a.order_index - b.order_index);
  return others.length ? others[0].id : null;
}
