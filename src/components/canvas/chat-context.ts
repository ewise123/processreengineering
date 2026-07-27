import type { ObjectRef, UUID } from "@/lib/types";

/** One object currently attached to the chat as grounding context. A canvas
 * multi-selection produces several of these. */
export interface SelectedObject {
  id: UUID;
  kind: "node" | "edge";
  name?: string;
}

export interface ContextChip {
  kind: "node";
  id: UUID;
  label: string;
}

/** The selected objects attached to the next chat message as grounding context. */
export function selectionToContextRefs(selected: SelectedObject[]): ObjectRef[] {
  return selected
    .filter((s) => s.kind === "node")
    .map((s) => ({ kind: "node" as const, id: s.id }));
}

/** Drop attached objects whose id is no longer on the map — e.g. the user
 * selected a node as chat context, then deleted it. Without this, a stale chip
 * lingers in the Context tab and the deleted node would still be sent as
 * grounding context. Returns the same array reference when nothing changed. */
export function pruneMissingContext(
  selected: SelectedObject[],
  existingIds: Set<UUID>
): SelectedObject[] {
  const kept = selected.filter((s) => existingIds.has(s.id));
  return kept.length === selected.length ? selected : kept;
}

/** Display chips shown in the context tab for every attached object. */
export function selectionChips(
  selected: SelectedObject[],
  labelById: Map<UUID, string>
): ContextChip[] {
  return selected
    .filter((s) => s.kind === "node")
    .map((s) => ({ kind: "node" as const, id: s.id, label: labelById.get(s.id) ?? s.name ?? "step" }));
}

/** Everything a send needs from the pending attachment: the refs to put on the
 * request, the chips to record on the sent turn (for its collapsible Context
 * row), and a plain-text fallback note. Context is consumable — this is built
 * from whatever is pending for THIS message only; the caller clears the
 * pending selection right after sending, so nothing here is meant to persist
 * or be reused for a later message. */
export interface SendContext {
  refs: ObjectRef[];
  chips: ContextChip[] | undefined;
  note: string | undefined;
}

/** Build the context_refs (+ display chips/note) for the message about to be
 * sent, from the currently pending attachment. Pure: does not clear anything —
 * the caller clears the pending selection right after using this. */
export function buildSendContext(
  pending: SelectedObject[],
  labelById: Map<UUID, string>
): SendContext {
  const chips = selectionChips(pending, labelById);
  return {
    refs: selectionToContextRefs(pending),
    chips: chips.length ? chips : undefined,
    note: chips.length ? chips.map((c) => c.label).join(", ") : undefined,
  };
}
