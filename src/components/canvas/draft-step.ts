/**
 * A draft step is a placeholder with a name box: double-click, Tab and the
 * palette open one, and the step is only created when the name is committed.
 * That makes one change-log entry carrying the real name (not "New task"
 * followed by a rename), one undo step, and lets Esc or a stray double-click
 * leave nothing behind. Pure: no React, no DOM.
 */

export type DraftVia = "dblclick" | "tab" | "plus" | "palette-click" | "palette-drop";
export type DraftTrigger = "enter" | "tab" | "blur" | "escape";

export type DraftOutcome = { kind: "create"; name: string } | { kind: "discard" };

/**
 * Decide what committing a draft does.
 * - Esc always discards.
 * - A typed name creates the step (Enter, Tab, or clicking away).
 * - An empty name discards — except for a palette drop, where dragging the
 *   shape onto the map was the deliberate act, so it keeps the shape's
 *   default name instead of vanishing.
 */
export function resolveDraftCommit(args: {
  text: string;
  via: DraftVia;
  trigger: DraftTrigger;
  defaultName: string;
}): DraftOutcome {
  if (args.trigger === "escape") return { kind: "discard" };
  const name = args.text.trim();
  if (name) return { kind: "create", name };
  if (args.via === "palette-drop") return { kind: "create", name: args.defaultName };
  return { kind: "discard" };
}

/** Change-log reason for a step created this way. Creating never prompts. */
export function creationReason(via: DraftVia): string {
  switch (via) {
    case "dblclick":
      return "Added via double-click";
    case "tab":
      return "Added as next step (Tab)";
    case "plus":
      return "Added with the + on a step";
    case "palette-click":
    case "palette-drop":
      return "Added from the shape palette";
  }
}

export const EDGE_REASON_TAB = "Connected as next step (Tab)";
export const EDGE_REASON_PLUS = "Connected with the + on a step";
