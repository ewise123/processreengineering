import { describe, it, expect } from "vitest";
import { restoreAfterCancel } from "./chat-cancel";

describe("restoreAfterCancel", () => {
  it("restores the prior history and puts the cancelled text back in the draft", () => {
    const prior = [{ role: "user", content: "earlier" }];
    expect(restoreAfterCancel({ priorHistory: prior, text: "draft me" })).toEqual({
      history: prior,
      draft: "draft me",
    });
  });

  it("restores to an empty transcript when there was no prior history", () => {
    expect(restoreAfterCancel({ priorHistory: [], text: "first message" })).toEqual({
      history: [],
      draft: "first message",
    });
  });

  it("returns the prior history by reference (no defensive copy)", () => {
    const prior = [{ role: "assistant", content: "a" }];
    expect(restoreAfterCancel({ priorHistory: prior, text: "x" }).history).toBe(prior);
  });
});
