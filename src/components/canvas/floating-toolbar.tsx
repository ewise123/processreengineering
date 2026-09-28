"use client";

import { Hand } from "lucide-react";
import type { ReactNode } from "react";

import type { Viewport } from "./types";
import type { WheelMode } from "./viewport-math";
import { keysFor, useIsMac } from "./key-labels";

export type CanvasTool = "select" | "pan" | "connect";

export function FloatingToolbar({
  tool,
  onToolChange,
  viewport,
  onZoomIn,
  onZoomOut,
  onFit,
  onShowShortcuts,
  wheelMode,
  onWheelModeChange,
  showIssues,
  onShowIssuesChange,
  reviewMode,
  onReviewModeChange,
  issueCount,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
}: {
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  viewport: Viewport;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** Opens the keyboard-shortcuts panel. */
  onShowShortcuts?: () => void;
  /** What a plain scroll wheel does: pan (trackpad) or zoom (mouse). */
  wheelMode: WheelMode;
  onWheelModeChange: (next: WheelMode) => void;
  showIssues: boolean;
  onShowIssuesChange: (next: boolean) => void;
  reviewMode: boolean;
  onReviewModeChange: (next: boolean) => void;
  issueCount: number;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}) {
  const mac = useIsMac();
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
        <ToolButton onClick={onUndo} disabled={!canUndo} title={`Undo (${keysFor("undo", mac)})`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M9 14l-4-4 4-4M5 10h9a5 5 0 015 5v1" />
          </svg>
        </ToolButton>
        <ToolButton onClick={onRedo} disabled={!canRedo} title={`Redo (${keysFor("redo", mac)})`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M15 14l4-4-4-4M19 10h-9a5 5 0 00-5 5v1" />
          </svg>
        </ToolButton>
      </Group>

      <Group rightDivider>
        <PlainButton
          onClick={onZoomOut}
          title={`Zoom out (${keysFor("zoom-out", mac)})`}
          ariaLabel="Zoom out"
        >
          {/* Drawn, not typed: a text "−"/"+" sits on the font baseline and
              rides below the middle of the button. */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <path d="M2.5 6h7" />
          </svg>
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
        <PlainButton
          onClick={onZoomIn}
          title={`Zoom in (${keysFor("zoom-in", mac)})`}
          ariaLabel="Zoom in"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
            <path d="M2.5 6h7M6 2.5v7" />
          </svg>
        </PlainButton>
        <PlainButton
          onClick={onFit}
          title={`Fit the map on screen (${keysFor("fit", mac)})`}
          style={{ fontSize: 11, padding: "0 8px" }}
        >
          Fit
        </PlainButton>
        <PlainButton
          onClick={() => onWheelModeChange(wheelMode === "mouse" ? "trackpad" : "mouse")}
          title={
            wheelMode === "mouse"
              ? "Scroll wheel zooms (Shift+scroll pans). Click to switch to trackpad scrolling."
              : "Scrolling pans, pinch zooms. Click to switch to mouse-wheel zoom."
          }
          ariaLabel={`Scroll mode: ${wheelMode}`}
          style={{ fontSize: 11, padding: "0 8px", gap: 5 }}
        >
          {wheelMode === "mouse" ? (
            <svg width="12" height="14" viewBox="0 0 12 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <rect x="1" y="1" width="10" height="14" rx="5" />
              <path d="M6 4v3" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="15" height="12" viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <rect x="1" y="1" width="16" height="12" rx="2.5" />
            </svg>
          )}
          {wheelMode === "mouse" ? "Mouse" : "Trackpad"}
        </PlainButton>
        {onShowShortcuts && (
          <PlainButton
            onClick={onShowShortcuts}
            title="Keyboard shortcuts (?)"
            ariaLabel="Keyboard shortcuts"
            style={{ fontSize: 12, fontWeight: 600, padding: "0 9px" }}
          >
            ?
          </PlainButton>
        )}
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
      // Don't take keyboard focus: Tab/Enter should keep acting on the canvas
      // after a toolbar click, not on the button.
      onMouseDown={(e) => e.preventDefault()}
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
  ariaLabel,
  children,
  style,
}: {
  onClick?: () => void;
  title?: string;
  ariaLabel?: string;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      // Don't take keyboard focus: Tab/Enter should keep acting on the canvas
      // after a toolbar click, not on the button.
      onMouseDown={(e) => e.preventDefault()}
      title={title}
      aria-label={ariaLabel}
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
