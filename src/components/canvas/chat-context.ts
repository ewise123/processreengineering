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

/** Display chips shown in the context tab for every attached object. */
export function selectionChips(
  selected: SelectedObject[],
  labelById: Map<UUID, string>
): ContextChip[] {
  return selected
    .filter((s) => s.kind === "node")
    .map((s) => ({ kind: "node" as const, id: s.id, label: labelById.get(s.id) ?? s.name ?? "step" }));
}
