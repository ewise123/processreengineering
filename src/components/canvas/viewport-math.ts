/**
 * Viewport arithmetic for the map canvas: zooming around a point, fitting a
 * rectangle on screen, and turning a wheel event into a zoom or a pan
 * according to the user's Mouse/Trackpad setting. Pure: no React, no DOM.
 *
 * Coordinates: `anchor` and screen sizes are in SVG-element pixels (client
 * position minus the SVG's bounding-rect origin); rectangles are in world units.
 */

export interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}

export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 2.5;

export function clampScale(scale: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

/** Set the scale, keeping the world point under `anchor` where it is. */
export function scaleAt(v: Viewport, scale: number, anchor: { x: number; y: number }): Viewport {
  const next = clampScale(scale);
  const wx = (anchor.x - v.tx) / v.scale;
  const wy = (anchor.y - v.ty) / v.scale;
  return { scale: next, tx: anchor.x - wx * next, ty: anchor.y - wy * next };
}

/** Multiply the scale by `factor` around `anchor`. */
export function zoomAt(v: Viewport, factor: number, anchor: { x: number; y: number }): Viewport {
  return scaleAt(v, v.scale * factor, anchor);
}

/**
 * The viewport that shows `rect` centred in a `size` screen with `pad` pixels
 * of margin, never zooming past `maxScale` (so a single small step doesn't
 * fill the screen).
 */
export function fitRect(
  rect: WorldRect,
  size: { w: number; h: number },
  pad = 48,
  maxScale = 1
): Viewport {
  const usableW = Math.max(1, size.w - pad * 2);
  const usableH = Math.max(1, size.h - pad * 2);
  const scale = clampScale(
    Math.min(maxScale, usableW / Math.max(1, rect.w), usableH / Math.max(1, rect.h))
  );
  return {
    scale,
    tx: size.w / 2 - (rect.x + rect.w / 2) * scale,
    ty: size.h / 2 - (rect.y + rect.h / 2) * scale,
  };
}

/** Width of the lane header strip the content box always includes. */
const HEADER_W = 44;
/** Room kept past the right-most node, so its arrows and labels fit. */
const RIGHT_PAD = 40;
/** Width used for the lanes when a map has no nodes yet. */
const EMPTY_W = 800;

/**
 * The world box worth showing: from the lane headers to the right-most node,
 * and every lane top to bottom. Unlike the fixed world width (at least 1700),
 * this is the map's actual extent, so "fit" frames the work, not empty lanes.
 */
export function contentBounds(
  nodes: { x: number; y: number; w: number; h: number }[],
  lanes: { y: number; h: number }[]
): WorldRect | null {
  if (nodes.length === 0 && lanes.length === 0) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  let maxX = nodes.length ? -Infinity : HEADER_W + EMPTY_W;
  for (const l of lanes) {
    minY = Math.min(minY, l.y);
    maxY = Math.max(maxY, l.y + l.h);
  }
  for (const n of nodes) {
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y + n.h);
    maxX = Math.max(maxX, n.x + n.w + RIGHT_PAD);
  }
  return { x: 0, y: minY, w: Math.max(HEADER_W, maxX), h: maxY - minY };
}

/** Bounding box of a set of rectangles, or null for an empty set. */
export function boundsOf(rects: { x: number; y: number; w: number; h: number }[]): WorldRect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const r = Math.max(...rects.map((r) => r.x + r.w));
  const b = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: r - x, h: b - y };
}

export type WheelMode = "trackpad" | "mouse";

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type WheelAction =
  | { kind: "zoom"; factor: number }
  | { kind: "pan"; dx: number; dy: number };

const LINE_PX = 16;
/** Zoom sensitivity per pixel of wheel delta: one mouse notch (~100px) ≈ 18%. */
const ZOOM_PER_PX = 0.002;

/**
 * What a wheel event should do.
 *
 * - Ctrl/Cmd + wheel, and trackpad pinch (which browsers send as ctrl+wheel),
 *   always zoom.
 * - Trackpad mode (default): a plain wheel pans on both axes — two-finger
 *   scrolling moves the map, as it does today.
 * - Mouse mode: a plain wheel zooms at the cursor, the whiteboard convention;
 *   Shift+wheel pans sideways. Browsers usually turn Shift+wheel into deltaX
 *   with deltaY 0, but some don't, so either axis is accepted.
 */
export function interpretWheel(e: WheelInput, mode: WheelMode, pagePx = 800): WheelAction {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pagePx : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) return { kind: "zoom", factor: Math.exp(-dy * ZOOM_PER_PX) };
  if (mode === "mouse") {
    if (e.shiftKey) return { kind: "pan", dx: dx || dy, dy: 0 };
    return { kind: "zoom", factor: Math.exp(-dy * ZOOM_PER_PX) };
  }
  return { kind: "pan", dx, dy };
}
