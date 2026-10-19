import { describe, it, expect } from "vitest";
import { FOLLOWUP_PROMPT } from "@whistle/runtime";

describe("FOLLOWUP_PROMPT", () => {
  it("opens with a recap and needs, then asks one question at a time", () => {
    expect(FOLLOWUP_PROMPT).toContain("What I understood");
    expect(FOLLOWUP_PROMPT).toContain("What I still need");
    expect(FOLLOWUP_PROMPT).toContain("exactly ONE question per reply");
  });

  it("re-asks unanswered questions instead of moving on", () => {
    expect(FOLLOWUP_PROMPT).toContain("do NOT move on");
    expect(FOLLOWUP_PROMPT).toContain("asked twice");
  });

  it("supports both English and Indonesian", () => {
    expect(FOLLOWUP_PROMPT).toContain("Yang saya pahami");
    expect(FOLLOWUP_PROMPT).toContain("Yang masih saya perlukan");
  });
});
