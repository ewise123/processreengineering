/**
 * How tall a collapsed lane is. A collapsed lane's name runs sideways down
 * its header strip, below the expand arrow, so the strip is as tall as the
 * name needs. Pure except for
 * `measureLaneLabel`, which asks the browser how wide the text renders.
 */

/** Where the visible expand arrow ends, from the top of the strip: a 12 px
 * chevron centred in a 16 px button 4 px down, drawn in its middle half. */
export const COLLAPSED_ARROW_BOTTOM = 15;
/** The same gap between the arrow and the name as after the name. */
export const COLLAPSED_GAP = 8;
/** A very long name stops growing the strip here and ends in "…". */
export const COLLAPSED_LANE_MAX = 260;

/** The lane-name font (lane-rail.tsx: 10 px, weight 600). */
const LABEL_FONT_PX = 10;
const LABEL_WEIGHT = 600;

/** Collapsed height (world units, measured at 100% zoom) for a name
 * `labelWidth` pixels long. */
export function collapsedLaneHeight(labelWidth: number): number {
  const need = Math.ceil(labelWidth) + COLLAPSED_ARROW_BOTTOM + COLLAPSED_GAP * 2;
  return Math.min(COLLAPSED_LANE_MAX, need);
}

let ctx: CanvasRenderingContext2D | null | undefined;
let font: string | null = null;
const cache = new Map<string, number>();

/** Rough width when the browser can't measure (tests, server render). */
export function estimateLabelWidth(text: string): number {
  return text.length * 6.2;
}

/** The rendered width of a lane name, in CSS pixels at 100% zoom. */
export function measureLaneLabel(text: string): number {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let width = estimateLabelWidth(text);
  try {
    if (ctx === undefined) ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      font ??= `${LABEL_WEIGHT} ${LABEL_FONT_PX}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.font = font;
      width = ctx.measureText(text).width;
    }
  } catch {
    // No DOM (tests, server render): keep the estimate.
  }
  cache.set(text, width);
  return width;
}
