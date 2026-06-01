import { NODE_SIZES, nodeKindFromType } from "./layout";

/** The 8 backend NodeType values, with friendly labels for the Type dropdown.
 * Canonical source: `NodeType` in backend/app/enums.py (the NodeUpdate/NodeCreate
 * allow-list regex is derived from it). Keep this list in sync with that enum. */
export const NODE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "task", label: "Task" },
  { value: "subprocess", label: "Subprocess" },
  { value: "event_start", label: "Start event" },
  { value: "event_end", label: "End event" },
  { value: "event_intermediate", label: "Intermediate event" },
  { value: "gateway_exclusive", label: "Exclusive gateway" },
  { value: "gateway_parallel", label: "Parallel gateway" },
  { value: "gateway_inclusive", label: "Inclusive gateway" },
];

/** Box dimensions for a backend NodeType, resolved via its visual kind. */
export function sizeForNodeType(type: string): { w: number; h: number } {
  return NODE_SIZES[nodeKindFromType(type)];
}
