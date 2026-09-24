import type { ActivityStep } from "@/lib/types";

/** Header label for the "How I found this" disclosure, or "" when there's no trace. */
export function traceHeaderLabel(steps: ActivityStep[] | undefined): string {
  if (!steps || steps.length === 0) return "";
  const n = steps.length;
  return `How I found this · ${n} step${n === 1 ? "" : "s"}`;
}

/** Show the "not grounded in your sources" chip only when the server said grounded === false. */
export function showUngroundedWarning(grounded: boolean | undefined): boolean {
  return grounded === false;
}
