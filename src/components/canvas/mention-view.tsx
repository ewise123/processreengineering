"use client";

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";

import type { MentionSource, UUID, ViewerTarget } from "@/lib/types";
import { mentionsToMarkdown } from "./mention-markdown";

/**
 * Render text containing `[[kind:uuid]]` mentions as markdown with clickable
 * node/claim links. Shared by the chat prose bubble and the suggestion-card
 * title/rationale so both resolve refs to named, navigable links identically.
 */
export function MentionMarkdown({
  text,
  labelById,
  sourceNameByClaim,
  sourceTargetByClaim,
  sources,
  laneNameById,
  newNameByRef,
  onNavigate,
  onOpenSource,
}: {
  text: string;
  labelById: Map<UUID, string>;
  sourceNameByClaim: Map<UUID, string>;
  sourceTargetByClaim: Map<UUID, ViewerTarget>;
  /** This message's full cited-sources list, so repeat `[[claim:uuid]]`
   * mentions of the same source document collapse to one chip instead of
   * repeating the same document name. Optional — omitting it renders every
   * claim mention as before (no dedupe). */
  sources?: MentionSource[];
  /** Lane id → name, so `[[lane:uuid]]` mentions (e.g. a move-to-lane target)
   * render the lane's name. Optional — chat prose never emits lane mentions. */
  laneNameById?: Map<UUID, string>;
  /** tmp ref → planned name, so a `[[new:<ref>]]` chip (a not-yet-created object
   * a suggestion card references) shows its name. Optional — only cards emit it. */
  newNameByRef?: Map<string, string>;
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  onOpenSource: (t: ViewerTarget) => void;
}) {
  const md = mentionsToMarkdown(text, labelById, sourceNameByClaim, laneNameById, newNameByRef, sources ?? []);
  return (
    <ReactMarkdown
      // Keep poet:// intact (the default transform would strip it) but run every
      // other URL through react-markdown's default sanitizer so we don't
      // reintroduce javascript:/data: link injection.
      urlTransform={(url) => (url.startsWith("poet://") ? url : defaultUrlTransform(url))}
      components={{
        p: ({ children }) => <span className="block">{children}</span>,
        // Assistant text is grounded prose, never remote media — block all images
        // so a model-supplied <img> can't beacon out.
        img: () => null,
        a: ({ href, children }) => {
          const m = /^poet:\/\/(node|claim|edge|lane|new)\/(.+)$/.exec(href ?? "");
          if (m && m[1] === "new") {
            // An object the same bundle creates — no live id to jump to yet, so
            // a non-clickable violet chip carrying a "new" tag + the planned
            // name, visually distinct from the blue existing-object links.
            return (
              <span className="mx-0.5 inline-flex items-center gap-1 rounded border border-violet-300 bg-violet-50 px-1 align-baseline font-medium text-violet-700">
                <span className="rounded-sm bg-violet-200 px-1 text-[8px] font-bold uppercase leading-tight tracking-wide text-violet-800">
                  new
                </span>
                {children}
              </span>
            );
          }
          if (m && (m[1] === "node" || m[1] === "edge")) {
            const kind = m[1];
            const id = m[2];
            return (
              <button
                type="button"
                onClick={() => onNavigate({ kind, id })}
                className="mx-0.5 inline rounded border border-indigo-200 bg-indigo-50 px-1 font-medium text-indigo-700 hover:bg-indigo-100"
                title={kind === "node" ? "Jump to this step" : "Jump to this connection"}
              >
                {children}
              </button>
            );
          }
          if (m && m[1] === "lane") {
            // Lanes have no canvas focus target — render as a non-clickable chip
            // showing the lane name.
            return (
              <span className="mx-0.5 inline rounded border border-slate-200 bg-slate-100 px-1 font-medium text-slate-600">
                {children}
              </span>
            );
          }
          if (m && m[1] === "claim") {
            const id = m[2];
            const tgt = sourceTargetByClaim.get(id);
            return (
              <button
                type="button"
                onClick={() => tgt && onOpenSource(tgt)}
                className="mx-0.5 inline rounded border border-slate-300 bg-white px-1 text-slate-600 hover:bg-slate-100"
                title={tgt ? `Open ${tgt.inputName}` : "Source"}
              >
                {children}
              </button>
            );
          }
          return <span>{children}</span>;
        },
      }}
    >
      {md}
    </ReactMarkdown>
  );
}
