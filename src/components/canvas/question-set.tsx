"use client";

import { useState, type ReactNode } from "react";

import type { AgentQuestion } from "@/lib/types";
import { allAnswered, composeAnswers, type QuestionAnswers } from "./chat-tab-helpers";

/** The agent's clarifying question(s), rendered under an assistant message. Each
 * question shows its options plus a text input for a custom answer; answering a
 * question locks it. When every question is answered, a "Send answers" button
 * composes all answers into one message via onSubmit. Once submitted (`answered`)
 * or while a send is in flight (`disabled`), the whole set is read-only. */
export function QuestionSet({
  questions,
  renderText,
  disabled,
  answered,
  onSubmit,
}: {
  questions: AgentQuestion[];
  renderText: (text: string) => ReactNode;
  disabled?: boolean;
  answered?: boolean;
  onSubmit: (composed: string) => void;
}) {
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const locked = (i: number) => answered || disabled || (answers[i] ?? "").trim().length > 0;
  const setAnswer = (i: number, value: string) => {
    const v = value.trim();
    if (!v) return;
    setAnswers((curr) => ({ ...curr, [i]: v }));
  };
  const ready = allAnswered(questions, answers) && !answered && !disabled;

  return (
    <div className="space-y-2">
      {questions.map((q, i) => (
        <div key={i} className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-2">
          <p className="text-[11px] font-medium leading-snug text-slate-800">{renderText(q.prompt)}</p>
          {(answers[i] ?? "").trim() ? (
            <p className="mt-1 text-[11px] text-slate-600">
              <span className="font-semibold text-indigo-700">Answer:</span> {answers[i]}
            </p>
          ) : answered ? (
            <p className="mt-1 text-[11px] italic text-slate-400">Answered</p>
          ) : (
            <div className="mt-1.5 flex flex-col gap-1">
              {q.options.map((o, oi) => (
                <button
                  key={oi}
                  type="button"
                  disabled={locked(i)}
                  onClick={() => setAnswer(i, o.label)}
                  className="rounded border border-indigo-200 bg-white px-2 py-1 text-left text-[11px] font-medium text-indigo-800 hover:bg-indigo-100 disabled:opacity-50"
                >
                  {renderText(o.label)}
                  {o.description ? (
                    <span className="block text-[10px] font-normal text-slate-500">{o.description}</span>
                  ) : null}
                </button>
              ))}
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={drafts[i] ?? ""}
                  disabled={locked(i)}
                  aria-label="Type a custom answer"
                  placeholder="Or type your own answer…"
                  onChange={(e) => setDrafts((curr) => ({ ...curr, [i]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") setAnswer(i, drafts[i] ?? ""); }}
                  className="min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={locked(i) || !(drafts[i] ?? "").trim()}
                  onClick={() => setAnswer(i, drafts[i] ?? "")}
                  className="shrink-0 rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                >
                  Use
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      {ready && (
        <button
          type="button"
          onClick={() => onSubmit(composeAnswers(questions, answers))}
          className="rounded bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-700"
        >
          Send answers
        </button>
      )}
    </div>
  );
}
