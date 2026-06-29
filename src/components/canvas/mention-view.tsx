"use client";

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";

import type { UUID, ViewerTarget } from "@/lib/types";
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
  onNavigate,
  onOpenSource,
}: {
  text: string;
  labelById: Map<UUID, string>;
  sourceNameByClaim: Map<UUID, string>;
  sourceTargetByClaim: Map<UUID, ViewerTarget>;
  onNavigate: (ref: { kind: "node" | "edge"; id: UUID }) => void;
  onOpenSource: (t: ViewerTarget) => void;
}) {
  const md = mentionsToMarkdown(text, labelById, sourceNameByClaim);
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
          const m = /^poet:\/\/(node|claim)\/(.+)$/.exec(href ?? "");
          if (m && m[1] === "node") {
            const id = m[2];
            return (
              <button
                type="button"
                onClick={() => onNavigate({ kind: "node", id })}
                className="mx-0.5 inline rounded border border-indigo-200 bg-indigo-50 px-1 font-medium text-indigo-700 hover:bg-indigo-100"
                title="Jump to this step"
              >
                {children}
              </button>
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
