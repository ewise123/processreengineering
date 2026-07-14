"use client";

import { useState, type ReactNode } from "react";

import type { AgentQuestion } from "@/lib/types";
import { allAnswered, composeAnswers, type QuestionAnswers } from "./chat-tab-helpers";

/** The agent's clarifying question(s), rendered under an assistant message.
 *
 * A SINGLE question sends the moment you pick an option (or press Enter / hit
 * "Use" on a typed answer) — no extra button. With MULTIPLE questions the
 * answers stay editable (pick a different option or retype to change) and
 * nothing sends until you press "Send answers"; then the whole set locks. Once
 * submitted (`answered`, persisted on the message) or while a send is in flight
 * (`disabled`), the set is read-only. */
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
  const single = questions.length === 1;
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  // Read-only once submitted here, already-answered on this message, or a send
  // is in flight. `sent` locks immediately on click so the button can't fire twice.
  const readOnly = !!answered || !!disabled || sent;

  const send = (a: QuestionAnswers) => {
    if (readOnly) return;
    setSent(true);
    onSubmit(composeAnswers(questions, a));
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

  return (
    <div className="space-y-2">
      {questions.map((q, i) => {
        const chosen = (answers[i] ?? "").trim();
        return (
          <div key={i} className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-2">
            <p className="text-[11px] font-medium leading-snug text-slate-800">{renderText(q.prompt)}</p>
            {readOnly ? (
              <p className="mt-1 text-[11px] text-slate-600">
                {chosen ? (
                  <>
                    <span className="font-semibold text-indigo-700">Answer:</span> {chosen}
                  </>
                ) : (
                  <span className="italic text-slate-400">Answered</span>
                )}
              </p>
            ) : (
              <div className="mt-1.5 flex flex-col gap-1">
                {q.options.map((o, oi) => {
                  const isSel = chosen === o.label.trim();
                  return (
                    <button
                      key={oi}
                      type="button"
                      aria-pressed={isSel}
                      onClick={() => pick(i, o.label)}
                      className={
                        "rounded border px-2 py-1 text-left text-[11px] font-medium " +
                        (isSel
                          ? "border-indigo-500 bg-indigo-100 text-indigo-900 ring-1 ring-indigo-400"
                          : "border-indigo-200 bg-white text-indigo-800 hover:bg-indigo-100")
                      }
                    >
                      {renderText(o.label)}
                      {o.description ? (
                        <span className="block text-[10px] font-normal text-slate-500">
                          {renderText(o.description)}
                        </span>
                      ) : null}
                    </button>
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
                  <p className="text-[10px] text-slate-500">Selected: {chosen} — pick another or retype to change.</p>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
      {ready && (
        <button
          type="button"
          onClick={() => send(answers)}
          className="rounded bg-indigo-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-700"
        >
          Send answers
        </button>
      )}
    </div>
  );
}
