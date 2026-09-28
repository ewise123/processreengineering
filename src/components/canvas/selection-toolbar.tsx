"use client";

import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  Copy,
  PenLine,
  Route,
  Trash2,
} from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { minItemsFor, type AlignCommand } from "./align";
import { CONNECTOR_PALETTE, storedConnectorColor } from "./canvas-theme";
import { keysFor, useIsMac } from "./key-labels";

/**
 * The toolbar that floats over a selection: align, distribute, connector
 * colour, reset routes, move to lane, copy, delete. With only connectors
 * selected (one or several) it shrinks to what applies to connectors:
 * colour, reset route, edit label (for one), delete. Every command is one
 * undo entry. Buttons don't take focus, so the canvas keys (arrows, Delete,
 * Cmd+Z) keep working after a click.
 */
export function SelectionToolbar({
  left,
  top,
  count,
  nodeCount,
  spansLanes,
  resetCount,
  connectorCount,
  connectorColor,
  placement,
  lanes,
  onSize,
  onSetColor,
  onEditLabel,
  onAlign,
  onResetRoutes,
  onMoveToLane,
  onCopy,
  onDelete,
}: {
  left: number;
  top: number;
  /** Everything selected, steps and connectors. */
  count: number;
  /** Steps selected (align and distribute act on these). */
  nodeCount: number;
  /** True when the selected steps sit in more than one lane. */
  spansLanes: boolean;
  /** Bent connectors that Reset routes would straighten. */
  resetCount: number;
  /** Connectors selected (colour acts on these). */
  connectorCount: number;
  /** Their colour: what the button shows (`display`) and what's stored
   * (`stored`, null = default), or "mixed" when they differ. */
  connectorColor: { display: string; stored: string | null } | "mixed" | null;
  /** Which side of the selection the bar sits on; the colour popover opens
   * on the far side so it never covers what you're colouring. */
  placement: "above" | "below";
  lanes: { id: string; name: string }[];
  onSize: (size: { w: number; h: number }) => void;
  onSetColor: (color: string) => void;
  /** Present only when exactly one connector is selected. */
  onEditLabel?: () => void;
  onAlign: (cmd: AlignCommand) => void;
  onResetRoutes: () => void;
  onMoveToLane: (laneId: string) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const mac = useIsMac();
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el) return;
      const report = () => onSize({ w: el.offsetWidth, h: el.offsetHeight });
      report();
      observer.current = new ResizeObserver(report);
      observer.current.observe(el);
    },
    [onSize]
  );

  const [colorOpen, setColorOpen] = useState(false);
  const connectorsOnly = nodeCount === 0;

  const verticalNote = spansLanes ? " — steps stay in their own lanes" : "";
  const align = (cmd: AlignCommand, label: string, icon: ReactNode, note = "") => (
    <BarButton
      key={cmd}
      label={label + note}
      disabled={nodeCount < minItemsFor(cmd)}
      onClick={() => onAlign(cmd)}
    >
      {icon}
    </BarButton>
  );

  return (
    <div
      ref={measure}
      role="toolbar"
      aria-label="Selection"
      onMouseDown={(e) => {
        // Keep focus (and the selection) on the canvas.
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{
        position: "absolute",
        left,
        top,
        zIndex: 31,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "3px 4px",
        background: "rgba(255,255,255,0.97)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "1px solid #e2e8f0",
        borderRadius: 10,
        boxShadow:
          "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontWeight: 600, color: "#334155", padding: "0 6px" }}>
        {connectorsOnly
          ? `${connectorCount} connector${connectorCount === 1 ? "" : "s"}`
          : `${count} selected`}
      </span>
      <Divider />
      {!connectorsOnly && (
        <>
          {align("left", "Align left edges", <AlignStartVertical size={15} />)}
          {align("center", "Align centres", <AlignCenterVertical size={15} />)}
          {align("right", "Align right edges", <AlignEndVertical size={15} />)}
          {align("top", "Align tops", <AlignStartHorizontal size={15} />, verticalNote)}
          {align(
            "middle",
            "Align middles (straightens a row)",
            <AlignCenterHorizontal size={15} />,
            verticalNote
          )}
          {align("bottom", "Align bottoms", <AlignEndHorizontal size={15} />, verticalNote)}
          <Divider />
          {align("distribute-h", "Space evenly across", <AlignHorizontalSpaceBetween size={15} />)}
          {align(
            "distribute-v",
            "Space evenly down",
            <AlignVerticalSpaceBetween size={15} />,
            verticalNote
          )}
          <Divider />
        </>
      )}
      <span style={{ position: "relative", display: "inline-flex" }}>
        <BarButton
          label={
            connectorCount === 0
              ? "Connector colour — no connectors in the selection"
              : `Connector colour (${connectorCount} connector${connectorCount === 1 ? "" : "s"})`
          }
          disabled={connectorCount === 0}
          onClick={() => setColorOpen((o) => !o)}
        >
          <ColorDot color={connectorColor} dim={connectorCount === 0} />
        </BarButton>
        {colorOpen && connectorCount > 0 && (
          <div
            role="group"
            aria-label="Connector colours"
            style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              ...(placement === "above" ? { bottom: "calc(100% + 8px)" } : { top: "calc(100% + 8px)" }),
              display: "flex",
              gap: 6,
              padding: 8,
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 10,
              boxShadow: "0 12px 32px -8px rgba(15,23,42,0.25)",
            }}
          >
            {CONNECTOR_PALETTE.map((p) => {
              const current =
                connectorColor !== "mixed" && connectorColor !== null
                  ? connectorColor.stored
                  : undefined;
              const selected = current !== undefined && storedConnectorColor(p.color) === current;
              return (
                <button
                  key={p.color}
                  type="button"
                  title={p.name}
                  aria-label={`Colour: ${p.name}`}
                  aria-pressed={selected}
                  onClick={() => {
                    onSetColor(p.color);
                    setColorOpen(false);
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 999,
                    background: p.color,
                    border: "2px solid #fff",
                    boxShadow: selected ? `0 0 0 2px ${p.color}` : "0 0 0 1px rgba(15,23,42,0.15)",
                    cursor: "pointer",
                    padding: 0,
                  }}
                />
              );
            })}
          </div>
        )}
      </span>
      <BarButton
        label={
          resetCount > 0
            ? `Reset routes — clear the bends on ${resetCount} connector${resetCount === 1 ? "" : "s"}`
            : "Reset routes — no bent connectors in the selection"
        }
        disabled={resetCount === 0}
        onClick={onResetRoutes}
      >
        <Route size={15} />
      </BarButton>
      {onEditLabel && (
        <BarButton label="Edit label (Enter)" onClick={onEditLabel}>
          <PenLine size={15} />
        </BarButton>
      )}
      {!connectorsOnly && (
        <>
          <select
            aria-label="Move to lane"
            value=""
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              if (e.target.value) onMoveToLane(e.target.value);
              // Hand the keys back to the canvas (arrows would otherwise
              // change the lane picker instead of nudging).
              e.target.blur();
            }}
            style={{
              height: 28,
              borderRadius: 6,
              border: "1px solid #e2e8f0",
              background: "#fff",
              color: "#334155",
              fontSize: 12,
              padding: "0 4px",
              margin: "0 2px",
              maxWidth: 140,
            }}
          >
            <option value="" disabled>
              Move to lane…
            </option>
            {lanes.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <Divider />
          <BarButton label={`Copy (${keysFor("copy", mac)})`} onClick={onCopy}>
            <Copy size={15} />
          </BarButton>
        </>
      )}
      <BarButton label={`Delete (${keysFor("delete", mac)})`} onClick={onDelete} danger>
        <Trash2 size={15} />
      </BarButton>
    </div>
  );
}

