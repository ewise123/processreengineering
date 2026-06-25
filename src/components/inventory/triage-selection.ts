/** Pure helpers for the multi-select state in the claim triage panel.
 * The selection is a Set<UUID>; every helper returns a NEW set so React
 * state updates stay referentially honest. */

export function toggleSelection(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export function selectAll(ids: string[]): Set<string> {
  return new Set(ids);
}

export function clearSelection(): Set<string> {
  return new Set();
}

export function isSelected(current: Set<string>, id: string): boolean {
  return current.has(id);
}
