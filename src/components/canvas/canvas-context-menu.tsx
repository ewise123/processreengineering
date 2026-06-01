"use client";

import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function CanvasContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening contextmenu event doesn't immediately close it.
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", close);
      document.addEventListener("wheel", close, { passive: true });
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("wheel", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 50,
        minWidth: 160,
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 8,
        padding: 4,
        boxShadow: "0 12px 32px -8px rgba(15,23,42,0.25)",
        fontSize: 13,
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "6px 10px",
            borderRadius: 6,
            border: "none",
            background: "transparent",
            color: item.disabled ? "#cbd5e1" : "#0f172a",
            cursor: item.disabled ? "not-allowed" : "pointer",
          }}
          onMouseEnter={(e) => {
            if (!item.disabled)
              (e.currentTarget as HTMLButtonElement).style.background = "#f1f5f9";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
