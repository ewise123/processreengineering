/**
 * Align and distribute for a multi-step selection, the six alignments and
 * two spreads every drawing tool has. Steps never change lane: a vertical
 * alignment across lanes moves each step as far as its own lane allows, so
 * "align tops" of steps in different lanes lines up only those that can.
 * That keeps these commands cosmetic — no reason prompt, no change log.
 *
 * Pure: no React, no DOM. Positions are world units; y is absolute.
 */

export type AlignCommand =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom"
  | "distribute-h"
  | "distribute-v";

export interface AlignItem {
  id: string;
  x: number;
  /** Absolute y (lane top + relativeY). */
  y: number;
  w: number;
  h: number;
  /** Top and height of the item's lane; null when it has no lane. */
  laneY: number | null;
  laneH: number | null;
}

export interface AlignMove {
  id: string;
  x: number;
  relativeY: number;
}

/** How many steps each command needs before it can do anything. */
export function minItemsFor(cmd: AlignCommand): number {
  return cmd === "distribute-h" || cmd === "distribute-v" ? 3 : 2;
}

function relY(item: AlignItem, absY: number): number {
  if (item.laneY === null) return absY;
  const max = Math.max(0, (item.laneH ?? 0) - item.h);
  return Math.max(0, Math.min(max, absY - item.laneY));
}

/** Spread starts so the gaps between neighbours are equal; ends stay put.
 * When the items are wider than the span (they overlap), spread their
 * centres evenly instead, so the result is still ordered and even. */
function spread(
  items: { id: string; start: number; size: number }[]
): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.start + a.size / 2 - (b.start + b.size / 2));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last.start + last.size - first.start;
  const total = sorted.reduce((s, i) => s + i.size, 0);
  const out = new Map<string, number>();
  if (total <= span) {
    const gap = (span - total) / (sorted.length - 1);
    let cursor = first.start;
    for (const i of sorted) {
      out.set(i.id, cursor);
      cursor += i.size + gap;
    }
  } else {
    const c0 = first.start + first.size / 2;
    const c1 = last.start + last.size / 2;
    const step = (c1 - c0) / (sorted.length - 1);
    sorted.forEach((i, k) => out.set(i.id, c0 + step * k - i.size / 2));
  }
  return out;
}

/**
 * New positions for `cmd`, only for the steps that actually move (so a
 * command that changes nothing records nothing). `relativeY` is within the
 * step's own lane.
 */
export function alignItems(items: AlignItem[], cmd: AlignCommand): AlignMove[] {
  if (items.length < minItemsFor(cmd)) return [];
  const left = Math.min(...items.map((i) => i.x));
  const right = Math.max(...items.map((i) => i.x + i.w));
  const top = Math.min(...items.map((i) => i.y));
  const bottom = Math.max(...items.map((i) => i.y + i.h));

  const target = (i: AlignItem): { x: number; y: number } => {
    switch (cmd) {
      case "left":
        return { x: left, y: i.y };
      case "center":
        return { x: (left + right) / 2 - i.w / 2, y: i.y };
      case "right":
        return { x: right - i.w, y: i.y };
      case "top":
        return { x: i.x, y: top };
      case "middle":
        return { x: i.x, y: (top + bottom) / 2 - i.h / 2 };
      case "bottom":
        return { x: i.x, y: bottom - i.h };
      default:
        return { x: i.x, y: i.y };
    }
  };

  let targets: Map<string, { x: number; y: number }>;
  if (cmd === "distribute-h") {
    const xs = spread(items.map((i) => ({ id: i.id, start: i.x, size: i.w })));
    targets = new Map(items.map((i) => [i.id, { x: xs.get(i.id)!, y: i.y }]));
  } else if (cmd === "distribute-v") {
    const ys = spread(items.map((i) => ({ id: i.id, start: i.y, size: i.h })));
    targets = new Map(items.map((i) => [i.id, { x: i.x, y: ys.get(i.id)! }]));
  } else {
    targets = new Map(items.map((i) => [i.id, target(i)]));
  }

  const moves: AlignMove[] = [];
  for (const i of items) {
    const t = targets.get(i.id)!;
    const x = Math.round(t.x * 100) / 100;
    const relativeY = Math.round(relY(i, t.y) * 100) / 100;
    const currRel = i.laneY === null ? i.y : i.y - i.laneY;
    if (Math.abs(x - i.x) > 0.001 || Math.abs(relativeY - currRel) > 0.001) {
      moves.push({ id: i.id, x, relativeY });
    }
  }
  return moves;
}
