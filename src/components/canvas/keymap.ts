/**
 * Canvas keyboard shortcuts: one table that both the key handler and (later)
 * the `?` shortcuts panel read, so what the panel lists is what the keys do.
 *
 * `resolveShortcut` only maps a key press to an action. Context — typing in
 * a field, whether anything is selected, Space-to-pan — stays with the
 * caller, which knows the canvas state. Pure: no React, no DOM.
 */

export type ShortcutAction =
  | "undo"
  | "redo"
  | "copy"
  | "paste"
  | "select-all"
  | "tool-select"
  | "tool-pan"
  | "tool-connect"
  | "escape"
  | "delete"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "fit"
  | "zoom-selection"
  | "next-step"
  | "rename"
  | "nudge";

export interface KeyInput {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface Shortcut {
  action: ShortcutAction;
  /** How the keys read in the shortcuts panel. "Mod" is Ctrl or ⌘. */
  keys: string;
  label: string;
  group: "Navigate" | "Tools" | "Edit";
}

export const SHORTCUTS: Shortcut[] = [
  { action: "fit", keys: "Shift+1", label: "Fit the map on screen", group: "Navigate" },
  { action: "zoom-selection", keys: "Shift+2", label: "Zoom to selection", group: "Navigate" },
  { action: "zoom-in", keys: "Mod+=", label: "Zoom in", group: "Navigate" },
  { action: "zoom-out", keys: "Mod+−", label: "Zoom out", group: "Navigate" },
  { action: "zoom-reset", keys: "Mod+0", label: "Zoom to 100%", group: "Navigate" },
  { action: "tool-select", keys: "V", label: "Select tool", group: "Tools" },
  { action: "tool-pan", keys: "H", label: "Pan tool (or hold Space)", group: "Tools" },
  { action: "tool-connect", keys: "C", label: "Connect tool", group: "Tools" },
  { action: "escape", keys: "Esc", label: "Back to Select, clear selection", group: "Tools" },
  { action: "next-step", keys: "Tab", label: "Add the next step after the selected one", group: "Edit" },
  { action: "rename", keys: "Enter", label: "Rename the selected step or connector (also F2)", group: "Edit" },
  { action: "nudge", keys: "Arrows", label: "Nudge the selection (Shift: one grid cell)", group: "Edit" },
  { action: "undo", keys: "Mod+Z", label: "Undo", group: "Edit" },
  { action: "redo", keys: "Mod+Shift+Z", label: "Redo", group: "Edit" },
  { action: "copy", keys: "Mod+C", label: "Copy", group: "Edit" },
  { action: "paste", keys: "Mod+V", label: "Paste", group: "Edit" },
  { action: "select-all", keys: "Mod+A", label: "Select all steps", group: "Edit" },
  { action: "delete", keys: "Delete", label: "Delete selection", group: "Edit" },
];

/** Map a key press to a canvas action, or null when it isn't a shortcut. */
export function resolveShortcut(ev: KeyInput): ShortcutAction | null {
  // Option/Alt combinations are text input on a Mac (Option+Z types Ω); don't
  // claim any of them.
  if (ev.altKey) return null;
  const mod = ev.metaKey || ev.ctrlKey;
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;

  if (mod) {
    if (k === "z") return ev.shiftKey ? "redo" : "undo";
    if (k === "y") return "redo";
    if (k === "c") return "copy";
    if (k === "v") return "paste";
    if (k === "a") return "select-all";
    if (k === "=" || k === "+" || ev.code === "NumpadAdd") return "zoom-in";
    if (k === "-" || k === "_" || ev.code === "NumpadSubtract") return "zoom-out";
    if (k === "0" || ev.code === "Digit0" || ev.code === "Numpad0") return "zoom-reset";
    return null;
  }

  // Shift+digit: match on `code`, because `key` is the shifted glyph ("!", "@")
  // and differs across keyboard layouts.
  if (ev.shiftKey && ev.code === "Digit1") return "fit";
  if (ev.shiftKey && ev.code === "Digit2") return "zoom-selection";

  if (k === "v") return "tool-select";
  if (k === "h") return "tool-pan";
  if (k === "c") return "tool-connect";
  if (k === "Escape") return "escape";
  if (k === "Tab" && !ev.shiftKey) return "next-step";
  if ((k === "Enter" && !ev.shiftKey) || k === "F2") return "rename";
  if (k === "Delete" || k === "Backspace") return "delete";
  // Shift only changes the distance; the caller reads it from the event.
  if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") return "nudge";
  return null;
}
