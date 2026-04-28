"use client";

import { useEffect, useRef, useState } from "react";

import type { CanvasLane, Viewport } from "./types";

const HEADER_PX = 44;

export function LaneRail({
  lanes,
  viewport,
  onMoveLane,
  onResizeLane,
}: {
  lanes: CanvasLane[];
  viewport: Viewport;
  onMoveLane: (laneId: string, targetIndex: number) => void;
  onResizeLane: (laneId: string, newH: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    laneId: string;
    startY: number;
    currentY: number;
    railTop: number;
  } | null>(null);
  const [resizeState, setResizeState] = useState<{
    laneId: string;
    startY: number;
    startH: number;
  } | null>(null);

  const railTop = () => railRef.current?.getBoundingClientRect().top ?? 0;

  // Reorder drag — read latest dragState via the closure (effect re-binds on
  // change). Keep onMoveLane OUTSIDE setDragState's updater to avoid the
  // "setState during another component's render" warning.
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
      {lanes.map((lane) => {
        const top = viewport.ty + lane.y * viewport.scale;
        const height = lane.h * viewport.scale;
        const isHover = hoverId === lane.id;
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
            {(isHover || isDragging) && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: isDragging
                    ? "transparent"
                    : "rgba(15,23,42,0.04)",
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
                overflow: "hidden",
              }}
            >
              <div
                title={lane.label}
                style={{
                  transform: "rotate(-90deg)",
                  transformOrigin: "center",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#475569",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  // After rotation, visual width along the lane equals the
                  // label's pre-rotation horizontal extent. Cap it to the
                  // lane's screen height (minus a small inset) so long names
                  // truncate with an ellipsis instead of overflowing.
                  maxWidth: `${Math.max(40, height - 28)}px`,
                  userSelect: "none",
                }}
              >
                {lane.label}
              </div>
            </div>
            {isHover && !isDragging && (
              <button
                title="Drag to reorder"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragState({
                    laneId: lane.id,
                    startY: e.clientY,
                    currentY: e.clientY,
                    railTop: railTop(),
                  });
                }}
                style={{
                  position: "absolute",
                  top: 4,
                  left: 2,
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
              : viewport.ty +
                (lastLane.y + lastLane.h) * viewport.scale;
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
