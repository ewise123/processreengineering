/**
 * The Mouse/Trackpad scroll setting, remembered per browser.
 *
 * Trackpad (default) keeps today's behaviour: two-finger scroll pans, pinch
 * zooms. Mouse makes the wheel zoom, which is what whiteboard users on a
 * Windows mouse expect. It's a per-device preference rather than a per-map
 * one, so it lives in localStorage, not on the server.
 */

import type { WheelMode } from "./viewport-math";

/** Deliberately not "poet."-prefixed: the product is being renamed (#70). */
export const WHEEL_MODE_KEY = "canvas.wheelMode";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WheelModeStore {
  load(): WheelMode;
  save(mode: WheelMode): void;
}

/** Every access is guarded: private browsing and blocked site data make
 * storage throw, and losing the preference must not take the canvas down. */
export function makeWheelModeStore(storage: StorageLike): WheelModeStore {
  return {
    load() {
      try {
        return storage.getItem(WHEEL_MODE_KEY) === "mouse" ? "mouse" : "trackpad";
      } catch {
        return "trackpad";
      }
    },
    save(mode) {
      try {
        storage.setItem(WHEEL_MODE_KEY, mode);
      } catch {
        // Storage unavailable — the choice lasts for this page view only.
      }
    },
  };
}

export function browserWheelModeStore(): WheelModeStore {
  let storage: StorageLike | null = null;
  try {
    if (typeof window !== "undefined") storage = window.localStorage;
  } catch {
    storage = null;
  }
  return makeWheelModeStore(
    storage ?? { getItem: () => null, setItem: () => {} }
  );
}
