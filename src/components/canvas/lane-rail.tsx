"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { CanvasLane, Viewport } from "./types";

const HEADER_PX = 44;

type DragState = {
  laneId: string;
  startY: number;
  currentY: number;
  railTop: number;
};

type ResizeState = {
  laneId: string;
  startY: number;
  startH: number;
};

export function LaneRail({
  lanes,
  viewport,
  onMoveLane,
  onResizeLane,
  onRenameLane,
  onAddLaneAt,
  onDeleteLane,
}: {
  lanes: CanvasLane[];
  viewport: Viewport;
  onMoveLane: (laneId: string, targetIndex: number) => void;
  onResizeLane: (laneId: string, newH: number) => void;
  onRenameLane: (laneId: string, newName: string) => void;
  onAddLaneAt: (index: number) => void;
  onDeleteLane: (laneId: string) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);

  const railTop = () => railRef.current?.getBoundingClientRect().top ?? 0;

  // Close popover menu on outside click
  useEffect(() => {
    if (!menuFor) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        !target?.closest?.("[data-lane-menu]") &&
        !target?.closest?.("[data-lane-menu-trigger]")
      ) {
        setMenuFor(null);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuFor]);

  // Reorder drag — onMoveLane is called outside the setState updater to avoid
  // the "setState during another component's render" warning.
  useEffect(() => {
    if (!dragState) return;
    const onMove = (e: MouseEvent) => {
      setDragState((s) => (s ? { ...s, currentY: e.clientY } : s));
    };
    const onUp = (e: MouseEvent) => {
      const worldY =
        (e.clientY - dragState.railTop) / viewport.scale -
        viewport.ty / viewport.scale;
      let targetIdx = lanes.length;
      for (let i = 0; i < lanes.length; i++) {
        const midY = lanes[i].y + lanes[i].h / 2;
        if (worldY < midY) {
          targetIdx = i;
          break;
        }
      }
      setDragState(null);
      onMoveLane(dragState.laneId, targetIdx);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragState, lanes, viewport, onMoveLane]);

  // Resize drag
  useEffect(() => {
    if (!resizeState) return;
    const onMove = (e: MouseEvent) => {
      const dy = (e.clientY - resizeState.startY) / viewport.scale;
      onResizeLane(resizeState.laneId, resizeState.startH + dy);
    };
    const onUp = () => setResizeState(null);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [resizeState, viewport, onResizeLane]);

  const railLeft = viewport.tx;
  const headerW = HEADER_PX * viewport.scale;

  return (
    <div
      ref={railRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 12,
      }}
    >
      {/* Row insert hover buttons (gap above each lane + one after the last) */}
      {[...lanes, null].map((_, i) => {
        const insertY =
          i < lanes.length
            ? viewport.ty + lanes[i].y * viewport.scale
            : viewport.ty +
              (lanes[lanes.length - 1].y + lanes[lanes.length - 1].h) *
                viewport.scale;
        return (
          <div
            key={`ins-${i}`}
            className="group"
            style={{
              position: "absolute",
              left: `${railLeft}px`,
              width: `${headerW + 240}px`,
              top: `${insertY - 8}px`,
              height: "16px",
              pointerEvents: "auto",
            }}
          >
            <button
              onClick={() => onAddLaneAt(i)}
              title={
                i === 0
                  ? "Add lane at top"
                  : i === lanes.length
                    ? "Add lane at bottom"
                    : "Add lane here"
              }
              className="opacity-0 group-hover:opacity-100 transition absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-indigo-500 hover:bg-indigo-600 text-white shadow flex items-center justify-center"
              style={{ zIndex: 2, left: `${headerW / 2 - 10}px` }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <div
              className="opacity-0 group-hover:opacity-100 transition absolute top-1/2 h-[2px] -translate-y-1/2 bg-indigo-300"
              style={{ left: `${headerW}px`, right: 0 }}
            />
          </div>
        );
      })}

      {/* Lane title strips */}
      {lanes.map((lane, i) => {
        const top = viewport.ty + lane.y * viewport.scale;
        const height = lane.h * viewport.scale;
        const isHover = hoverId === lane.id;
        const isEditing = editingId === lane.id;
        const isMenu = menuFor === lane.id;
        const isDragging = dragState?.laneId === lane.id;
        const dy = isDragging ? dragState.currentY - dragState.startY : 0;

        return (
          <div
            key={lane.id}
            onMouseEnter={() => setHoverId(lane.id)}
            onMouseLeave={() => setHoverId(null)}
            style={{
              position: "absolute",
              left: `${railLeft}px`,
              top: `${top + dy}px`,
              width: `${headerW}px`,
              height: `${height}px`,
              pointerEvents: "auto",
              opacity: isDragging ? 0.85 : 1,
              zIndex: isDragging ? 5 : 1,
              boxShadow: isDragging
                ? "0 8px 24px -6px rgba(15,23,42,0.25)"
                : "none",
              background: isDragging ? lane.color : "transparent",
              borderRadius: isDragging ? 4 : 0,
            }}
          >
            {(isHover || isEditing || isMenu) && !isDragging && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(15,23,42,0.04)",
                  borderLeft: "2px solid #0f172a",
                  pointerEvents: "none",
                }}
              />
            )}

            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                // Visible so the rotated label can extend past the 44px rail
                // strip box (rotation maps width→visual height; the parent's
                // narrow horizontal box must not clip).
                overflow: "visible",
              }}
            >
              {isEditing ? (
                <input
                  autoFocus
                  defaultValue={lane.label}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    onRenameLane(lane.id, next || lane.label);
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  style={{
                    transform: "rotate(-90deg)",
                    transformOrigin: "center",
                    width: `${Math.max(120, height - 24)}px`,
                    flexShrink: 0,
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "3px 6px",
                    border: "1px solid #0f172a",
                    borderRadius: 4,
                    background: "#fff",
                    textAlign: "center",
                    outline: "none",
                  }}
                />
              ) : (
                <div
                  onDoubleClick={() => setEditingId(lane.id)}
                  title={lane.label}
                  style={{
                    transform: "rotate(-90deg)",
                    transformOrigin: "center",
                    // flex-shrink:0 prevents the 44px-wide flex parent from
                    // collapsing the label to its own width.
                    flexShrink: 0,
                    fontSize: 10,
                    fontWeight: 600,
                    color: "#475569",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    // Cap = lane SCREEN height minus a small inset. After
                    // rotation, the label's visual extent runs along the
                    // lane axis, so this guarantees it never bleeds into
                    // adjacent lanes regardless of zoom. Resize the lane
                    // taller for longer labels.
                    maxWidth: `${Math.max(40, height - 16)}px`,
                    cursor: "text",
                    userSelect: "none",
                  }}
                >
                  {lane.label}
                </div>
              )}
            </div>

            {(isHover || isMenu) && !isEditing && !isDragging && (
              <div
                style={{
                  position: "absolute",
                  top: 4,
                  left: 2,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <button
                  title="Drag to reorder"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuFor(null);
                    setDragState({
                      laneId: lane.id,
                      startY: e.clientY,
                      currentY: e.clientY,
                      railTop: railTop(),
                    });
                  }}
                  style={{
                    width: 18,
                    height: 18,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 3,
                    background: "rgba(255,255,255,0.95)",
                    border: "1px solid #cbd5e1",
                    cursor: "grab",
                    color: "#475569",
                  }}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <circle cx="9" cy="6" r="1.6" />
                    <circle cx="15" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" />
                    <circle cx="15" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" />
                    <circle cx="15" cy="18" r="1.6" />
                  </svg>
                </button>
                <button
                  data-lane-menu-trigger
                  title="Lane options"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuFor(isMenu ? null : lane.id);
                  }}
                  style={{
                    width: 18,
                    height: 18,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 3,
                    background: isMenu ? "#0f172a" : "rgba(255,255,255,0.95)",
                    border: "1px solid #cbd5e1",
                    color: isMenu ? "#fff" : "#475569",
                    cursor: "pointer",
                  }}
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <circle cx="12" cy="5" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="12" cy="19" r="1.6" />
                  </svg>
                </button>
              </div>
            )}

            {isMenu && (
              <div
                data-lane-menu
                style={{
                  position: "absolute",
                  top: 24,
                  left: `${headerW + 4}px`,
                  background: "#fff",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  boxShadow:
                    "0 8px 24px -6px rgba(15,23,42,0.18), 0 2px 6px -1px rgba(15,23,42,0.08)",
                  padding: 4,
                  minWidth: 180,
                  zIndex: 40,
                }}
              >
                <MenuItem
                  icon="edit"
                  label="Rename lane"
                  onClick={() => {
                    setEditingId(lane.id);
                    setMenuFor(null);
                  }}
                />
                <MenuItem
                  icon="arrow-up"
                  label="Insert lane above"
                  onClick={() => {
                    onAddLaneAt(i);
                    setMenuFor(null);
                  }}
                />
                <MenuItem
                  icon="arrow-down"
                  label="Insert lane below"
                  onClick={() => {
                    onAddLaneAt(i + 1);
                    setMenuFor(null);
                  }}
                />
                <div
                  style={{
                    height: 1,
                    background: "#f1f5f9",
                    margin: "3px 2px",
                  }}
                />
                <MenuItem
                  icon="move-up"
                  label="Move up"
                  disabled={i === 0}
                  onClick={() => {
                    onMoveLane(lane.id, Math.max(0, i - 1));
                    setMenuFor(null);
                  }}
                />
                <MenuItem
                  icon="move-down"
                  label="Move down"
                  disabled={i === lanes.length - 1}
                  onClick={() => {
                    onMoveLane(lane.id, Math.min(lanes.length, i + 2));
                    setMenuFor(null);
                  }}
                />
                <div
                  style={{
                    height: 1,
                    background: "#f1f5f9",
                    margin: "3px 2px",
                  }}
                />
                <MenuItem
                  icon="trash"
                  label="Delete lane"
                  danger
                  disabled={lanes.length <= 1}
                  onClick={() => {
                    onDeleteLane(lane.id);
                    setMenuFor(null);
                  }}
                />
              </div>
            )}

            {!isDragging && (
              <div
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setResizeState({
                    laneId: lane.id,
                    startY: e.clientY,
                    startH: lane.h,
                  });
                }}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: -3,
                  height: 6,
                  cursor: "ns-resize",
                  zIndex: 3,
                }}
              />
            )}
          </div>
        );
      })}

      {dragState &&
        (() => {
          const worldY =
            (dragState.currentY - dragState.railTop) / viewport.scale -
            viewport.ty / viewport.scale;
          let targetIdx = lanes.length;
          for (let i = 0; i < lanes.length; i++) {
            const midY = lanes[i].y + lanes[i].h / 2;
            if (worldY < midY) {
              targetIdx = i;
              break;
            }
          }
          const lastLane = lanes[lanes.length - 1];
          const indY =
            targetIdx < lanes.length
              ? viewport.ty + lanes[targetIdx].y * viewport.scale
              : viewport.ty + (lastLane.y + lastLane.h) * viewport.scale;
          return (
            <div
              style={{
                position: "absolute",
                left: `${railLeft}px`,
                width: `${headerW + 240}px`,
                top: `${indY - 1}px`,
                height: 2,
                background: "#6366f1",
                boxShadow: "0 0 0 2px rgba(99,102,241,0.25)",
                pointerEvents: "none",
                zIndex: 6,
              }}
            />
          );
        })()}
    </div>
  );
}

const ICONS: Record<string, ReactNode> = {
  edit: (
    <path
      d="M4 20h4L20 8l-4-4L4 16v4z M14 6l4 4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "arrow-up": (
    <path
      d="M12 19V5M5 12l7-7 7 7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "arrow-down": (
    <path
      d="M12 5v14M5 12l7 7 7-7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "move-up": (
    <path
      d="M12 15V5M7 10l5-5 5 5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  "move-down": (
    <path
      d="M12 9v10M7 14l5 5 5-5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
};

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: keyof typeof ICONS;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "6px 8px",
        fontSize: 12,
        fontWeight: 500,
        color: disabled ? "#cbd5e1" : danger ? "#dc2626" : "#0f172a",
        background: "transparent",
        border: "none",
        borderRadius: 4,
        cursor: disabled ? "not-allowed" : "pointer",
        textAlign: "left",
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.background = danger ? "#fef2f2" : "#f1f5f9";
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
      >
        {ICONS[icon]}
      </svg>
      {label}
    </button>
  );
}
