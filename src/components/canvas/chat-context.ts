import type { ObjectRef, UUID } from "@/lib/types";

/** Mirrors the SelectedRef shape used by RightPanel/ChatTab. */
export interface SelectedRef {
  id: UUID;
  kind: "node" | "edge";
  name?: string;
  nodeKind?: string;
}

export interface ContextChip {
  kind: "node" | "edge";
  id: UUID;
  label: string;
}

/** Selection attached to the next chat message as grounding context. */
export function selectionToContextRefs(selected: SelectedRef | null): ObjectRef[] {
  if (!selected) return [];
  return [{ kind: selected.kind, id: selected.id }];
}

/** Display chips shown above the composer for the attached selection. */
export function selectionChips(
  selected: SelectedRef | null,
  labelById: Map<UUID, string>
): ContextChip[] {
  if (!selected) return [];
  const label =
    selected.kind === "node"
      ? labelById.get(selected.id) ?? selected.name ?? "step"
      : "transition";
  return [{ kind: selected.kind, id: selected.id, label }];
}
