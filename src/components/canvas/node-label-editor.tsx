"use client";

import { useEffect, useRef, useState } from "react";

import { THEME } from "./canvas-theme";
import type { DraftTrigger } from "./draft-step";
import type { CanvasNodeKind } from "./types";

/**
 * Name box drawn on the canvas, over a step (rename) or a draft placeholder
 * (new step). Tasks edit inside their box; events and gateways edit where
 * their label sits, below or beside the shape.
 *
 * Keys: Enter commits, Tab commits and asks for the next step, Esc cancels.
 * Clicking away commits. Key and mouse events stop here so canvas shortcuts
 * (Delete, Cmd+Z, V/H/C) don't fire while typing.
 */
export function NodeLabelEditor({
  rect,
  kind,
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  rect: { x: number; y: number; w: number; h: number };
  kind: CanvasNodeKind;
  initial: string;
  placeholder?: string;
  onCommit: (text: string, trigger: Exclude<DraftTrigger, "escape">) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  // One edit settles once. Unmounting after Enter/Tab/Esc fires a blur, which
  // must not commit a second time.
  const settled = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const settle = (fn: () => void) => {
    if (settled.current) return;
    settled.current = true;
    fn();
  };

  const isTask = kind !== "start" && kind !== "end" && kind !== "intermediate" && kind !== "gateway";
  const box = isTask
    ? { x: rect.x + 4, y: rect.y + 4, w: rect.w - 8, h: rect.h - 8 }
    : kind === "gateway"
      ? { x: rect.x + rect.w * 0.75 + 4, y: rect.y - 34, w: 180, h: 30 }
      : { x: rect.x + rect.w / 2 - 90, y: rect.y + rect.h + 4, w: 180, h: 30 };

  return (
    <foreignObject x={box.x} y={box.y} width={box.w} height={box.h}>
      <textarea
        ref={ref}
        value={value}
        rows={1}
        aria-label="Step name"
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => settle(() => onCommit(value, "blur"))}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return; // IME candidate selection
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            settle(() => onCommit(value, "enter"));
          } else if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            settle(() => onCommit(value, "tab"));
          } else if (e.key === "Escape") {
            e.preventDefault();
            settle(onCancel);
          }
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          height: "100%",
          resize: "none",
          padding: isTask ? "0 6px" : "5px 6px",
          fontSize: isTask ? THEME.nodeFontSize : THEME.eventFontSize,
          fontWeight: 500,
          lineHeight: 1.3,
          fontFamily: "inherit",
          textAlign: isTask ? "center" : "left",
          color: THEME.text,
          background: "#fff",
          border: `1.5px solid ${THEME.selection}`,
          borderRadius: isTask ? 7 : 6,
          outline: "none",
          boxShadow: `0 0 0 3px ${THEME.selectionHalo}`,
          // Vertically centre a one-line name in the task box.
          paddingTop: isTask ? Math.max(0, (rect.h - 8) / 2 - 10) : undefined,
          overflow: "hidden",
        }}
      />
    </foreignObject>
  );
}
