"use client";

import { Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import type { PageProps } from "react-pdf";

import "./pdf-worker";
import { api } from "@/lib/api";
import type { UUID, ViewerTarget } from "@/lib/types";
import {
  escapeHtml,
  findQuoteInText,
  isQuoteFragment,
  targetPageFromRef,
} from "@/components/canvas/source-highlight";

type Mode = "loading" | "text" | "pdf";

export function DocumentViewer({
  projectId,
  target,
  expanded,
  onToggleExpanded,
  onClose,
}: {
  projectId: UUID;
  target: ViewerTarget;
  expanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
}) {
  // Mode: text fast-path (.txt/.md, no LibreOffice) vs PDF (everything else).
  const [mode, setMode] = useState<Mode>("loading");
  const [text, setText] = useState("");
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true); // PDF mode: found/scrolled a match
  const scrollRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);
  const fileUrl = api.inputPdfUrl(projectId, target.inputId);

  // Decide the render mode. Probe the text endpoint; 200 → text, else → PDF.
  // (The component is remounted per document via `key`, so `mode` already
  // starts at "loading" on mount — no need to reset it here.)
  useEffect(() => {
    let cancelled = false;
    api
      .getInputText(projectId, target.inputId)
      .then((r) => {
        if (!cancelled) {
          setText(r.text);
          setMode("text");
        }
      })
      .catch(() => {
        if (!cancelled) setMode("pdf");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, target.inputId]);

  // Text mode: locate the quote in the full document text (reliable substring
  // match), highlight the exact original run, and scroll to it.
  const textMatch =
    mode === "text" && target.quote ? findQuoteInText(text, target.quote) : null;

  useEffect(() => {
    if (mode === "text" && markRef.current) {
      markRef.current.scrollIntoView({ block: "center" });
    }
    // Re-run when the citation changes within the same document (the viewer is
    // keyed only by inputId, so switching citations doesn't remount): textMatch
    // moves the <mark>, and we need to scroll to the new position.
  }, [mode, text, target.quote, textMatch?.start, textMatch?.end]);

  // PDF mode: highlight quote fragments per text-layer item.
  // CustomTextRenderer's type isn't re-exported, so derive it from PageProps.
  const textRenderer: NonNullable<PageProps["customTextRenderer"]> | undefined =
    target.quote
      ? ({ str }) =>
          isQuoteFragment(str, target.quote as string)
            ? `<mark class="bg-amber-200 text-inherit" data-sp6-hit="1">${escapeHtml(str)}</mark>`
            : escapeHtml(str)
      : undefined;

  // PDF mode: after pages render, scroll the first highlighted run into view;
  // else fall back to the cited page and flag the approximate state.
  useEffect(() => {
    if (mode !== "pdf" || !numPages) return;
    const id = window.setTimeout(() => {
      const root = scrollRef.current;
      if (!root) return;
      const hit = root.querySelector('[data-sp6-hit="1"]');
      if (hit) {
        hit.scrollIntoView({ block: "center" });
        setPinned(true);
        return;
      }
      setPinned(target.quote === null); // only "unpinned" if we expected a match
      const page = targetPageFromRef(target.sectionRef);
      if (page && page > 1) {
        root
          .querySelector(`[data-page-number="${page}"]`)
          ?.scrollIntoView({ block: "start" });
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [mode, numPages, target]);

  const showUnpinnedNotice =
    !!target.quote &&
    ((mode === "text" && !textMatch) || (mode === "pdf" && !pinned));

  return (
    <div
      className="flex h-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white"
      style={{
        width: expanded ? 720 : 360,
        boxShadow:
          "0 8px 28px -8px rgba(15, 23, 42, 0.18), 0 2px 6px -1px rgba(15, 23, 42, 0.08)",
        transition: "width 150ms ease",
      }}
    >
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-200 px-2">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-700">
          {target.inputName}
        </span>
        <button
          type="button"
          onClick={onToggleExpanded}
          title={expanded ? "Collapse width" : "Expand width"}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-50 hover:text-slate-900"
        >
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close viewer"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-50 hover:text-slate-900"
        >
          <X size={14} />
        </button>
      </div>

      {showUnpinnedNotice && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[10px] text-amber-700">
          Couldn&apos;t pin the exact location — showing the document. Quote:
          <span className="italic"> &ldquo;{target.quote}&rdquo;</span>
        </div>
      )}

      {/* Body */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-slate-100 p-2">
        {mode === "loading" && (
          <div className="p-4 text-[11px] italic text-slate-400">
            Preparing document…
          </div>
        )}

        {mode === "text" && (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-white p-3 font-sans text-[12px] leading-relaxed text-slate-800 shadow-sm">
            {textMatch ? (
              <>
                {text.slice(0, textMatch.start)}
                <mark ref={markRef} className="bg-amber-200 text-inherit">
                  {text.slice(textMatch.start, textMatch.end)}
                </mark>
                {text.slice(textMatch.end)}
              </>
            ) : (
              text
            )}
          </pre>
        )}

        {mode === "pdf" &&
          (error ? (
            <div className="space-y-2 p-3">
              <p className="text-[11px] text-rose-600">
                Couldn&apos;t render this document in its original format.
              </p>
              {target.quote && (
                <p className="rounded-md border border-slate-200 bg-white p-2 text-[11px] italic text-slate-600">
                  &ldquo;{target.quote}&rdquo;
                </p>
              )}
            </div>
          ) : (
            <Document
              file={fileUrl}
              onLoadSuccess={({ numPages }) => setNumPages(numPages)}
              onLoadError={(e) => setError(e.message)}
              loading={
                <div className="p-4 text-[11px] italic text-slate-400">
                  Preparing document…
                </div>
              }
            >
              {Array.from({ length: numPages }, (_, i) => (
                <Page
                  key={i}
                  pageNumber={i + 1}
                  width={expanded ? 690 : 330}
                  customTextRenderer={textRenderer}
                  renderAnnotationLayer={false}
                  className="mb-2 bg-white shadow-sm"
                />
              ))}
            </Document>
          ))}
      </div>
    </div>
  );
}
