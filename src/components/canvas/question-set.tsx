"use client";

import { useState, type ReactNode } from "react";

import type { AgentQuestion } from "@/lib/types";
import { allAnswered, composeAnswers, type QuestionAnswers } from "./chat-tab-helpers";

/** The agent's clarifying question(s), rendered under an assistant message.
 *
 * A SINGLE question sends the moment you pick an option (or press Enter / hit
 * "Use") — no extra button. MULTIPLE questions page one-at-a-time ("Question 1
 * of N" with ‹ › arrows); every answer stays editable (pick another or retype,
 * navigate back) and nothing sends until "Send answers", which appears once all
 * are answered. On send — or if this set was already answered (`answered`,
 * persisted) or a send is in flight (`disabled`) — the set is read-only. */
export function QuestionSet({
  questions,
  renderText,
  plainText,
  disabled,
  answered,
  onSubmit,
}: {
  questions: AgentQuestion[];
  renderText: (text: string) => ReactNode;
  /** Convert resolved [[kind:uuid]] mentions to plain names for the sent message. */
  plainText?: (text: string) => string;
  disabled?: boolean;
  answered?: boolean;
  onSubmit: (composed: string) => void;
}) {
  const single = questions.length === 1;
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  const [current, setCurrent] = useState(0);
  // Read-only once submitted here, already-answered on this message, or a send
  // is in flight. `sent` locks immediately on click so a submit can't fire twice.
  const readOnly = !!answered || !!disabled || sent;

  const send = (a: QuestionAnswers) => {
    if (readOnly) return;
    setSent(true);
    onSubmit(composeAnswers(questions, a, plainText));
  };
  // Set (or change) one question's answer. A single-question set sends at once.
  const pick = (i: number, value: string) => {
    const v = value.trim();
    if (!v || readOnly) return;
    const next = { ...answers, [i]: v };
    setAnswers(next);
    if (single) send(next);
  };
  const ready = !single && allAnswered(questions, answers) && !readOnly;

  // ---- read-only summary (after send / on reload / while sending) ----
  if (readOnly) {
    return (
      <div className="space-y-2">
        {questions.map((q, i) => {
          const chosen = (answers[i] ?? "").trim();
          return (
            <div key={i} className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-2">
              <p className="text-[11px] font-medium leading-snug text-slate-800">{renderText(q.prompt)}</p>
              <p className="mt-1 text-[11px] text-slate-600">
                {chosen ? (
                  <>
                    <span className="font-semibold text-indigo-700">Answer:</span> {renderText(chosen)}
                  </>
                ) : (
                  <span className="italic text-slate-400">Answered</span>
                )}
              </p>
            </div>
          );
        })}
      </div>
    );
  }

  // ---- the interactive body for one question ----
  const questionBody = (i: number) => {
    const q = questions[i];
    const chosen = (answers[i] ?? "").trim();
    return (
      <>
        <p className="text-[11px] font-medium leading-snug text-slate-800">{renderText(q.prompt)}</p>
        <div className="mt-1.5 flex flex-col gap-1">
          {q.options.map((o, oi) => {
            const isSel = chosen === o.label.trim();
            // The description can carry mention links, so it renders as a SIBLING
            // of the select button (not nested inside it): a link is interactive
            // and must not sit inside a <button> nor bubble up to select.
            return (
              <div
                key={oi}
                className={
                  "rounded border " +
                  (isSel
                    ? "border-indigo-500 bg-indigo-100 ring-1 ring-indigo-400"
                    : "border-indigo-200 bg-white hover:bg-indigo-50")
                }
              >
                <button
                  type="button"
                  aria-pressed={isSel}
                  onClick={() => pick(i, o.label)}
                  className="block w-full rounded px-2 py-1 text-left text-[11px] font-medium text-indigo-800"
                >
                  {renderText(o.label)}
                </button>
                {o.description ? (
                  <div className="px-2 pb-1 text-[10px] font-normal text-slate-500">{renderText(o.description)}</div>
                ) : null}
              </div>
            );
          })}
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={drafts[i] ?? ""}
              aria-label="Type a custom answer"
              placeholder="Or type your own answer…"
              onChange={(e) => setDrafts((curr) => ({ ...curr, [i]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") pick(i, drafts[i] ?? "");
              }}
              className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700"
            />
            <button
              type="button"
              disabled={!(drafts[i] ?? "").trim()}
              onClick={() => pick(i, drafts[i] ?? "")}
              className="shrink-0 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40"
            >
              Use
            </button>
          </div>
          {!single && chosen ? (
            <p className="text-[10px] text-slate-500">Selected — pick another or retype to change.</p>
          ) : null}
        </div>
      </>
    );
  };

  // ---- single question: just the body, sends on pick ----
  if (single) {
    return <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-2">{questionBody(0)}</div>;
  }

  // ---- multiple questions: paged one-at-a-time with a counter + arrows ----
  const answeredCount = questions.filter((_, i) => (answers[i] ?? "").trim().length > 0).length;
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-2">
        <div className="mb-1.5 flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous question"
            disabled={current === 0}
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
            className="rounded border border-indigo-200 bg-white px-1.5 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-100 disabled:opacity-30"
          >
            ‹
          </button>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Question {current + 1} of {questions.length}
          </span>
          <button
            type="button"
            aria-label="Next question"
            disabled={current === questions.length - 1}
            onClick={() => setCurrent((c) => Math.min(questions.length - 1, c + 1))}
            className="rounded border border-indigo-200 bg-white px-1.5 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-100 disabled:opacity-30"
          >
            ›
          </button>
          <span className="ml-auto flex items-center gap-1">
            {questions.map((_, i) => {
              const done = (answers[i] ?? "").trim().length > 0;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`Go to question ${i + 1}${done ? " (answered)" : ""}`}
                  onClick={() => setCurrent(i)}
                  className={
                    "h-2 w-2 rounded-full " +
                    (i === current
                      ? "bg-indigo-600 ring-1 ring-indigo-300"
                      : done
                        ? "bg-indigo-400"
                        : "bg-slate-300")
                  }
                />
              );
            })}
          </span>
        </div>
        {questionBody(current)}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() => send(answers)}
          className="rounded bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          Send answers
        </button>
        <span className="text-[10px] text-slate-500">
          {answeredCount} of {questions.length} answered
        </span>
      </div>
    </div>
  );
}
