import { describe, expect, it } from "vitest";
import type { AgentQuestion } from "@/lib/types";
import { allAnswered, composeAnswers } from "./chat-tab-helpers";

const qs: AgentQuestion[] = [
  { prompt: "Which lane?", options: [{ label: "Finance" }] },
  { prompt: "Before or after?", options: [{ label: "After" }] },
];

describe("allAnswered", () => {
  it("false until every question has a non-empty answer", () => {
    expect(allAnswered(qs, { 0: "Finance" })).toBe(false);
    expect(allAnswered(qs, { 0: "Finance", 1: "After" })).toBe(true);
    expect(allAnswered(qs, { 0: "Finance", 1: "  " })).toBe(false);
  });
  it("false for an empty question list", () => {
    expect(allAnswered([], {})).toBe(false);
  });
});

describe("composeAnswers", () => {
  it("restates each question with its answer as one message", () => {
    const msg = composeAnswers(qs, { 0: "Finance", 1: "After N1" });
    expect(msg).toContain("Which lane?");
    expect(msg).toContain("Finance");
    expect(msg).toContain("Before or after?");
    expect(msg).toContain("After N1");
  });
});
