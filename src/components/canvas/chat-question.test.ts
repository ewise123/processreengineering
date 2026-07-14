import { describe, expect, it } from "vitest";
import type { ChatSuggestResponse } from "@/lib/types";
import { assistantItemFromResponse } from "./chat-tab-helpers";

describe("assistantItemFromResponse", () => {
  it("carries the question when present", () => {
    const data = {
      message: "Not in your sources.", suggestions: [], mention_sources: [],
      group_summaries: [], activity_trace: [], grounded: false,
      question: { prompt: "Add anyway?", options: [{ label: "Yes" }, { label: "No" }] },
    } as unknown as ChatSuggestResponse;
    const item = assistantItemFromResponse(data);
    expect(item.question?.prompt).toBe("Add anyway?");
    expect(item.role).toBe("assistant");
  });

  it("leaves question undefined when absent", () => {
    const data = {
      message: "ok", suggestions: [], mention_sources: [], group_summaries: [],
      activity_trace: [], grounded: true,
    } as unknown as ChatSuggestResponse;
    expect(assistantItemFromResponse(data).question).toBeUndefined();
  });
});
