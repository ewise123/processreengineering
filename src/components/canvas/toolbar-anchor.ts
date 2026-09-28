/**
 * Where the selection toolbar sits: centred just above the selection, or
 * just below it when there's no room above, and always kept inside the
 * visible canvas (clear of the top bar and any panel over the right edge).
 *
 * Pure: no React, no DOM. Everything is in canvas pixels.
 */

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnchorLimits {
  width: number;
  height: number;
  /** Pixels covered on the right by panels. */
  occludedRight: number;
  /** Pixels reserved at the top (the map's header bar). */
  top: number;
}

const GAP = 12;
const MARGIN = 8;

export function anchorToolbar(
  sel: ScreenRect,
  bar: { w: number; h: number },
  limits: AnchorLimits
): { left: number; top: number; placement: "above" | "below" } {
  const minTop = limits.top + MARGIN;
  const above = sel.y - GAP - bar.h;
  const below = sel.y + sel.h + GAP;
  let top: number;
  let placement: "above" | "below";
  if (above >= minTop) {
    top = above;
    placement = "above";
  } else if (below + bar.h <= limits.height - MARGIN) {
    top = below;
    placement = "below";
  } else {
    // A selection taller than the screen: pin to the top edge.
    top = minTop;
    placement = "above";
  }
  const maxLeft = limits.width - limits.occludedRight - MARGIN - bar.w;
  const centred = sel.x + sel.w / 2 - bar.w / 2;
  const left = Math.max(MARGIN, Math.min(maxLeft, centred));
  return { left, top, placement };
}
