import { describe, expect, it } from "vitest";
import type { ChatSuggestResponse } from "@/lib/types";
import { assistantItemFromResponse } from "./chat-tab-helpers";

describe("assistantItemFromResponse", () => {
  it("carries the questions when present", () => {
    const data = {
      message: "Not in your sources.", suggestions: [], mention_sources: [],
      group_summaries: [], activity_trace: [], grounded: false,
      questions: [{ prompt: "Add anyway?", options: [{ label: "Yes" }, { label: "No" }] }],
    } as unknown as ChatSuggestResponse;
    const item = assistantItemFromResponse(data);
    expect(item.questions?.[0]?.prompt).toBe("Add anyway?");
    expect(item.role).toBe("assistant");
  });

  it("leaves questions undefined when absent", () => {
    const data = {
      message: "ok", suggestions: [], mention_sources: [], group_summaries: [],
      activity_trace: [], grounded: true,
    } as unknown as ChatSuggestResponse;
    expect(assistantItemFromResponse(data).questions).toBeUndefined();
  });
});
