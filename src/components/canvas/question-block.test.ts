import { describe, expect, it } from "vitest";
import type { AgentQuestion } from "@/lib/types";
import { questionChoices, FREEFORM_CHOICE_LABEL } from "./question-block";

const q: AgentQuestion = {
  prompt: "I don't see a QA step in your sources — add it anyway?",
  options: [
    { label: "Add it anyway", description: "Propose it as not-in-sources" },
    { label: "Skip it" },
  ],
};

describe("questionChoices", () => {
  it("lists every option as a choice whose value is its own label", () => {
    expect(questionChoices(q).slice(0, 2)).toEqual([
      { label: "Add it anyway", value: "Add it anyway", description: "Propose it as not-in-sources" },
      { label: "Skip it", value: "Skip it", description: null },
    ]);
  });
  it("always appends a free-form affordance with an empty value", () => {
    const last = questionChoices(q).at(-1)!;
    expect(last.label).toBe(FREEFORM_CHOICE_LABEL);
    expect(last.value).toBe("");
  });
  it("has the free-form affordance even when there are no options", () => {
    const cs = questionChoices({ prompt: "?", options: [] });
    expect(cs).toHaveLength(1);
    expect(cs[0].value).toBe("");
  });
});
