import type { ObjectRef, UUID } from "@/lib/types";

/** One object currently attached to the chat as grounding context. A canvas
 * multi-selection produces several of these. */
export interface SelectedObject {
  id: UUID;
  kind: "node" | "edge";
  name?: string;
}

export interface ContextChip {
  kind: "node" | "edge";
  id: UUID;
  label: string;
}

/** The selected objects attached to the next chat message as grounding context. */
export function selectionToContextRefs(selected: SelectedObject[]): ObjectRef[] {
  return selected.map((s) => ({ kind: s.kind, id: s.id }));
}

/** Display chips shown in the context tab for every attached object. */
export function selectionChips(
  selected: SelectedObject[],
  labelById: Map<UUID, string>
): ContextChip[] {
  return selected.map((s) => ({
    kind: s.kind,
    id: s.id,
    label:
      s.kind === "node"
        ? labelById.get(s.id) ?? s.name ?? "step"
        : "transition",
  }));
}
