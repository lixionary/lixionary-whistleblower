import { afterEach, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { seal } from "@whistle/runtime";
import { startJobs } from "../src/jobs.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function exercise(
  expired: boolean,
  rejected: boolean,
  kind = "otp",
  superseded = false,
  drain = false,
) {
  vi.useFakeTimers();
  const keys = { active: "a", keys: { a: randomBytes(32).toString("base64") } };
  const config = loadConfig({
    NODE_ENV: "test",
    PRIVACY_DATABASE_URL: "unused",
    VAULT_KEYRING: JSON.stringify(keys),
    CAPABILITY_PUBLIC_KEY: "unused",
    SERVICE_EVENT_KEY: "unused",
    PRIVACY_ABUSE_KEY: "unused",
    PRIVACY_EMAIL_PROVIDER: "zoho",
    PRIVACY_EMAIL_FROM: "noreply@example.test",
    ZOHO_API_KEY: randomBytes(16).toString("hex"),
  });
  const id = randomUUID();
  const body = {
    kind: "email",
    challengeId: randomUUID(),
    destination: "synthetic-private@example.test",
    code: "123456",
    expiresAt: Date.now() + (expired ? -1000 : 300000),
    locale: "en",
  };
  let claimed = false,
    sent = false,
    retry = false;
  const db = {
    async execute(query: SQL) {
      const sql = new PgDialect().sqlToQuery(query).sql;
      if (
        sql.startsWith("update delivery_jobs set lease_at") &&
        sql.includes("attempts=attempts+1")
      ) {
        if (claimed) return [];
        claimed = true;
        return [
          {
            id,
            kind,
            body_enc: seal(body, keys, `job:${id}`),
            attempts: 1,
            lease_at: new Date(),
          },
        ];
      }
      if (sql.startsWith("select id from admission_challenges"))
        return superseded ? [] : [{ id: body.challengeId }];
      if (sql.startsWith("update delivery_jobs set sent_at")) sent = true;
      if (sql.includes("error_code='delivery_failed'")) retry = true;
      return [];
    },
  } as unknown as Db;
  (db as unknown as { transaction: unknown }).transaction = async (
    fn: (tx: Db) => Promise<unknown>,
  ) => fn(db);
  let release: (response: Response) => void = () => {};
  const response = new Response(
    rejected ? "provider failure" : '{"data":[{"code":"EM_104"}]}',
    { status: rejected ? 503 : 200 },
  );
  const fetch = vi.fn().mockImplementation(() =>
    drain
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(response),
  );
  vi.stubGlobal("fetch", fetch);
  const log = { error: vi.fn() };
  const stop = startJobs(db, config, log);
  try {
    if (drain) {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      let completed = false;
      const drained = stop().then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      release(response);
      await drained;
      expect(completed).toBe(true);
    }
    await vi.waitFor(() => expect(sent || retry).toBe(true));
    expect(sent).toBe(!rejected || expired || superseded);
    expect(retry).toBe(rejected && !expired && !superseded);
    expect(fetch).toHaveBeenCalledTimes(expired || superseded ? 0 : 1);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(
      body.destination,
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(body.code);
  } finally {
    await stop();
  }
}
it("private worker marks accepted Zoho OTP delivery sent", () =>
  exercise(false, false));
it("private worker retries rejected Zoho delivery without recording secrets", () =>
  exercise(false, true));
it("private worker discards expired OTPs without contacting Zoho", () =>
  exercise(true, false));

it("delivers employee admission OTPs", () =>
  exercise(false, false, "admission_otp"));
it("retries failed admission OTP delivery", () =>
  exercise(false, true, "admission_otp"));
it("discards superseded admission OTPs", () =>
  exercise(false, false, "admission_otp", true));
it("discards expired admission OTPs", () =>
  exercise(true, false, "admission_otp"));

it("drains an active delivery before completing private job shutdown", () =>
  exercise(false, false, "otp", false, true));
