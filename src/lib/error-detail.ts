/**
 * Turn a parsed error response body into a readable message.
 *
 * FastAPI returns `detail` as a string for explicit HTTPExceptions, but as an
 * ARRAY of `{loc, msg, type}` validation errors for a 422 — which naïvely
 * stringifies to "[object Object]". This summarizes both shapes so the UI shows
 * the actual problem instead of "[object Object]".
 */
export function formatErrorDetail(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "detail" in data) {
    const detail = (data as { detail: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const parts = detail
        .map((e) => {
          if (e && typeof e === "object") {
            const rawLoc = (e as { loc?: unknown }).loc;
            const loc = Array.isArray(rawLoc)
              ? rawLoc.filter((p) => p !== "body").join(".")
              : "";
            const msg = (e as { msg?: unknown }).msg;
            if (typeof msg === "string") return loc ? `${loc}: ${msg}` : msg;
          }
          return null;
        })
        .filter((p): p is string => !!p);
      if (parts.length) return parts.join("; ");
    }
    if (detail != null && typeof detail !== "string") {
      try {
        return JSON.stringify(detail);
      } catch {
        /* fall through to fallback */
      }
    }
  }
  return fallback;
}
