/**
 * Random v4 UUID that also works outside a secure context.
 *
 * `crypto.randomUUID` only exists on HTTPS or localhost pages, so opening the
 * dev server by LAN IP (http://10.x.x.x:3000) leaves it undefined. Fall back
 * to building the same RFC 4122 v4 string from `crypto.getRandomValues`, which
 * browsers expose in every context.
 */
export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