/** The colour button's face: the connectors' colour, or a split dot when
 * they differ. */
function ColorDot({
  color,
  dim,
}: {
  color: { display: string; stored: string | null } | "mixed" | null;
  dim: boolean;
}) {
  const background =
    color === "mixed"
      ? `conic-gradient(${CONNECTOR_PALETTE.slice(0, 4)
          .map((p, i) => `${p.color} ${i * 90}deg ${(i + 1) * 90}deg`)
          .join(", ")})`
      : color?.display ?? "#cbd5e1";
  return (
    <span
      aria-hidden
      style={{
        width: 14,
        height: 14,
        borderRadius: 999,
        background,
        opacity: dim ? 0.35 : 1,
        boxShadow: "0 0 0 1.5px #fff, 0 0 0 2.5px rgba(15,23,42,0.18)",
      }}
    />
  );
}

function Divider() {
  return <span aria-hidden style={{ width: 1, height: 18, background: "#e2e8f0", margin: "0 3px" }} />;
}

function BarButton({
  label,
  onClick,
  disabled = false,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="selection-toolbar-button"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: 6,
        border: "none",
        background: "transparent",
        color: disabled ? "#cbd5e1" : danger ? "#dc2626" : "#334155",
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = danger ? "#fef2f2" : "#f1f5f9";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
