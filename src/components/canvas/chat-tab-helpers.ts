import type { AgentQuestion, ChatSuggestResponse } from "@/lib/types";
import type { ChatItem } from "./chat-tab";

/** Build the assistant ChatItem from a chat-suggest response (the fields that
 * live on the message and survive reload). The caller adds context fields. */
export function assistantItemFromResponse(data: ChatSuggestResponse): ChatItem {
  return {
    role: "assistant",
    content: data.message,
    sources: data.mention_sources,
    suggestions: data.suggestions.length ? data.suggestions : undefined,
    suggestionStatus: {},
    groupSummaries: data.group_summaries.length ? data.group_summaries : undefined,
    activityTrace: data.activity_trace ?? [],
    grounded: data.grounded,
    runId: data.run_id ?? null,
    questions: data.questions ?? undefined,
  };
}

export type QuestionAnswers = Record<number, string>;

/** True only when every question has a non-empty trimmed answer. */
export function allAnswered(questions: AgentQuestion[], answers: QuestionAnswers): boolean {
  return questions.length > 0 && questions.every((_, i) => (answers[i] ?? "").trim().length > 0);
}

/** Compose the answered questions into ONE message that restates each question
 * and its answer (the model's ask tool-calls aren't in rebuilt history, so the
 * restatement gives it the context to continue). */
export function composeAnswers(questions: AgentQuestion[], answers: QuestionAnswers): string {
  return questions.map((q, i) => `Q: ${q.prompt}\nA: ${(answers[i] ?? "").trim()}`).join("\n\n");
}
