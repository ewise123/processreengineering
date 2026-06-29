import { describe, it, expect } from "vitest";
import { formatErrorDetail } from "./error-detail";

describe("formatErrorDetail", () => {
  it("returns a string detail as-is", () => {
    expect(formatErrorDetail({ detail: "Process model not found" }, "fb")).toBe(
      "Process model not found"
    );
  });

  it("summarizes a FastAPI 422 detail array into loc: msg (dropping 'body')", () => {
    const data = {
      detail: [
        {
          loc: ["body", "history", 1, "content"],
          msg: "String should have at least 1 character",
          type: "string_too_short",
        },
      ],
    };
    expect(formatErrorDetail(data, "fb")).toBe(
      "history.1.content: String should have at least 1 character"
    );
  });

  it("joins multiple validation errors", () => {
    const data = {
      detail: [
        { loc: ["body", "user_message"], msg: "Field required" },
        { loc: ["body", "mode"], msg: "Input should be 'ask' or 'suggest'" },
      ],
    };
    expect(formatErrorDetail(data, "fb")).toBe(
      "user_message: Field required; mode: Input should be 'ask' or 'suggest'"
    );
  });

  it("falls back when there is no usable detail", () => {
    expect(formatErrorDetail({}, "500 Internal Server Error")).toBe("500 Internal Server Error");
    expect(formatErrorDetail(null, "fb")).toBe("fb");
    expect(formatErrorDetail({ detail: "" }, "fb")).toBe("fb");
  });

  it("stringifies a non-string, non-array detail object", () => {
    expect(formatErrorDetail({ detail: { code: 1 } }, "fb")).toBe('{"code":1}');
  });
});
