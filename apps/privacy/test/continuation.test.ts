import { describe, it, expect } from "vitest";
import {
  createContinuationCode,
  continuationCodeSchema,
  suiteReportSchema,
} from "@whistle/shared";
import { digest, token } from "@whistle/runtime";
import { continuationHash } from "../src/continuation.js";
import type { Config } from "../src/config.js";

describe("friendly continuation credentials", () => {
  it("normalizes short codes while preserving legacy credentials exactly", () => {
    for (const value of ["abcd-efgh", "AbCdEfGh", " abcd efgh "])
      expect(continuationCodeSchema.parse(value)).toBe("ABCD-EFGH");
    const legacy = token();
    expect(continuationCodeSchema.parse(legacy)).toBe(legacy);
    for (const invalid of [
      "",
      "ABCD-EFG",
      "ABCD-EFGH2",
      "0000-1111",
      "ABIO-2345",
    ])
      expect(continuationCodeSchema.safeParse(invalid).success).toBe(false);
  });
  it("generates unambiguous random codes in the displayed 4-4 format", () => {
    const values = Array.from({ length: 100 }, createContinuationCode);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values)
      expect(value).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });
  it("uses a keyed hash for new codes and keeps old stored hashes usable", () => {
    const config = { abuseKey: "synthetic-continuation-test-key" } as Config;
    const hash = continuationHash(config, "ABCD-EFGH");
    expect(continuationHash(config, "abcdefgh")).toBe(hash);
    expect(hash).not.toBe(digest("ABCD-EFGH"));
    expect(
      continuationHash({ ...config, abuseKey: "different-key" }, "ABCD-EFGH"),
    ).not.toBe(hash);
    const legacy = token();
    expect(continuationHash(config, legacy)).toBe(digest(legacy));
  });
  it("accepts the normalized credential for report submission", () => {
    const report = suiteReportSchema.parse({
      title: "Reviewed concern",
      summary: "Reviewed facts to submit to investigators.",
      category: "fraud",
      privacyReviewed: true,
      policyVersion: 1,
      intakeId: crypto.randomUUID(),
      intakeToken: "abcdefgh",
    });
    expect(report.intakeToken).toBe("ABCD-EFGH");
  });
});
