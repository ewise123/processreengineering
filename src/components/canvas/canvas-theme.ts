/**
 * Visual tokens for the map canvas: one place for the colours, weights and
 * radii that steps, connectors and lanes share, so a state (selected, rework,
 * AI-proposed) looks the same everywhere it appears.
 */

export const THEME = {
  ink: "#0f172a",
  text: "#0f172a",
  mutedText: "#334155",
  subtleText: "#64748b",

  nodeFill: "#ffffff",
  nodeBorder: "#cbd5e1",
  nodeBorderWidth: 1,
  nodeRadius: 10,
  nodeFontSize: 13,
  eventFontSize: 11.5,

  startStroke: "#16a34a",
  startFill: "#f0fdf4",
  endStroke: "#dc2626",
  endFill: "#fef2f2",
  intermediateStroke: "#64748b",

  selection: "#2563eb",
  selectionHalo: "rgba(37, 99, 235, 0.16)",
  /** Alignment guides while dragging: distinct from selection blue. */
  guide: "#db2777",

  edge: "#0f172a",
  edgeWidth: 2.25,
  edgeHover: "rgba(100, 116, 139, 0.22)",
  edgeSelectedWidth: 2.75,
  /** Glow around a selected connector; the line itself keeps its colour. */
  edgeSelectedHalo: "rgba(37, 99, 235, 0.3)",
  edgeSelectedHaloWidth: 9,
  rework: "#d97706",
  reworkDash: "6 4",
  proposed: "#7c3aed",
  proposedDash: "5 3",

  labelBorder: "#e2e8f0",
  labelText: "#334155",
  conditionFill: "#fffbeb",
  conditionBorder: "#fde68a",
  conditionText: "#b45309",

  laneBodyOpacity: 0.16,
  laneHeaderOpacity: 0.55,
  laneAccentWidth: 3,
  laneDivider: "#e2e8f0",
} as const;

/** Arrowhead marker ids, one per connector colour so the head always matches
 * its line. Defined once in the canvas <defs>. */
export const MARKER = {
  default: "poet-arrow",
  selected: "poet-arrow-selected",
  rework: "poet-arrow-rework",
  proposed: "poet-arrow-proposed",
} as const;

export const NODE_SHADOW_FILTER = "poet-node-shadow";

/** Connector ink colours. Darker than the pastel lane colours so a line
 * reads at every zoom. Black is the default: a connector with no colour
 * stored draws black, and picking Black stores "no colour". */
export const CONNECTOR_PALETTE = [
  { name: "Black", color: "#0f172a" },
  { name: "Slate", color: "#64748b" },
  { name: "Blue", color: "#1d4ed8" },
  { name: "Green", color: "#15803d" },
  { name: "Red", color: "#b91c1c" },
  { name: "Orange", color: "#c2410c" },
  { name: "Purple", color: "#7e22ce" },
  { name: "Teal", color: "#0f766e" },
] as const;

export const DEFAULT_CONNECTOR = CONNECTOR_PALETTE[0].color;

/** What to store for a picked colour: null for the default (Black). */
export function storedConnectorColor(picked: string): string | null {
  return picked.toLowerCase() === DEFAULT_CONNECTOR ? null : picked.toLowerCase();
}

/**
 * A connector's line colour. An AI-proposed connector is always purple until
 * it's accepted; otherwise its own colour wins; a rework loop with none is
 * amber; everything else is black.
 */
export function edgeStroke(
  edge: { color?: string | null; kind?: "flow" | "rework" },
  opts: { proposed?: boolean } = {}
): string {
  if (opts.proposed) return THEME.proposed;
  if (edge.color) return edge.color.toLowerCase();
  if (edge.kind === "rework") return THEME.rework;
  return DEFAULT_CONNECTOR;
}

/** The arrowhead marker drawn in `color` (defined in the canvas <defs>). */
export function markerIdFor(color: string): string {
  return `poet-arrow-c${color.replace("#", "").toLowerCase()}`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/**
 * A strong accent from a lane's (usually pastel) colour, for the thin edge on
 * the lane header. Keeps the hue, pushes saturation up and lightness to a
 * mid tone. Greys stay grey. Unparseable colours fall back to slate.
 */
export function laneAccent(color: string): string {
  const rgb = hexToRgb(color);
  if (!rgb) return "#64748b";
  const [h, s] = rgbToHsl(...rgb);
  // Chroma, not HSL saturation, decides "grey": near-white colours report a
  // high saturation even when they're visibly neutral (#f1f5f9 is ~40%).
  const chroma = (Math.max(...rgb) - Math.min(...rgb)) / 255;
  if (chroma < 0.06) return "hsl(215, 16%, 47%)";
  const sat = Math.round(Math.max(s, 0.65) * 100);
  return `hsl(${Math.round(h)}, ${sat}%, 50%)`;
}
