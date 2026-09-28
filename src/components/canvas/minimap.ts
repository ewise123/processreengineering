/**
 * Minimap geometry: the whole map shrunk into a small box, the part on
 * screen outlined, and clicks in the box turned back into a view.
 *
 * Pure: no React, no DOM. World rects are in world units; `size` is the
 * visible canvas in pixels (panels covering it excluded).
 */

import type { Viewport, WorldRect } from "./viewport-math";

export interface MinimapLayout {
  /** Minimap pixels per world unit. */
  scale: number;
  /** Where world (0,0) lands in the minimap. */
  offX: number;
  offY: number;
  w: number;
  h: number;
}

/** The world rect currently on screen. */
export function viewRect(v: Viewport, size: { w: number; h: number }): WorldRect {
  return { x: -v.tx / v.scale, y: -v.ty / v.scale, w: size.w / v.scale, h: size.h / v.scale };
}

/** Smallest rect covering both. */
export function union(a: WorldRect, b: WorldRect): WorldRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/**
 * Fit `world` into a minimap `width` wide. The height follows the world's
 * shape, within [minH, maxH]; the world is centred in whatever space is left.
 */
export function minimapLayout(
  world: WorldRect,
  width: number,
  minH = 64,
  maxH = 150,
  pad = 6
): MinimapLayout {
  const innerW = width - pad * 2;
  const natural = (world.h / Math.max(1, world.w)) * innerW + pad * 2;
  const h = Math.max(minH, Math.min(maxH, natural));
  const scale = Math.min(innerW / Math.max(1, world.w), (h - pad * 2) / Math.max(1, world.h));
  return {
    scale,
    offX: (width - world.w * scale) / 2 - world.x * scale,
    offY: (h - world.h * scale) / 2 - world.y * scale,
    w: width,
    h,
  };
}

export function toMinimap(l: MinimapLayout, r: WorldRect): WorldRect {
  return { x: r.x * l.scale + l.offX, y: r.y * l.scale + l.offY, w: r.w * l.scale, h: r.h * l.scale };
}

export function fromMinimap(l: MinimapLayout, p: { x: number; y: number }): { x: number; y: number } {
  return { x: (p.x - l.offX) / l.scale, y: (p.y - l.offY) / l.scale };
}

/** Same zoom, panned so `world` is in the middle of the visible canvas. */
export function centreOn(v: Viewport, world: { x: number; y: number }, size: { w: number; h: number }): Viewport {
  return { ...v, tx: size.w / 2 - world.x * v.scale, ty: size.h / 2 - world.y * v.scale };
}
