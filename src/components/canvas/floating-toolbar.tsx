"use client";

import { Hand } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Viewport } from "./types";

export type CanvasTool = "select" | "pan" | "connect";

export function FloatingToolbar({
  tool,
  onToolChange,
  viewport,
  onZoomIn,
  onZoomOut,
  onFit,
  showIssues,
  onShowIssuesChange,
  reviewMode,
  onReviewModeChange,
  issueCount,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  note,
  onNoteChange,
}: {
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  viewport: Viewport;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  showIssues: boolean;
  onShowIssuesChange: (next: boolean) => void;
  reviewMode: boolean;
  onReviewModeChange: (next: boolean) => void;
  issueCount: number;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  /** The working note stamped on edits made this sitting. See ./working-note. */
  note: string;
  onNoteChange: (next: string) => void;
}) {
  const zoomPct = Math.round(viewport.scale * 100);
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        bottom: 16,
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 2,
        background: "rgba(255,255,255,0.96)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        padding: "3px 4px",
        zIndex: 30,
        boxShadow:
          "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
      }}
    >
      <Group rightDivider>
        <ToolButton
          active={tool === "select"}
          onClick={() => onToolChange("select")}
          title="Select (V)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M5 3l14 9-6 2-2 6z" />
          </svg>
        </ToolButton>
        <ToolButton
          active={tool === "pan"}
          onClick={() => onToolChange("pan")}
          title="Pan (H)"
        >
          <Hand size={14} />
        </ToolButton>
        <ToolButton
          active={tool === "connect"}
          onClick={() => onToolChange("connect")}
          title="Connect (C)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M8 12h8M13 8l4 4-4 4" />
            <circle cx="5" cy="12" r="2" />
          </svg>
        </ToolButton>
      </Group>

      <Group rightDivider>
        <ToolButton onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M9 14l-4-4 4-4M5 10h9a5 5 0 015 5v1" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onRedo} disabled={!canRedo} title="Redo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M15 14l4-4-4-4M19 10h-9a5 5 0 00-5 5v1" />
          </svg>
        </ToolButton>
      </Group>

      <Group rightDivider>
        <PlainButton onClick={onZoomOut} title="Zoom out">
          −
        </PlainButton>
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: "#475569",
            width: 44,
            textAlign: "center",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {zoomPct}%
        </div>
        <PlainButton onClick={onZoomIn} title="Zoom in">
          +
        </PlainButton>
        <PlainButton
          onClick={onFit}
          title="Fit swimlanes to view"
          style={{ fontSize: 11, padding: "0 8px" }}
        >
          Fit
        </PlainButton>
      </Group>

      <Group rightDivider>
        <WorkingNoteButton note={note} onNoteChange={onNoteChange} />
      </Group>

      <Group>
        <ToolButton
          active={showIssues}
          onClick={() => onShowIssuesChange(!showIssues)}
          title="Toggle issue badges"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path d="M12 9v4M12 17h.01" />
            <circle cx="12" cy="12" r="10" />
          </svg>
          <span>Issues</span>
          {issueCount > 0 && (
            <span
              style={{
                marginLeft: 2,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 700,
                background: showIssues ? "#ffffff" : "#ffe4e6",
                color: showIssues ? "#0f172a" : "#be123c",
              }}
            >
              {issueCount}
            </span>
          )}
        </ToolButton>
        <ToolButton
          active={reviewMode}
          onClick={() => onReviewModeChange(!reviewMode)}
          title="Toggle review mode"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path d="M9 11l3 3 8-8M20 12v6a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9" />
          </svg>
          <span>Review</span>
        </ToolButton>
      </Group>
    </div>
  );
}

/**
 * Sets the working note — one sentence covering this sitting, stamped as the
 * reason on every edit made while it is set (see ./working-note). Collapsed to
 * a button because the toolbar is an icon bar; the note itself is a sentence.
 */
function WorkingNoteButton({
  note,
  onNoteChange,
}: {
  note: string;
  onNoteChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = note.trim() !== "";
  return (
    <div style={{ position: "relative", display: "flex" }}>
      <ToolButton
        active={set}
        onClick={() => setOpen((v) => !v)}
        title={
          set
            ? `Edits are being recorded as: ${note.trim()}`
            : "Set a note for this session so edits don't ask one at a time"
        }
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M4 20h4L19 9a2 2 0 00-3-3L5 17z" />
        </svg>
        <span style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {set ? note.trim() : "Session note"}
        </span>
      </ToolButton>

      {open && (
        <div
          // Canvas shortcuts (Delete, Cmd+Z) must not fire while typing here.
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setOpen(false);
          }}
          style={{
            position: "absolute",
            bottom: "calc(100% + 10px)",
            left: "50%",
            transform: "translateX(-50%)",
            width: 340,
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            padding: 12,
            boxShadow: "0 12px 32px -8px rgba(15, 23, 42, 0.25)",
            zIndex: 40,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: "#0f172a", marginBottom: 6 }}>
            What are you working on?
          </div>
          <div style={{ fontSize: 11, color: "#64748b", lineHeight: 1.45, marginBottom: 8 }}>
            Saved as the reason on every edit you make, so the app stops asking
            one change at a time. Deletes still ask.
          </div>
          <textarea
            autoFocus
            aria-label="Session note"
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="e.g. Redraw order-to-cash after the Maria Chen interview"
            rows={2}
            style={{
              width: "100%",
              resize: "vertical",
              fontSize: 12,
              lineHeight: 1.45,
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              color: "#0f172a",
              fontFamily: "inherit",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
            <PlainButton
              onClick={() => onNoteChange("")}
              title="Clear the note and go back to being asked per edit"
              style={{ fontSize: 11, padding: "0 10px", minWidth: 0 }}
            >
              Clear
            </PlainButton>
            <PlainButton
              onClick={() => setOpen(false)}
              style={{ fontSize: 11, padding: "0 10px", minWidth: 0, color: "#0f172a", fontWeight: 600 }}
            >
              Done
            </PlainButton>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({
  children,
  rightDivider,
}: {
  children: ReactNode;
  rightDivider?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        paddingRight: rightDivider ? 8 : 4,
        paddingLeft: 4,
        borderRight: rightDivider ? "1px solid #e2e8f0" : undefined,
      }}
    >
      {children}
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  title,
  disabled,
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        height: 32,
        padding: "0 10px",
        borderRadius: 6,
        background: active ? "#0f172a" : "transparent",
        color: active ? "#ffffff" : "#475569",
        fontSize: 11,
        fontWeight: 500,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.3 : 1,
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        if (disabled || active) return;
        (e.currentTarget as HTMLButtonElement).style.background = "#f1f5f9";
      }}
      onMouseLeave={(e) => {
        if (disabled || active) return;
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

function PlainButton({
  onClick,
  title,
  children,
  style,
}: {
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        height: 32,
        minWidth: 28,
        padding: 0,
        borderRadius: 6,
        background: "transparent",
        color: "#64748b",
        fontSize: 14,
        fontWeight: 500,
        border: "none",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "#f1f5f9";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
