import type { ChatSuggestResponse } from "@/lib/types";
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
    question: data.question ?? undefined,
  };
}
