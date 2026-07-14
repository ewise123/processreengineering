"use client";

import type { AgentQuestion } from "@/lib/types";

export const FREEFORM_CHOICE_LABEL = "Something else — I'll explain";

export type QuestionChoice = { label: string; value: string; description?: string | null };

/** The choices to render for a clarifying question: each option (its value is its
 * own label, which the parent sends as the next message) followed by a free-form
 * affordance (value "" → the parent focuses the composer for a typed reply). Pure
 * and node-testable; the component is a thin render over this. */
export function questionChoices(question: AgentQuestion): QuestionChoice[] {
  return [
    ...question.options.map((o) => ({ label: o.label, value: o.label, description: o.description ?? null })),
    { label: FREEFORM_CHOICE_LABEL, value: "" },
  ];
}

/** The agent's clarifying question, rendered under an assistant message. Clicking
 * a choice calls `onChoose(value)`: an option's label (sent as the next message)
 * or "" for the free-form affordance (parent focuses the composer). The normal
 * chat input is always available too, so a free-form reply is always possible. */
export function QuestionBlock({
  question,
  onChoose,
  disabled,
}: {
  question: AgentQuestion;
  onChoose: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-2.5 py-2">
      <p className="text-[11px] font-medium leading-snug text-slate-800">{question.prompt}</p>
      <div className="mt-1.5 flex flex-col gap-1">
        {questionChoices(question).map((c, i) => (
          <button
            key={`${i}-${c.label}`}
            type="button"
            disabled={disabled}
            onClick={() => onChoose(c.value)}
            className={
              c.value
                ? "rounded border border-indigo-200 bg-white px-2 py-1 text-left text-[11px] font-medium text-indigo-800 hover:bg-indigo-100 disabled:opacity-50"
                : "rounded px-2 py-1 text-left text-[11px] text-slate-500 hover:text-slate-700 disabled:opacity-50"
            }
          >
            {c.label}
            {c.description ? (
              <span className="block text-[10px] font-normal text-slate-500">{c.description}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
