import { useSyncExternalStore } from "react";

import { SHORTCUTS, type ShortcutAction } from "./keymap";

/**
 * How shortcut keys read on screen: ⌘ and ⇧ on a Mac, "Ctrl" and "Shift"
 * everywhere else. Used by the `?` panel and every tooltip that names a key,
 * so they always agree with each other and with the key handler.
 */

/** True for macOS and iOS/iPadOS browsers. */
export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

/** "Mod+Shift+Z" → "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere. */
export function formatKeys(keys: string, mac: boolean): string {
  if (!mac) return keys.replace(/Mod/g, "Ctrl");
  return keys
    .replace(/Mod\+?/g, "⌘")
    .replace(/Shift\+?/g, "⇧")
    .replace(/Alt\+?/g, "⌥");
}

/** The on-screen keys for an action in the shortcut table. */
export function keysFor(action: ShortcutAction, mac: boolean): string {
  const s = SHORTCUTS.find((sc) => sc.action === action);
  return s ? formatKeys(s.keys, mac) : "";
}

const noSubscribe = () => () => {};

/**
 * Whether this browser is on a Mac. The server render (and the first client
 * render) assume not, then React re-renders with the real answer, so there's
 * no hydration mismatch.
 */
export function useIsMac(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => isMacPlatform(navigator.platform),
    () => false
  );
}
