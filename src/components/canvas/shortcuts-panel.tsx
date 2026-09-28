"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";

import { formatKeys, useIsMac } from "./key-labels";
import { SHORTCUTS, type Shortcut } from "./keymap";

/** Things the mouse does that no key table can show. */
const GESTURES: { keys: string; label: string }[] = [
  { keys: "Double-click a lane", label: "Add a step there and name it" },
  { keys: "Click a + on a step", label: "Add a connected step on that side" },
  { keys: "Double-click a step", label: "Rename it" },
  { keys: "Drag an end of a selected arrow", label: "Move it to another step" },
  { keys: "Shift+click", label: "Add to the selection" },
  { keys: "Drag on empty space", label: "Select everything in the box" },
  { keys: "Mod+drag a step", label: "Place it without snapping to guides" },
  { keys: "Space+drag or middle-drag", label: "Pan" },
  { keys: "Wheel", label: "Pan (Trackpad setting) or zoom (Mouse setting)" },
];

const GROUPS: Shortcut["group"][] = ["Edit", "Navigate", "Tools", "Help"];

/**
 * The `?` panel: every canvas shortcut, read from the same table the key
 * handler uses, so the list can't drift from what the keys do.
 */
export function ShortcutsPanel({ onClose }: { onClose: () => void }) {
  const mac = useIsMac();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
      // The map behind is out of reach while this is open: no canvas key
      // (Delete, Cmd+Z, arrows) reaches it. Tab still moves focus.
      if (e.key !== "Tab") e.stopPropagation();
    };
    // Capture on window runs before the canvas's document listener.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const row = (keys: string, label: string) => (
    <div
      key={keys + label}
      style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "4px 0" }}
    >
      <span style={{ color: "#334155" }}>{label}</span>
      <kbd
        style={{
          fontFamily: "inherit",
          fontSize: 11.5,
          color: "#0f172a",
          background: "#f1f5f9",
          border: "1px solid #e2e8f0",
          borderRadius: 5,
          padding: "1px 6px",
          whiteSpace: "nowrap",
        }}
      >
        {formatKeys(keys, mac)}
      </kbd>
    </div>
  );

  return (
    <div
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        background: "rgba(15, 23, 42, 0.18)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        style={{
          width: "min(720px, calc(100% - 32px))",
          maxHeight: "calc(100% - 96px)",
          overflowY: "auto",
          background: "#fff",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          boxShadow: "0 24px 48px -12px rgba(15, 23, 42, 0.25)",
          padding: "16px 20px 20px",
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Keyboard shortcuts</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "#64748b", padding: 4 }}
          >
            <X size={16} />
          </button>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            columnGap: 32,
            rowGap: 12,
            marginTop: 8,
          }}
        >
          {GROUPS.map((g) => (
            <section key={g}>
              <h3 style={sectionHeading}>{g}</h3>
              {SHORTCUTS.filter((s) => s.group === g).map((s) => row(s.keys, s.label))}
            </section>
          ))}
          <section>
            <h3 style={sectionHeading}>Mouse</h3>
            {GESTURES.map((gz) => row(gz.keys, gz.label))}
          </section>
        </div>
      </div>
    </div>
  );
}

const sectionHeading = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase" as const,
  color: "#64748b",
  margin: "8px 0 2px",
};
