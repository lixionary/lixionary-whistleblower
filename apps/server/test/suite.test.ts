import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { generate } from "otplib";
import {
  postgresLimiter,
  importRateLimits,
  hashSecret,
  seal,
  unseal,
  mac,
  digest,
  capability,
  token,
  generateCrockford,
  verifyCapability,
} from "@whistle/runtime";
import { defaultSettings } from "@whistle/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, rows } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp as buildPrivacy } from "../../privacy/src/app.js";
import { loadConfig as privacyConfig } from "../../privacy/src/config.js";
import { runMigrations as migratePrivacy } from "../../privacy/src/db/migrate.js";
import { createDb as privateDb } from "../../privacy/src/db/client.js";
import { expire } from "../src/jobs.js";
import { expire as expirePrivate } from "../../privacy/src/jobs.js";
import type { FastifyInstance, InjectOptions } from "fastify";
const password = "A test-only long password";
const origin = "http://localhost:9551";
let app: FastifyInstance,
  privacy: FastifyInstance,
  caseStore: ReturnType<typeof createDb>,
  vault: ReturnType<typeof privateDb>,
  suiteUrl: string,
  privateUrl: string;
const kp = generateKeyPairSync("ed25519"),
  ring = { active: "a", keys: { a: randomBytes(32).toString("base64") } },
  vaultRing = { active: "v", keys: { v: randomBytes(32).toString("base64") } },
  shared = randomBytes(32).toString("hex");
const counts = new Map<string, number>();
const limiter = {
  async hit(key: string, max: number) {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n <= max;
  },
};
const ids = {
  admin: randomUUID(),
  manager: randomUUID(),
  manager2: randomUUID(),
  analyst: randomUUID(),
  outsider: randomUUID(),
  restricted: randomUUID(),
  restricted2: randomUUID(),
  standard: randomUUID(),
  independent: randomUUID(),
};
const cookies: Record<string, string> = {};
let receipt: {
    caseCode: string;
    pin: string;
    recoveryCode: string;
    capability: string;
  },
  caseId: string,
  reporterCookie: string;
const reportAdmissions = new Map<string, string>();
async function admission(path: string, body: unknown, reportToken?: string) {
  return privacy.inject({
    url: "/privacy/admission/" + path,
    method: "POST",
    payload: body as InjectOptions["payload"],
    headers: {
      origin,
      "x-csrf": "1",
      ...(reportToken ? { "x-report-access": reportToken } : {}),
    },
  });
}
async function admissionCode(challengeId: string) {
  const jobs = await rows(
    vault.db,
    sql`select id,body_enc from delivery_jobs where kind='admission_otp' order by created_at desc`,
  );
  const job = jobs
    .map((j) =>
      unseal<Record<string, unknown>>(
        String(j.body_enc),
        vaultRing,
        "job:" + j.id,
      ),
    )
    .find((j) => j.challengeId === challengeId);
  return String(job!.code);
}
async function verifiedAccess() {
  const id = randomUUID(),
    email = `reporter-${id}@example.test`;
  const c = await admission("challenge", { email });
  expect(c.statusCode).toBe(200);
  const v = await admission("verify", {
    challengeId: c.json().challengeId,
    code: await admissionCode(c.json().challengeId),
  });
  expect(v.statusCode).toBe(200);
  return { reportToken: v.json().reportToken as string, id, email };
}
async function call(
  path: string,
  body?: unknown,
  cookie?: string,
  method?: string,
) {
  let reportToken: string | undefined;
  if (path === "/api/reporter/reports" && body && typeof body === "object") {
    const payload = body as {
      submission?: {
        pin: string;
        recoveryCode: string;
        submissionToken: string;
      };
    };
    payload.submission ??= {
      pin: generateCrockford(2, 4),
      recoveryCode: generateCrockford(4, 4),
      submissionToken: token(),
    };
    reportToken = reportAdmissions.get(payload.submission.submissionToken);
    if (!reportToken) {
      reportToken = (await verifiedAccess()).reportToken;
      reportAdmissions.set(payload.submission.submissionToken, reportToken);
    }
  }
  return app.inject({
    url: path,
    method: (method ??
      (body === undefined ? "GET" : "POST")) as InjectOptions["method"],
    payload: body as InjectOptions["payload"],
    headers: {
      origin,
      "x-csrf": "1",
      ...(cookie ? { cookie } : {}),
      ...(reportToken ? { "x-report-access": reportToken } : {}),
    },
  });
}
function cookie(r: { headers: Record<string, unknown> }) {
  return String(r.headers["set-cookie"]).split(";")[0]!;
}
async function privateCall(
  path: string,
  body?: unknown,
  method?: string,
  cap?: string,
) {
  const bearer =
    cap ??
    (await call("/api/reporter/capability", {}, reporterCookie)).json()
      .capability;
  return privacy.inject({
    url: `/privacy/reporter${path}`,
    method: (method ??
      (body === undefined ? "GET" : "POST")) as InjectOptions["method"],
    payload: body as InjectOptions["payload"],
    headers: { origin, "x-csrf": "1", authorization: `Bearer ${bearer}` },
  });
}
async function withConversation(
  run: (f: {
    cookie: string;
    caseId: string;
    receipt: any;
    content: any;
    requests: any[];
    provider: { fail: boolean; pause: boolean; release?: () => void };
    request: (
      path: string,
      body?: unknown,
      method?: string,
      cap?: string,
    ) => Promise<{ statusCode: number; json: () => any; body: string }>;
    start: (
      consent?: boolean,
    ) => Promise<{ statusCode: number; json: () => any; body: string }>;
  }) => Promise<void>,
) {
  counts.clear();
  const bridge = globalThis.fetch;
  const aiApp = await buildPrivacy({
    db: vault.db,
    config: {
      ...privacy.privacyDeps.config,
      ai: { ...privacy.privacyDeps.config.ai, apiKey: "synthetic-fixture-key" },
    },
    limiter,
  });
  const [before] = await rows(
    caseStore.db,
    sql`select body,version from settings where id=1`,
  );
  await rows(
    caseStore.db,
    sql`update settings set body=jsonb_set(body,'{aiEnabled}','true'::jsonb) where id=1`,
  );
  const requests: any[] = [],
    provider: { fail: boolean; pause: boolean; release?: () => void } = {
      fail: false,
      pause: false,
    };
  vi.stubGlobal("fetch", async (url: string, opts: RequestInit) => {
    if (String(url).includes("api.minimax.io")) {
      const input = JSON.parse(String(opts.body));
      requests.push(input);
      if (provider.pause)
        await new Promise<void>((resolve) => {
          provider.release = resolve;
        });
      if (provider.fail)
        return new Response("synthetic upstream failure", { status: 503 });
      const content =
        input.max_tokens === 4096
          ? JSON.stringify({
              summary: "Reviewed structured follow-up",
              details: {
                why: "Unknown",
                how: "Invoice processing",
                where: "Warehouse A",
              },
            })
          : "Confirm the submitted details. Is there anything to correct?";
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200 },
      );
    }
    return bridge(url, opts);
  });
  try {
    const content = {
      title: "Form-first synthetic concern",
      summary:
        "A procurement concern submitted before any assistant processing.",
      category: "fraud",
      details: {
        where: "Warehouse A",
        why: "Unknown",
        how: "Invoice processing",
      },
      privacyReviewed: true,
      policyVersion: 1,
      aiConsent: true,
    };
    const submission = await call("/api/reporter/reports", content);
    expect(submission.statusCode).toBe(201);
    const f = {
      cookie: cookie(submission),
      caseId: (
        await call("/api/reporter/case", undefined, cookie(submission))
      ).json().id as string,
      receipt: submission.json(),
      content,
      requests,
      provider,
      request: async (
        path: string,
        body?: unknown,
        method?: string,
        cap?: string,
      ) => {
        const bearer =
          cap ??
          (await call("/api/reporter/capability", {}, f.cookie)).json()
            .capability;
        return aiApp.inject({
          url: "/privacy/reporter/conversation" + path,
          method: (method ??
            (body === undefined ? "GET" : "POST")) as InjectOptions["method"],
          payload: body as InjectOptions["payload"],
          headers: { origin, "x-csrf": "1", authorization: "Bearer " + bearer },
        });
      },
      start: (consent = false) =>
        f.request("/start", {
          requestId: randomUUID(),
          ...(consent ? { consent: true, policyVersion: 1, locale: "en" } : {}),
        }),
    };
    await run(f);
  } finally {
    provider.release?.();
    vi.stubGlobal("fetch", bridge);
    await aiApp.close();
    await rows(
      caseStore.db,
      sql`update settings set body=${JSON.stringify(before!.body)}::jsonb,version=${before!.version} where id=1`,
    );
  }
}
beforeAll(async () => {
  const url = (
    await readFile(
      new URL("../../../.suite-dev/test-database-url", import.meta.url),
      "utf8",
    )
  ).trim();
  const owner = postgres(url, { max: 1 });
  for (const name of ["whistle_suite_test", "whistle_privacy_test"]) {
    await owner.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await owner.unsafe(`CREATE DATABASE ${name}`);
  }
  await owner.end();
  suiteUrl = url.replace(/\/postgres$/, "/whistle_suite_test");
  privateUrl = url.replace(/\/postgres$/, "/whistle_privacy_test");
  await runMigrations(suiteUrl);
  await migratePrivacy(privateUrl);
  caseStore = createDb(suiteUrl);
  vault = privateDb(privateUrl);
  const cfg = loadConfig({
    NODE_ENV: "test",
    PUBLIC_WEB_URL: origin,
    SUITE_DATABASE_URL: suiteUrl,
    CASE_KEYRING: JSON.stringify(ring),
    CAPABILITY_PRIVATE_KEY: kp.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    SERVICE_EVENT_KEY: shared,
    ABUSE_KEY: shared,
  });
  app = await buildApp({ db: caseStore.db, config: cfg, limiter });
  privacy = await buildPrivacy({
    db: vault.db,
    config: privacyConfig({
      NODE_ENV: "test",
      PRIVACY_SMTP_HOST: "mailpit",
      PUBLIC_WEB_URL: origin,
      PRIVACY_DATABASE_URL: privateUrl,
      VAULT_KEYRING: JSON.stringify(vaultRing),
      CAPABILITY_PUBLIC_KEY: kp.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      SERVICE_EVENT_KEY: shared,
      PRIVACY_ABUSE_KEY: shared,
      PRIVACY_STORAGE: new URL(
        "../../../.suite-dev/test-files",
        import.meta.url,
      ).pathname,
    }),
    limiter,
  });
  vi.stubGlobal("fetch", async (url: string, opts: RequestInit) => {
    const path = new URL(url).pathname;
    const target = String(url).includes(":9550") ? app : privacy;
    const res = await target.inject({
      url: path,
      method: opts.method as InjectOptions["method"],
      headers: opts.headers as Record<string, string>,
      payload: opts.body as string,
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  });
  for (const [name, id] of Object.entries(ids).filter(
    ([n]) => !["standard", "independent"].includes(n),
  )) {
    const role =
      name === "admin"
        ? "admin"
        : name === "analyst" || name === "outsider"
          ? "analyst"
          : "manager";
    await rows(
      caseStore.db,
      sql`insert into staff(id,email,name,role,password_hash) values(${id},${name + "@example.test"},${name},${role},${await hashSecret(password)})`,
    );
  }
  await rows(
    caseStore.db,
    sql`insert into teams(id,name,restricted) values(${ids.standard},'Standard',false),(${ids.independent},'Independent',true)`,
  );
  for (const sid of [ids.manager, ids.manager2, ids.analyst])
    await rows(
      caseStore.db,
      sql`insert into team_members values(${ids.standard},${sid})`,
    );
  for (const sid of [ids.restricted, ids.restricted2])
    await rows(
      caseStore.db,
      sql`insert into team_members values(${ids.independent},${sid})`,
    );
  const body = {
    ...defaultSettings,
    defaultTeamId: ids.standard,
    restrictedTeamId: ids.independent,
    retention: {
      cases: 365,
      contacts: 365,
      evidence: 365,
      transcripts: 365,
      audit: 365,
      backups: 365,
    },
  };
  await rows(
    caseStore.db,
    sql`insert into settings(id,body,configured) values(1,${JSON.stringify(body)}::jsonb,true)`,
  );
}, 60000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  await privacy?.close();
  await caseStore?.close();
  await vault?.close();
});
describe("suite privacy and workflow boundaries", () => {
  it("requires MFA and blocks replay", async () => {
    for (const name of [
      "admin",
      "manager",
      "manager2",
      "analyst",
      "outsider",
      "restricted",
    ]) {
      const login = await call("/api/staff/login", {
        email: name + "@example.test",
        password,
      });
      expect(login.statusCode).toBe(200);
      const pre = cookie(login);
      expect((await call("/api/cases", undefined, pre)).statusCode).toBe(403);
      const enroll = await call("/api/staff/mfa/enroll", {}, pre);
      expect(enroll.statusCode).toBe(200);
      const code = await generate({ secret: enroll.json().secret });
      const confirmed = await call("/api/staff/mfa/confirm", { code }, pre);
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().recoveryCodes).toHaveLength(8);
      cookies[name] = cookie(confirmed);
      const secondLogin = await call("/api/staff/login", {
        email: name + "@example.test",
        password,
      });
      expect(
        (await call("/api/staff/mfa/confirm", { code }, cookie(secondLogin)))
          .statusCode,
      ).toBe(401);
    }
  }, 30000);
  it("submits without contacts and returns secrets only once", async () => {
    const r = await call("/api/reporter/reports", {
      title: "Potential procurement misconduct",
      summary:
        "I observed suspicious procurement transactions that warrant a review.",
      category: "fraud",
      privacyReviewed: true,
      policyVersion: 1,
    });
    expect(r.statusCode).toBe(201);
    receipt = r.json();
    expect(receipt.pin).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(receipt.recoveryCode).toMatch(
      /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
    );
    const lowerLogin = await call("/api/reporter/session", {
      caseCode: receipt.caseCode,
      pin: receipt.pin.toLowerCase(),
    });
    expect(lowerLogin.statusCode).toBe(200);
    const unhyphenatedLogin = await call("/api/reporter/session", {
      caseCode: receipt.caseCode,
      pin: receipt.pin.replace("-", "").toLowerCase(),
    });
    expect(unhyphenatedLogin.statusCode).toBe(200);
    reporterCookie = cookie(r);
    const own = await call("/api/reporter/case", undefined, reporterCookie);
    caseId = own.json().id;
    expect(own.json().pin).toBeUndefined();
    expect(own.json().recoveryCode).toBeUndefined();
    expect(await rows(vault.db, sql`select * from contacts`)).toHaveLength(0);
  });
  it("retries a lost submission response without duplicates or stored plaintext secrets", async () => {
    const submission = {
      pin: token(),
      recoveryCode: token(),
      submissionToken: token(),
    };
    const payload = {
      title: "A retry-safe anonymous report",
      summary:
        "The response may be lost after saving, but retry must preserve the same case.",
      category: "fraud",
      privacyReviewed: true,
      policyVersion: 1,
      submission,
    };
    const first = await call("/api/reporter/reports", payload);
    expect(first.statusCode).toBe(201);
    const retry = await call("/api/reporter/reports", payload);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().caseCode).toBe(first.json().caseCode);
    expect(retry.json().pin).toBe(submission.pin);
    const [r] = await rows(
      caseStore.db,
      sql`select * from cases where submission_hash=${digest(submission.submissionToken)}`,
    );
    expect(JSON.stringify(r)).not.toContain(submission.pin);
    expect(
      unseal(String(r!.content_enc), ring, "case:" + r!.id),
    ).not.toHaveProperty("submission");
    expect(
      (
        await call("/api/reporter/reports", {
          ...payload,
          submission: { ...submission, pin: token() },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("reserves a private AI transcript without exposing it in the staff report", async () => {
    const intakeId = randomUUID(),
      intakeToken = token();
    await rows(
      vault.db,
      sql`insert into intakes(id,token_hash,locale,consent_version,transcript_enc) values(${intakeId},${digest(intakeToken)},'en',1,${seal([{ role: "user", content: "An unreviewed private identity clue" }], vaultRing, "intake:" + intakeId)})`,
    );
    const payload = {
      title: "A reviewed assistant draft",
      summary:
        "Only this reviewed summary should be shared with the assigned review team.",
      category: "fraud",
      privacyReviewed: true,
      policyVersion: 1,
      intakeId,
      intakeToken,
      submission: {
        pin: token(),
        recoveryCode: token(),
        submissionToken: token(),
      },
    };
    const access = await verifiedAccess();
    reportAdmissions.set(
      payload.submission.submissionToken,
      access.reportToken,
    );
    await rows(
      vault.db,
      sql`update intakes set admission_id=(select id from admission_grants where token_hash=${digest(access.reportToken)}) where id=${intakeId}`,
    );
    const result = await call("/api/reporter/reports", payload);
    expect(result.statusCode).toBe(201);
    const view = await call("/api/reporter/case", undefined, cookie(result));
    const [intake] = await rows(
      vault.db,
      sql`select case_id from intakes where id=${intakeId}`,
    );
    expect(intake!.case_id).toBe(view.json().id);
    const staff = await call(
      "/api/cases/" + view.json().id,
      undefined,
      cookies.manager,
    );
    expect(staff.statusCode).toBe(200);
    expect(staff.body).not.toContain("unreviewed private identity");
    expect(staff.body).not.toContain(intakeToken);
    expect(
      (
        await call("/api/reporter/reports", {
          ...payload,
          intakeToken: token(),
          submission: {
            pin: token(),
            recoveryCode: token(),
            submissionToken: token(),
          },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("enforces CSRF, assignment and administrative separation", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/reporter/rotate",
          headers: { cookie: reporterCookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    for (const name of ["admin", "analyst", "outsider", "restricted"])
      expect(
        (await call(`/api/cases/${caseId}`, undefined, cookies[name]))
          .statusCode,
      ).toBe(404);
    expect(
      (
        await call(
          `/api/cases/${caseId}/assign`,
          { staffId: ids.outsider },
          cookies.manager,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          `/api/cases/${caseId}/assign`,
          { staffId: ids.analyst, owner: true },
          cookies.manager,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await call(`/api/cases/${caseId}`, undefined, cookies.analyst))
        .statusCode,
    ).toBe(200);
  });
  it("verifies a contact privately without allowing staff access or recovery", async () => {
    const request = await call(
      `/api/cases/${caseId}/verification`,
      {
        reason:
          "Please confirm control of a contact for private notifications.",
      },
      cookies.analyst,
    );
    expect(request.statusCode).toBe(200);
    const challenge = await privateCall("/contacts/challenge", {
      kind: "email",
      destination: "reporter-private@example.test",
      notifications: true,
    });
    expect(challenge.statusCode).toBe(200);
    const [job] = await rows(
      vault.db,
      sql`select * from delivery_jobs where kind='otp' order by created_at desc limit 1`,
    );
    const body = unseal<Record<string, unknown>>(
      String(job!.body_enc),
      vaultRing,
      `job:${job!.id}`,
    );
    const verified = await privateCall("/contacts/verify", {
      challengeId: challenge.json().challengeId,
      code: body.code,
    });
    expect(verified.statusCode).toBe(200);
    expect(
      (
        await privateCall("/contacts/verify", {
          challengeId: challenge.json().challengeId,
          code: body.code,
        })
      ).statusCode,
    ).toBe(400);
    const events = await rows(
      vault.db,
      sql`select * from delivery_jobs where kind='event' order by created_at`,
    );
    for (const e of events) {
      const b = unseal<Record<string, unknown>>(
          String(e.body_enc),
          vaultRing,
          `job:${e.id}`,
        ),
        stamp = Date.now().toString();
      const response = await app.inject({
        method: "POST",
        url: "/internal/events",
        headers: {
          "x-service-time": stamp,
          "x-service-signature": mac(
            shared,
            `${stamp}:events:${JSON.stringify(b)}`,
          ),
        },
        payload: b,
      });
      expect(response.statusCode).toBe(200);
    }
    const staff = await call(
      `/api/cases/${caseId}`,
      undefined,
      cookies.analyst,
    );
    expect(staff.json().verification.state).toBe("verified");
    expect(staff.body).not.toContain("reporter-private");
    expect(staff.body).not.toContain("destination");
    expect(
      (
        await privacy.inject({
          url: "/privacy/reporter/contacts",
          headers: { cookie: cookies.admin },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await call("/api/reporter/recover", {
          caseCode: receipt.caseCode,
          recoveryCode: "reporter-private@example.test",
        })
      ).statusCode,
    ).toBe(401);
  });
  it("keeps notifications and private contacts encrypted", async () => {
    const [c] = await rows(
      vault.db,
      sql`select * from contacts where case_id=${caseId}`,
    );
    expect(String(c!.destination_enc)).not.toContain("reporter-private");
    const audits = JSON.stringify(
      await rows(caseStore.db, sql`select * from audit_events`),
    );
    expect(audits).not.toContain("reporter-private");
    expect(audits).not.toContain(receipt.pin);
    expect(
      (await call("/api/admin/analytics", undefined, cookies.admin)).json()
        .groups,
    ).toHaveLength(0);
  });
  it("serves an admin-only dashboard with exact counts and a zero-filled trend", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ok = await call(
      `/api/admin/dashboard?to=${today}`,
      undefined,
      cookies.admin,
    );
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.trend).toHaveLength(30);
    expect(body.trend.at(-1).day).toBe(today);
    expect(body.total).toBeGreaterThan(0);
    expect(body.total).toBe(
      body.states.reduce((n: number, r: { count: number }) => n + r.count, 0),
    );
    expect(
      body.trend.reduce(
        (n: number, d: { created: number }) => n + d.created,
        0,
      ),
    ).toBeGreaterThanOrEqual(body.total);
    expect(body.ai).toMatchObject({ total: expect.any(Number) });
    expect(
      (
        await call(
          `/api/admin/dashboard?from=2000-01-01&to=${today}`,
          undefined,
          cookies.admin,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await call("/api/admin/dashboard", undefined, cookies.manager))
        .statusCode,
    ).toBe(403);
  });
  it("supports conversation and independent closure approval", async () => {
    expect(
      (
        await call(
          "/api/reporter/messages",
          {
            body: "Additional facts from the anonymous reporter.",
            privacyReviewed: true,
          },
          reporterCookie,
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call(
          `/api/cases/${caseId}/messages`,
          { body: "Thank you. We will review the documents." },
          cookies.analyst,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await call("/api/reporter/case", undefined, reporterCookie)).json()
        .messages,
    ).toHaveLength(2);
    expect(
      (
        await call(
          `/api/cases/${caseId}/state`,
          { state: "triage" },
          cookies.analyst,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          `/api/cases/${caseId}/state`,
          { state: "closed" },
          cookies.analyst,
        )
      ).statusCode,
    ).toBe(409);
    const task = await call(
      `/api/cases/${caseId}/records`,
      { kind: "task", body: "Improve procurement approval controls." },
      cookies.analyst,
    );
    const closure = {
      outcome: "substantiated",
      rationale:
        "The available documents substantiate the reported procurement issue.",
      publicExplanation:
        "The investigation is complete and corrective actions have been taken.",
    };
    expect(
      (await call(`/api/cases/${caseId}/closure`, closure, cookies.manager))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          `/api/cases/${caseId}/tasks/${task.json().id}/complete`,
          { completionEvidence: "Approval procedures updated and reviewed." },
          cookies.analyst,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await call(`/api/cases/${caseId}/closure`, closure, cookies.manager))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          `/api/cases/${caseId}/closure/review`,
          { approve: true, reason: "Independent review completed." },
          cookies.manager,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          `/api/cases/${caseId}/closure/review`,
          { approve: true, reason: "Independent review completed." },
          cookies.manager2,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          "/api/reporter/messages",
          { body: "This should be rejected.", privacyReviewed: true },
          reporterCookie,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call(
          "/api/reporter/reopen",
          { reason: "There are additional facts for the team." },
          reporterCookie,
        )
      ).statusCode,
    ).toBe(200);
  });
  it("respects legal holds when deleting old cases", async () => {
    await call(
      `/api/cases/${caseId}/hold`,
      {
        hold: true,
        reason: "Preserve records for an ongoing legal proceeding.",
      },
      cookies.manager,
    );
    await rows(
      caseStore.db,
      sql`update cases set closed_at=now()-interval '400 days' where id=${caseId}`,
    );
    await expire(caseStore.db);
    expect(
      await rows(caseStore.db, sql`select id from cases where id=${caseId}`),
    ).toHaveLength(1);
  });
  it("revokes sessions and capabilities during recovery", async () => {
    const old = reporterCookie;
    const recovered = await call("/api/reporter/recover", {
      caseCode: receipt.caseCode,
      recoveryCode: receipt.recoveryCode.replace(/-/g, "").toLowerCase(),
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().pin).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(recovered.json().recoveryCode).toMatch(
      /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
    );
    reporterCookie = cookie(recovered);
    expect((await call("/api/reporter/case", undefined, old)).statusCode).toBe(
      401,
    );
    expect(
      (await privateCall("/contacts", undefined, undefined, receipt.capability))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await call("/api/reporter/session", {
          caseCode: receipt.caseCode,
          pin: receipt.pin,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await call("/api/reporter/recover", {
          caseCode: receipt.caseCode,
          recoveryCode: receipt.recoveryCode,
        })
      ).statusCode,
    ).toBe(401);
    receipt = recovered.json();
  });
  it("routes leadership allegations independently and revokes recused access", async () => {
    const r = await call("/api/reporter/reports", {
      title: "Review team conflict of interest",
      summary:
        "This concern involves members of the standard review team and company leadership.",
      category: "other",
      sensitive: true,
      privacyReviewed: true,
      policyVersion: 1,
    });
    const own = await call("/api/reporter/case", undefined, cookie(r));
    const id = own.json().id;
    expect(
      (await call(`/api/cases/${id}`, undefined, cookies.manager)).statusCode,
    ).toBe(404);
    expect(
      (await call(`/api/cases/${id}`, undefined, cookies.restricted))
        .statusCode,
    ).toBe(200);
    expect(
      (await call(`/api/cases/${caseId}/recuse`, {}, cookies.analyst))
        .statusCode,
    ).toBe(200);
    expect(
      (await call(`/api/cases/${caseId}`, undefined, cookies.analyst))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          `/api/cases/${caseId}/assign`,
          { staffId: ids.analyst },
          cookies.manager,
        )
      ).statusCode,
    ).toBe(409);
  });
  it("rejects forged internal calls and capabilities, disabled AI, and disclosure endpoints", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/events",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await privacy.inject({
          method: "POST",
          url: "/internal/evidence",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await privacy.inject({
          method: "POST",
          url: "/privacy/intake",
          headers: { origin, "x-csrf": "1" },
          payload: { consent: true, locale: "en", policyVersion: 1 },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await privacy.inject({
          method: "POST",
          url: "/privacy/intake",
          headers: { origin, "x-csrf": "1" },
          payload: { locale: "en", policyVersion: 1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(() =>
      verifyCapability(
        receipt.capability + "bad",
        kp.publicKey.export({ type: "spki", format: "pem" }).toString(),
      ),
    ).toThrow();
    for (const path of [
      "/api/admin/reports",
      "/api/admin/reports/" + caseId + "/contact",
      "/privacy/reporter/original",
    ])
      expect((await call(path, undefined, cookies.admin)).statusCode).toBe(404);
  });
  it("offboards staff without allowing an outstanding password reset to reactivate them", async () => {
    const reset = token();
    await rows(
      caseStore.db,
      sql`insert into staff_tokens(staff_id,token_hash,purpose,expires_at) values(${ids.outsider},${digest(reset)},'password_reset',now()+interval '30 minutes')`,
    );
    const disabled = await call(
      "/api/admin/staff/" + ids.outsider,
      { active: false, role: "analyst", name: "outsider" },
      cookies.admin,
      "PATCH",
    );
    expect(disabled.statusCode).toBe(200);
    expect(
      (await call("/api/staff/me", undefined, cookies.outsider)).statusCode,
    ).toBe(401);
    expect(
      (await call("/api/staff/password/accept", { token: reset, password }))
        .statusCode,
    ).toBe(401);
    // Even a previously queued reset inserted after disable cannot bypass it.
    const late = token();
    await rows(
      caseStore.db,
      sql`insert into staff_tokens(staff_id,token_hash,purpose,expires_at) values(${ids.outsider},${digest(late)},'password_reset',now()+interval '30 minutes')`,
    );
    expect(
      (await call("/api/staff/password/accept", { token: late, password }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await call(
          "/api/admin/staff/" + ids.admin,
          { active: false, role: "admin", name: "admin" },
          cookies.admin,
          "PATCH",
        )
      ).statusCode,
    ).toBe(409);
  });
  it("does not delete a refreshed contact selected by an older retention scan", async () => {
    const result = await call("/api/reporter/reports", {
      title: "Retention race test report",
      summary:
        "Synthetic report checks that a changed contact is not deleted by a stale selection.",
      category: "fraud",
      privacyReviewed: true,
      policyVersion: 1,
    });
    expect(result.statusCode).toBe(201);
    const own = await call("/api/reporter/case", undefined, cookie(result));
    const contact = randomUUID();
    await rows(
      vault.db,
      sql`insert into contacts(id,case_id,kind,destination_enc,destination_hash,created_at) values(${contact},${own.json().id},'email',${seal("retention@example.test", vaultRing, "contact:" + contact)},${digest(token())},now()-interval '400 days')`,
    );
    const bridge = globalThis.fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith("/retention/lease"))
        await rows(
          vault.db,
          sql`update contacts set created_at=now() where id=${contact}`,
        );
      return bridge(...args);
    });
    try {
      await expirePrivate(vault.db, privacy.privacyDeps.config);
    } finally {
      vi.stubGlobal("fetch", bridge);
    }
    expect(
      await rows(vault.db, sql`select id from contacts where id=${contact}`),
    ).toHaveLength(1);
  });
  it("rejects approval of a different evidence version than the reporter reviewed", async () => {
    const result = await call("/api/reporter/reports", {
      title: "Evidence version approval test",
      summary:
        "Only the exact sanitized version reviewed by this reporter may be published.",
      category: "fraud",
      privacyReviewed: true,
      policyVersion: 1,
    });
    const view = await call("/api/reporter/case", undefined, cookie(result));
    const file = randomUUID(),
      current = digest("the new redacted version");
    await rows(
      vault.db,
      sql`insert into files(id,case_id,original_path,original_sha256,original_size,status,mime,size,pages,sha256,transformation) values(${file},${view.json().id},'sealed-original',${digest("original")},100,'review','image/png',100,1,${current},'rasterized;metadata_removed')`,
    );
    const stale = await privateCall(
      "/files/" + file + "/approve",
      { privacyReviewed: true, sha256: digest("earlier preview") },
      "POST",
      result.json().capability,
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("preview_changed");
    expect(
      (
        await privateCall(
          "/files/" + file + "/approve",
          { privacyReviewed: true, sha256: current },
          "POST",
          result.json().capability,
        )
      ).statusCode,
    ).toBe(200);
  });
  it("rejects cross-case, expired and excessive OTP attempts without revealing a destination", async () => {
    const result = await call("/api/reporter/reports", {
      title: "OTP boundary test report",
      summary:
        "Synthetic report checks code expiry, case binding and aggregate attempt limits.",
      category: "fraud",
      privacyReviewed: true,
      policyVersion: 1,
    });
    expect(result.statusCode).toBe(201);
    const cap = result.json().capability;
    const own = await call("/api/reporter/case", undefined, cookie(result));
    const challenge = await privateCall(
      "/contacts/challenge",
      { kind: "email", destination: "boundary@example.test" },
      "POST",
      cap,
    );
    expect(challenge.statusCode).toBe(200);
    const challengeId = challenge.json().challengeId;
    const [job] = await rows(
      vault.db,
      sql`select * from delivery_jobs where case_id=${own.json().id} and kind='otp'`,
    );
    const body = unseal<{ code: string }>(
      String(job!.body_enc),
      vaultRing,
      "job:" + job!.id,
    );
    const otherCap = (
      await call("/api/reporter/capability", {}, reporterCookie)
    ).json().capability;
    const cross = await privateCall(
      "/contacts/verify",
      { challengeId, code: body.code },
      "POST",
      otherCap,
    );
    expect(cross.statusCode).toBe(400);
    expect(cross.body).not.toContain("boundary@example.test");
    await rows(
      vault.db,
      sql`update challenges set expires_at=now()-interval '1 second' where id=${challengeId}`,
    );
    expect(
      (
        await privateCall(
          "/contacts/verify",
          { challengeId, code: body.code },
          "POST",
          cap,
        )
      ).statusCode,
    ).toBe(400);
    const next = randomUUID();
    const [contact] = await rows(
      vault.db,
      sql`select id from contacts where case_id=${own.json().id}`,
    );
    await rows(
      vault.db,
      sql`insert into challenges(id,case_id,contact_id,code_hash,expires_at) values(${next},${own.json().id},${contact!.id},${mac(shared, next + ":123456")},now()+interval '5 minutes')`,
    );
    for (let attempt = 0; attempt < 4; attempt++)
      expect(
        (
          await privateCall(
            "/contacts/verify",
            { challengeId: next, code: "000000" },
            "POST",
            cap,
          )
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await privateCall(
          "/contacts/verify",
          { challengeId: next, code: "123456" },
          "POST",
          cap,
        )
      ).statusCode,
    ).toBe(429);
    expect(
      (
        await rows(
          vault.db,
          sql`select verified_at from contacts where id=${contact!.id}`,
        )
      )[0]!.verified_at,
    ).toBeNull();
  });
  it("recognizes Zoho contact verification without SMTP and leaves SMS unavailable", async () => {
    counts.clear();
    const config = privacy.privacyDeps.config;
    const previous = config.email;
    try {
      const report = await call("/api/reporter/reports", {
        title: "Zoho provider configuration test",
        summary:
          "Synthetic report verifies email availability independently of the SMTP transport.",
        category: "fraud",
        privacyReviewed: true,
        policyVersion: 1,
      });
      expect(report.statusCode).toBe(201);
      const cap = report.json().capability;
      config.email = {
        provider: "zoho",
        apiKey: randomBytes(16).toString("hex"),
        from: "noreply@example.test",
      };
      const ops = await call("/api/admin/operations", undefined, cookies.admin);
      expect(ops.json().privacy.providers.email).toBe(true);
      expect(ops.json().privacy.providers.phone).toBe(false);
      const email = await privateCall(
        "/contacts/challenge",
        {
          kind: "email",
          destination: "zoho-fixture@example.test",
        },
        "POST",
        cap,
      );
      expect(email.statusCode).toBe(200);
      const phone = await privateCall(
        "/contacts/challenge",
        {
          kind: "phone",
          destination: "+628123456789",
        },
        "POST",
        cap,
      );
      expect(phone.statusCode).toBe(503);
      expect(phone.json().error).toBe("sms_unavailable");
      config.email = {
        provider: "zoho",
        apiKey: "",
        from: "noreply@example.test",
      };
      expect(
        (
          await privateCall(
            "/contacts/challenge",
            {
              kind: "email",
              destination: "missing-fixture@example.test",
            },
            "POST",
            cap,
          )
        ).statusCode,
      ).toBe(503);
      expect(
        (await call("/api/admin/operations", undefined, cookies.admin)).json()
          .privacy.providers.email,
      ).toBe(false);
    } finally {
      config.email = previous;
    }
  });
  it("provides safe administrator user details and preserves pending invitations during edits", async () => {
    counts.clear();
    const email = `invited-${randomUUID()}@example.test`;
    const invited = await call(
      "/api/admin/staff",
      {
        email: "  " + email.toUpperCase() + "  ",
        name: "Invited user",
        role: "analyst",
      },
      cookies.admin,
    );
    expect(invited.statusCode).toBe(200);
    const [staff] = await rows(
      caseStore.db,
      sql`select id from staff where email=${email}`,
    );
    const path = `/api/admin/staff/${staff!.id}`;
    const detail = await call(path, undefined, cookies.admin);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().staff).toMatchObject({
      email,
      name: "Invited user",
      role: "analyst",
      active: false,
      mfa_enrolled: false,
    });
    expect(Object.keys(detail.json().staff).sort()).toEqual(
      [
        "id",
        "email",
        "name",
        "role",
        "active",
        "mfa_enrolled",
        "created_at",
      ].sort(),
    );
    expect(
      (
        await call(
          "/api/admin/staff",
          { email, name: "Duplicate", role: "manager" },
          cookies.admin,
        )
      ).statusCode,
    ).toBe(409);
    for (const role of ["manager", "analyst"]) {
      expect((await call(path, undefined, cookies[role])).statusCode).toBe(403);
      expect(
        (await call(path + "/password-reset", {}, cookies[role])).statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            "/api/admin/staff",
            {
              email: `blocked-${randomUUID()}@example.test`,
              name: "Blocked",
              role: "admin",
            },
            cookies[role],
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            path,
            { name: "Blocked", role: "admin", active: true },
            cookies[role],
            "PATCH",
          )
        ).statusCode,
      ).toBe(403);
    }
    expect((await call(path)).statusCode).toBe(401);
    expect(
      (await call(`/api/admin/staff/${randomUUID()}`, undefined, cookies.admin))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          `/api/admin/staff/${randomUUID()}/password-reset`,
          {},
          cookies.admin,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await call(path + "/password-reset", {}, cookies.admin)).json().error,
    ).toBe("staff_inactive");
    const pending = await rows(
      caseStore.db,
      sql`select body from jobs where staff_id=${staff!.id} and kind='staff_token'`,
    );
    const raw = unseal<string>(
      (pending[0]!.body as Record<string, string>).tokenEnc!,
      ring,
      "staff-token",
    );
    expect(
      (
        await call(
          path,
          { name: "Edited invite", role: "manager", active: false },
          cookies.admin,
          "PATCH",
        )
      ).statusCode,
    ).toBe(200);
    const remaining = await rows(
      caseStore.db,
      sql`select body from jobs where staff_id=${staff!.id} and kind='staff_token'`,
    );
    expect(remaining).toEqual(pending);
    expect(
      (await call("/api/staff/password/accept", { token: raw, password }))
        .statusCode,
    ).toBe(200);
    const updated = await call(path, undefined, cookies.admin);
    expect(updated.json().staff).toMatchObject({
      name: "Edited invite",
      role: "manager",
      active: true,
      mfa_enrolled: false,
      email,
    });
  });
  it("shares reset issuance, records the administrator, and revokes sessions only on password acceptance", async () => {
    counts.clear();
    const id = randomUUID(),
      email = `reset-${id}@example.test`,
      rawSession = token(),
      mfaEnc = seal("SYNTHETICMFASECRET", ring, "mfa:" + id);
    await rows(
      caseStore.db,
      sql`insert into staff(id,email,name,role,password_hash,mfa_enc) values(${id},${email},'Reset user','analyst',${await hashSecret(password)},${mfaEnc})`,
    );
    await rows(
      caseStore.db,
      sql`insert into staff_sessions(token_hash,staff_id,mfa,expires_at) values(${digest(rawSession)},${id},true,now()+interval '1 hour')`,
    );
    const path = `/api/admin/staff/${id}/password-reset`;
    const getRaw = async () => {
      const [job] = await rows(
        caseStore.db,
        sql`select body from jobs where staff_id=${id} and kind='staff_token'`,
      );
      expect(JSON.stringify(job!.body)).not.toContain(email);
      return unseal<string>(
        (job!.body as Record<string, string>).tokenEnc!,
        ring,
        "staff-token",
      );
    };
    expect((await call(path, {}, cookies.admin)).json()).toEqual({ ok: true });
    const first = await getRaw();
    const existingCookie = "wb_staff=" + rawSession;
    expect(
      (await call("/api/staff/me", undefined, existingCookie)).statusCode,
    ).toBe(200);
    const events = await rows(
      caseStore.db,
      sql`select actor_id,meta from audit_events where action='staff_password_reset_requested' and meta->>'staffId'=${id}`,
    );
    expect(events).toEqual([{ actor_id: ids.admin, meta: { staffId: id } }]);
    expect(
      (await call("/api/staff/password/request", { email })).statusCode,
    ).toBe(200);
    const second = await getRaw();
    expect(second).not.toBe(first);
    expect(
      (await call("/api/staff/password/accept", { token: first, password }))
        .statusCode,
    ).toBe(401);
    await rows(
      caseStore.db,
      sql`update staff_tokens set expires_at=now()-interval '1 second' where token_hash=${digest(second)}`,
    );
    expect(
      (await call("/api/staff/password/accept", { token: second, password }))
        .statusCode,
    ).toBe(401);
    expect((await call(path, {}, cookies.admin)).statusCode).toBe(200);
    const third = await getRaw(),
      newPassword = "A different test-only long password";
    expect(
      (
        await call("/api/staff/password/accept", {
          token: third,
          password: newPassword,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await call("/api/staff/me", undefined, existingCookie)).statusCode,
    ).toBe(401);
    expect(
      (
        await call("/api/staff/password/accept", {
          token: third,
          password: newPassword,
        })
      ).statusCode,
    ).toBe(401);
    const [after] = await rows(
      caseStore.db,
      sql`select mfa_enc from staff where id=${id}`,
    );
    expect(after!.mfa_enc).toBe(mfaEnc);
    expect(
      (await call("/api/staff/login", { email, password })).statusCode,
    ).toBe(401);
    const login = await call("/api/staff/login", {
      email,
      password: newPassword,
    });
    expect(login.json().mfaEnrolled).toBe(true);
    expect(
      (await call(`/api/admin/staff/${id}`, undefined, cookie(login)))
        .statusCode,
    ).toBe(403);
  });
  it("shares destination reset limits between administrators and self-service recovery", async () => {
    counts.clear();
    const id = randomUUID(),
      email = `reset-limit-${id}@example.test`;
    await rows(
      caseStore.db,
      sql`insert into staff(id,email,name,role,password_hash) values(${id},${email},'Reset budget user','analyst',${await hashSecret(password)})`,
    );
    expect(
      (await call("/api/staff/password/request", { email })).statusCode,
    ).toBe(200);
    for (let n = 1; n < 10; n++)
      expect(
        (await call(`/api/admin/staff/${id}/password-reset`, {}, cookies.admin))
          .statusCode,
      ).toBe(200);
    expect(
      (await call(`/api/admin/staff/${id}/password-reset`, {}, cookies.admin))
        .statusCode,
    ).toBe(429);
    expect(
      (await call("/api/staff/password/request", { email })).statusCode,
    ).toBe(429);
    const [pending] = await rows(
      caseStore.db,
      sql`select count(*)::int n from staff_tokens where staff_id=${id} and used_at is null`,
    );
    expect(pending!.n).toBe(1);
  });
  it("allows direct anonymous report submission without email verification and blocks bots via honeypot", async () => {
    const submission = {
      pin: token(),
      recoveryCode: token(),
      submissionToken: token(),
    };
    const r = await app.inject({
      url: "/api/reporter/reports",
      method: "POST",
      headers: { origin, "x-csrf": "1" },
      payload: {
        submission,
        title: "Direct anonymous test report",
        summary:
          "A valid synthetic narrative submitted anonymously without employee email gating.",
        category: "fraud",
        privacyReviewed: true,
        policyVersion: 1,
      },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().caseCode).toMatch(/^WB-/);
    expect(r.json().pin).toBeTypeOf("string");

    // Honeypot test: bots that fill the hidden honeypot field receive a mock 201 without creating a case in DB
    const botSubmission = {
      pin: token(),
      recoveryCode: token(),
      submissionToken: token(),
    };
    const botRes = await app.inject({
      url: "/api/reporter/reports",
      method: "POST",
      headers: { origin, "x-csrf": "1" },
      payload: {
        submission: botSubmission,
        title: "Spam bot report",
        summary: "Automated spam trying to abuse public intake form.",
        category: "fraud",
        privacyReviewed: true,
        policyVersion: 1,
        hp: "https://spam-bot.site",
      },
    });
    expect(botRes.statusCode).toBe(201);
    const [botCase] = await rows(
      caseStore.db,
      sql`select * from cases where submission_hash=${digest(botSubmission.submissionToken)}`,
    );
    expect(botCase).toBeUndefined();
  });
  it("submits report with optional email and verifies notification contact post-submission", async () => {
    counts.clear();
    const reporterEmail = `whistleblower-${randomUUID()}@example.test`;
    const submission = {
      pin: token(),
      recoveryCode: token(),
      submissionToken: token(),
    };
    const res = await app.inject({
      url: "/api/reporter/reports",
      method: "POST",
      headers: { origin, "x-csrf": "1" },
      payload: {
        submission,
        title: "Report with notification email",
        summary:
          "Reporter provides optional email to receive notification updates on progress.",
        category: "fraud",
        reporterEmail,
        privacyReviewed: true,
        policyVersion: 1,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().challengeId).toBeTypeOf("string");
    expect(res.json().reporterEmail).toBe(reporterEmail);

    // Verify OTP was queued
    const jobs = await rows(
      vault.db,
      sql`select id,body_enc from delivery_jobs where kind='otp' order by created_at desc`,
    );
    const job = jobs
      .map((j) =>
        unseal<Record<string, unknown>>(
          String(j.body_enc),
          vaultRing,
          "job:" + j.id,
        ),
      )
      .find((b) => b.destination === reporterEmail);
    expect(job).toBeDefined();

    // Verify the contact using the capability returned
    const cid = res.json().challengeId;
    const verifyRes = await privacy.inject({
      url: "/privacy/reporter/contacts/verify",
      method: "POST",
      headers: {
        origin,
        "x-csrf": "1",
        authorization: `Bearer ${res.json().capability}`,
      },
      payload: {
        challengeId: cid,
        code: String(job!.code),
      },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().verified).toBe(true);

    // Verify contact in vault has verified_at set
    const [contact] = await rows(
      vault.db,
      sql`select verified_at from contacts where destination_hash=${mac(shared, `${digest(submission.submissionToken).slice(0, 32)}:${reporterEmail}`)}`,
    );
    expect(contact?.verified_at).not.toBeNull();
  });
  it("persists OTP attempts and rejects expiration and reuse", async () => {
    const access = await verifiedAccess();
    const [c] = await rows(
      vault.db,
      sql`select id from admission_challenges where email_hash=${mac(shared, "employee:" + access.email)}`,
    );
    expect(
      (
        await admission("verify", {
          challengeId: c!.id,
          code: await admissionCode(String(c!.id)),
        })
      ).statusCode,
    ).toBe(400);
    const bad = await verifiedAccess();
    // Create an isolated challenge without resetting destination send limits.
    const cid = randomUUID();
    await rows(
      vault.db,
      sql`insert into admission_challenges(id,email_hash,email_enc,purpose,code_hash,locale,expires_at) values(${cid},${mac(shared, "employee:" + bad.email)},${seal(bad.email, vaultRing, "admission-challenge:" + cid)},'report',${mac(shared, cid + ":123456")},'en',now()+interval '5 minutes')`,
    );
    for (let i = 0; i < 5; i++)
      expect(
        (await admission("verify", { challengeId: cid, code: "000000" }))
          .statusCode,
      ).toBe(400);
    expect(
      (await admission("verify", { challengeId: cid, code: "123456" }))
        .statusCode,
    ).toBe(400);
    const [attempts] = await rows(
      vault.db,
      sql`select attempts from admission_challenges where id=${cid}`,
    );
    expect(attempts!.attempts).toBe(5);
    await rows(
      vault.db,
      sql`update admission_challenges set expires_at=now()-interval '1 second',attempts=0 where id=${cid}`,
    );
    expect(
      (await admission("verify", { challengeId: cid, code: "123456" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call(`/api/admin/employees/${access.id}`, {}, cookies.admin, "PUT")).statusCode,
    ).toBe(404);
  });
  it("keeps published reports unlinkable to directory records and limits each grant to one submission", async () => {
    const access = await verifiedAccess(),
      submission = {
        pin: token(),
        recoveryCode: token(),
        submissionToken: token(),
      };
    const send = (credentials = submission) =>
      app.inject({
        url: "/api/reporter/reports",
        method: "POST",
        headers: {
          origin,
          "x-csrf": "1",
          "x-report-access": access.reportToken,
        },
        payload: {
          submission: credentials,
          title: "Anonymous employee report",
          summary:
            "A synthetic concern with no employee name or contact embedded in its content.",
          category: "fraud",
          privacyReviewed: true,
          policyVersion: 1,
        },
      });
    const r = await send();
    expect(r.statusCode).toBe(201);
    const retry = await send();
    expect(retry.statusCode).toBe(201);
    expect(retry.json().caseCode).toBe(r.json().caseCode);
    expect(
      (
        await send({
          pin: token(),
          recoveryCode: token(),
          submissionToken: token(),
        })
      ).statusCode,
    ).toBe(401);
    const [g] = await rows(
      vault.db,
      sql`select * from admission_grants where token_hash=${digest(access.reportToken)}`,
    );
    expect(g).toBeDefined();
    const c = await call("/api/reporter/case", undefined, cookie(r));
    const safe = JSON.stringify(c.json());
    expect(safe).not.toContain(access.email);
    expect(safe).not.toContain(access.id);
    expect(safe).not.toContain(access.reportToken);
    expect(
      (await call("/api/admin/employees", undefined, cookies.analyst))
        .statusCode,
    ).toBe(404);
  });
  it("submits the form before AI and privately persists context, transcript and review drafts", async () => {
    await withConversation(async (f) => {
      expect(f.requests).toHaveLength(0);
      const initial = await f.request("");
      expect(initial.json()).toMatchObject({
        consented: true,
        initialized: false,
        messages: [],
      });
      const started = await f.start();
      expect(started.statusCode).toBe(200);
      expect(started.json().messages).toHaveLength(1);
      expect(f.requests[0].messages[0].content).toContain(
        "OPENING TURN",
      );
      expect(f.requests[0].messages[1].content).toContain("Warehouse A");
      expect(f.requests[0].messages[1].content).toContain("Reply language:");
      const sent = await f.request("/messages", {
        requestId: randomUUID(),
        body: "Unreviewed private identity clue",
      });
      expect(sent.statusCode).toBe(200);
      expect(sent.json().messages).toHaveLength(3);
      const draft = await f.request("/draft", { requestId: randomUUID() });
      expect(draft.statusCode).toBe(200);
      expect(draft.json().draft.details.why).toBe("Unknown");
      expect((await f.request("")).json().draft).toEqual(draft.json().draft);
      const view = await call("/api/reporter/case", undefined, f.cookie);
      const staff = await call(
        "/api/cases/" + view.json().id,
        undefined,
        cookies.manager,
      );
      expect(staff.statusCode).toBe(200);
      expect(staff.body).not.toContain("Unreviewed private identity clue");
      expect(staff.body).not.toContain("aiConsent");
      const [grant] = await rows(
        vault.db,
        sql`select * from admission_grants where case_id=${view.json().id}`,
      );
      expect(grant).toBeDefined();
    });
  });
  it("replays AI and published update requests without duplicate work, audits or notifications", async () => {
    await withConversation(async (f) => {
      await f.start();
      const payload = {
        requestId: randomUUID(),
        body: "Additional private information",
      };
      const first = await f.request("/messages", payload);
      expect(first.statusCode).toBe(200);
      const n = f.requests.length;
      expect(
        (await f.request("/messages", payload)).json().messages,
      ).toHaveLength(3);
      expect(f.requests).toHaveLength(n);
      expect(
        (await f.request("/messages", { ...payload, body: "Changed content" }))
          .statusCode,
      ).toBe(409);
      const clientMessageId = randomUUID(),
        update = {
          body: "Reporter-reviewed AI follow-up: additional approved details",
          privacyReviewed: true,
          clientMessageId,
        };
      expect(
        (await call("/api/reporter/messages", update, f.cookie)).statusCode,
      ).toBe(201);
      expect(
        (await call("/api/reporter/messages", update, f.cookie)).statusCode,
      ).toBe(201);
      expect(
        (
          await call(
            "/api/reporter/messages",
            { ...update, body: "Changed reviewed content" },
            f.cookie,
          )
        ).statusCode,
      ).toBe(409);
      const [nrows] = await rows(
        caseStore.db,
        sql`select (select count(*)::int from case_messages where case_id=${f.caseId}) messages,(select count(*)::int from audit_events where case_id=${f.caseId} and action='reporter_message') audits,(select count(*)::int from jobs where case_id=${f.caseId} and kind='staff_alert' and body->>'event'='reply') jobs`,
      );
      expect(nrows).toEqual({ messages: 1, audits: 1, jobs: 1 });
      expect(
        (await call("/api/reporter/case", undefined, f.cookie)).json().content
          .summary,
      ).toBe(f.content.summary);
    });
  });
  it("saves failed messages, rejects concurrent work and retries without duplicating reporter text", async () => {
    await withConversation(async (f) => {
      await f.start();
      f.provider.pause = true;
      const payload = {
        requestId: randomUUID(),
        body: "Persist this even if AI fails",
      };
      const running = f.request("/messages", payload);
      await vi.waitFor(() => expect(f.provider.release).toBeTypeOf("function"));
      expect(
        (await f.request("/draft", { requestId: randomUUID() })).json().error,
      ).toBe("conversation_busy");
      const pending = await f.request("");
      expect(pending.json().messages.at(-1).content).toBe(payload.body);
      f.provider.fail = true;
      f.provider.pause = false;
      f.provider.release!();
      expect((await running).statusCode).toBe(503);
      const saved = await f.request("");
      expect(saved.json().pending).toMatchObject({
        id: payload.requestId,
        retryable: true,
        status: "failed",
      });
      const n = f.requests.length;
      expect((await f.request("/messages", payload)).statusCode).toBe(503);
      expect(f.requests).toHaveLength(n);
      expect(
        (
          await f.request("/messages", {
            requestId: randomUUID(),
            body: "Cannot skip failed reply",
          })
        ).statusCode,
      ).toBe(409);
      f.provider.fail = false;
      const retried = await f.request("/messages", {
        requestId: randomUUID(),
        retryOf: payload.requestId,
      });
      expect(retried.statusCode).toBe(200);
      expect(
        retried.json().messages.filter((m: any) => m.content === payload.body),
      ).toHaveLength(1);
      expect(retried.json().usage.messages).toBe(3);
    });
  });
  it("resumes after signout and recovery without email admission and rejects stale capabilities", async () => {
    await withConversation(async (f) => {
      await f.start();
      const stale = (
        await call("/api/reporter/capability", {}, f.cookie)
      ).json().capability;
      await call("/api/reporter/session", undefined, f.cookie, "DELETE");
      expect((await f.request("", undefined, "GET", stale)).statusCode).toBe(
        401,
      );
      const login = await call("/api/reporter/session", {
        caseCode: f.receipt.caseCode,
        pin: f.receipt.pin,
      });
      expect(login.statusCode).toBe(200);
      f.cookie = cookie(login);
      expect((await f.request("")).json().messages).toHaveLength(1);
      const recovered = await call("/api/reporter/recover", {
        caseCode: f.receipt.caseCode,
        recoveryCode: f.receipt.recoveryCode,
      });
      expect(recovered.statusCode).toBe(200);
      f.cookie = cookie(recovered);
      expect((await f.request("")).json().messages).toHaveLength(1);
      expect((await f.request("", undefined, "GET", stale)).statusCode).toBe(
        401,
      );
      const rotated = await call("/api/reporter/rotate", {}, f.cookie);
      f.cookie = cookie(rotated);
      expect((await f.request("")).json().messages).toHaveLength(1);
      const foreign = (
        await call("/api/reporter/capability", {}, reporterCookie)
      ).json().capability;
      expect(
        (await f.request("", undefined, "GET", foreign)).json().messages,
      ).toEqual([]);
    });
  });
  it("enforces daily case allowances across consent renewal and resets only at the next UTC day", async () => {
    await withConversation(async (f) => {
      await f.start();
      await rows(
        vault.db,
        sql`update conversation_usage set messages=30,drafts=3 where case_id=${f.caseId}`,
      );
      for (const path of ["/messages", "/draft"])
        expect(
          (
            await f.request(path, {
              requestId: randomUUID(),
              body: "Quota test",
            })
          ).statusCode,
        ).toBe(429);
      await f.request("", undefined, "DELETE");
      expect((await f.start(true)).statusCode).toBe(429);
      await rows(
        vault.db,
        sql`update conversation_usage set day=day-1 where case_id=${f.caseId}`,
      );
      const next = await f.start(true);
      expect(next.statusCode).toBe(200);
      expect(next.json().usage).toMatchObject({ messages: 1, drafts: 0 });
    });
  });
  it("keeps AI optional, renews changed policy consent and preserves history during outages and legal holds", async () => {
    await withConversation(async (f) => {
      // A report without consent remains valid and cannot start AI implicitly.
      await rows(vault.db, sql`delete from intakes where case_id=${f.caseId}`);
      expect((await f.request("")).json().needsConsent).toBe(true);
      expect((await f.start()).json().error).toBe("ai_consent_required");
      await f.start(true);
      await rows(
        caseStore.db,
        sql`update settings set version=version+1 where id=1`,
      );
      expect((await f.request("")).json().needsConsent).toBe(true);
      expect(
        (
          await f.request("/messages", {
            requestId: randomUUID(),
            body: "No processing without renewed consent",
          })
        ).json().error,
      ).toBe("policy_changed");
      const renewed = await f.request("/start", {
        requestId: randomUUID(),
        consent: true,
        policyVersion: 2,
      });
      expect(renewed.statusCode).toBe(200);
      expect(f.requests).toHaveLength(1);
      await rows(
        caseStore.db,
        sql`update settings set body=jsonb_set(body,'{aiEnabled}','false'::jsonb) where id=1`,
      );
      expect((await f.request("")).json().messages).toHaveLength(1);
      expect(
        (
          await f.request("/messages", {
            requestId: randomUUID(),
            body: "Disabled",
          })
        ).json().error,
      ).toBe("ai_disabled");
      await rows(
        caseStore.db,
        sql`update settings set body=jsonb_set(body,'{aiEnabled}','true'::jsonb) where id=1`,
      );
      expect(
        (await f.request("/draft", { requestId: randomUUID() })).statusCode,
      ).toBe(200);
      await rows(
        caseStore.db,
        sql`update cases set hold=true where id=${f.caseId}`,
      );
      expect(
        (await f.request("/draft", undefined, "DELETE")).json().error,
      ).toBe("legal_hold");
      expect((await f.request("")).json().draft).not.toBeNull();
      expect((await f.request("", undefined, "DELETE")).json().error).toBe(
        "legal_hold",
      );
      expect((await f.request("")).json().messages).toHaveLength(1);
      await rows(
        caseStore.db,
        sql`update cases set hold=false,state='closed' where id=${f.caseId}`,
      );
      await rows(
        caseStore.db,
        sql`update settings set body=jsonb_set(body,'{aiEnabled}','true'::jsonb) where id=1`,
      );
      expect(
        (
          await f.request("/messages", {
            requestId: randomUUID(),
            body: "Closed",
          })
        ).json().error,
      ).toBe("case_closed");
      expect((await f.request("")).json().messages).toHaveLength(1);
      expect((await f.request("", undefined, "DELETE")).json()).toMatchObject({
        consented: false,
        messages: [],
        draft: null,
      });
    });
  });
  it("renews policy consent after failed initialization and recovers an expired operation lease", async () => {
    await withConversation(async (f) => {
      f.provider.fail = true;
      expect((await f.start()).statusCode).toBe(503);
      const pending = (await f.request("")).json().pending;
      await rows(caseStore.db, sql`update settings set version=2 where id=1`);
      const renewed = await f.request("/start", {
        requestId: randomUUID(),
        consent: true,
        policyVersion: 2,
      });
      expect(renewed.statusCode).toBe(200);
      expect(renewed.json()).toMatchObject({
        needsConsent: false,
        pending: { id: pending.id },
      });
      // Simulate a process dying after the persisted attempt but before completing it.
      await rows(
        vault.db,
        sql`update conversation_operations set status='running',lease_until=now()-interval '1 second' where id=${pending.id}`,
      );
      expect((await f.request("")).json().pending.retryable).toBe(true);
      f.provider.fail = false;
      const retry = await f.request("/start", {
        requestId: randomUUID(),
        retryOf: pending.id,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({
        initialized: true,
        pending: null,
        usage: { messages: 2 },
      });
      expect(retry.json().messages).toHaveLength(1);
    });
  });
  it("retires pre-submission AI while retaining legacy submitted transcripts", async () => {
    const access = await verifiedAccess();
    const retired = await privacy.inject({
      method: "POST",
      url: "/privacy/intake",
      headers: { origin, "x-csrf": "1", "x-report-access": access.reportToken },
      payload: { consent: true, policyVersion: 1, locale: "en" },
    });
    expect(retired.statusCode).toBe(410);
    await withConversation(async (f) => {
      const [r] = await rows(
        vault.db,
        sql`select id from intakes where case_id=${f.caseId}`,
      );
      await rows(
        vault.db,
        sql`update intakes set state_enc=null,transcript_enc=${seal([{ role: "user", content: "Legacy saved conversation" }], vaultRing, "intake:" + r!.id)} where id=${r!.id}`,
      );
      expect((await f.request("")).json()).toMatchObject({
        initialized: true,
        messages: [{ role: "user", content: "Legacy saved conversation" }],
      });
      await rows(
        vault.db,
        sql`update intakes set created_at=now()-interval '400 days' where id=${r!.id}`,
      );
      await rows(
        caseStore.db,
        sql`update cases set hold=true where id=${f.caseId}`,
      );
      await expirePrivate(vault.db, privacy.privacyDeps.config);
      expect((await f.request("")).json().messages).toHaveLength(1);
      await rows(
        caseStore.db,
        sql`update cases set hold=false where id=${f.caseId}`,
      );
      await expirePrivate(vault.db, privacy.privacyDeps.config);
      expect((await f.request("")).json().messages).toEqual([]);
    });
  });
  it("removes employee directory endpoints and rejects accesses to employees and employee-requests", async () => {
    expect(
      (await call("/api/admin/employees", undefined, cookies.admin)).statusCode,
    ).toBe(404);
    expect(
      (await call("/api/admin/employees/123", {}, cookies.admin, "PUT")).statusCode,
    ).toBe(404);
    expect(
      (await call("/api/admin/employee-requests", undefined, cookies.admin)).statusCode,
    ).toBe(404);
  });
  it("retries a reserved report after a failed case commit and refuses a second concurrent submission", async () => {
    counts.clear();
    const access = await verifiedAccess(),
      submission = {
        pin: token(),
        recoveryCode: token(),
        submissionToken: token(),
      },
      hash = digest(submission.submissionToken),
      hex = hash.slice(0, 32),
      id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
    // Simulate the cross-service boundary: the privacy reservation commits while the case transaction fails.
    const path = "admission/reserve",
      stamp = Date.now().toString(),
      body = {
        reportToken: access.reportToken,
        submissionHash: hash,
        caseId: id,
      };
    expect(
      (
        await privacy.inject({
          url: "/internal/" + path,
          method: "POST",
          payload: body,
          headers: {
            "x-service-time": stamp,
            "x-service-signature": mac(
              shared,
              stamp + ":" + path + ":" + JSON.stringify(body),
            ),
          },
        })
      ).statusCode,
    ).toBe(200);
    const send = (credentials: typeof submission) =>
      app.inject({
        url: "/api/reporter/reports",
        method: "POST",
        headers: {
          origin,
          "x-csrf": "1",
          "x-report-access": access.reportToken,
        },
        payload: {
          submission: credentials,
          title: "Interrupted submission test",
          summary:
            "A privacy reservation can survive an interrupted transaction in the case database.",
          category: "fraud",
          privacyReviewed: true,
          policyVersion: 1,
        },
      });
    const results = await Promise.all([
      send(submission),
      send({ pin: token(), recoveryCode: token(), submissionToken: token() }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 401]);
    expect((await send(submission)).statusCode).toBe(201);
    expect(
      await rows(
        caseStore.db,
        sql`select id from cases where submission_hash=${hash}`,
      ),
    ).toHaveLength(1);
  });
  it("chains concurrent audit events and makes history immutable", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        rows(
          caseStore.db,
          sql`insert into audit_events(actor_id,action,meta) values('test','concurrent',${JSON.stringify({ i })}::jsonb)`,
        ),
      ),
    );
    const list = await rows(
      caseStore.db,
      sql`select * from audit_events order by seq`,
    );
    for (let i = 1; i < list.length; i++)
      expect(list[i]!.previous_hash).toBe(list[i - 1]!.hash);
    await expect(
      rows(caseStore.db, sql`delete from audit_events`),
    ).rejects.toThrow();
  });
  it("preserves atomic fixed-window limits across concurrency and limiter restarts", async () => {
    const key = randomUUID(),
      make = () => postgresLimiter((q) => caseStore.db.execute(q));
    const results = await Promise.all(
      Array.from({ length: 60 }, () => make().hit(key, 12, 3600)),
    );
    expect(results.filter(Boolean)).toHaveLength(12);
    const [before] = await rows(
      caseStore.db,
      sql`select * from rate_limits where key=${"limit:" + key}`,
    );
    expect(Number(before!.hits)).toBe(60);
    expect(await make().hit(key, 12, 3600)).toBe(false);
    const [after] = await rows(
      caseStore.db,
      sql`select * from rate_limits where key=${"limit:" + key}`,
    );
    expect(after!.expires_at).toEqual(before!.expires_at);
    await rows(
      caseStore.db,
      sql`update rate_limits set expires_at=now()-interval '1 second' where key=${"limit:" + key}`,
    );
    expect(await make().hit(key, 12, 3600)).toBe(true);
    const [reset] = await rows(
      caseStore.db,
      sql`select hits from rate_limits where key=${"limit:" + key}`,
    );
    expect(Number(reset!.hits)).toBe(1);
  });
  it("imports live counters, skips expired buckets, and keeps domains isolated", async () => {
    const key = randomUUID(),
      old = randomUUID(),
      expires = new Date(Date.now() + 3600000).toISOString();
    const data = [
      { key: "limit:" + key, hits: 5, expires_at: expires },
      {
        key: "limit:" + old,
        hits: 7,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ];
    await importRateLimits((q) => caseStore.db.execute(q), data);
    await importRateLimits((q) => caseStore.db.execute(q), data);
    expect(
      await postgresLimiter((q) => caseStore.db.execute(q)).hit(key, 5, 3600),
    ).toBe(false);
    expect(
      await postgresLimiter((q) => vault.db.execute(q)).hit(key, 5, 3600),
    ).toBe(true);
    expect(
      await rows(
        caseStore.db,
        sql`select * from rate_limits where key=${"limit:" + old}`,
      ),
    ).toHaveLength(0);
    await importRateLimits((q) => caseStore.db.execute(q), data);
    const [bucket] = await rows(
      caseStore.db,
      sql`select * from rate_limits where key=${"limit:" + key}`,
    );
    expect(Number(bucket!.hits)).toBe(6);
    expect(new Date(String(bucket!.expires_at)).toISOString()).toBe(expires);
    await expect(
      importRateLimits((q) => caseStore.db.execute(q), [...data, data[0]]),
    ).rejects.toThrow();
    await expect(
      postgresLimiter(async () => {
        throw new Error("database unavailable");
      }).hit(key, 5, 60),
    ).rejects.toThrow();
  });
  it("cleans expired rate limits even before company setup", async () => {
    const key = "limit:" + randomUUID();
    await rows(
      caseStore.db,
      sql`insert into rate_limits values(${key},1,now()-interval '1 second')`,
    );
    await expire(caseStore.db);
    expect(
      await rows(caseStore.db, sql`select * from rate_limits where key=${key}`),
    ).toHaveLength(0);
  });
  it("supports ISO 37002 stakeholder relationships and open reporting", async () => {
    for (const relationship of [
      "contractor_supplier",
      "former_employee",
      "external",
      "employee",
    ] as const) {
      const submission = {
        pin: token(),
        recoveryCode: token(),
        submissionToken: token(),
      };
      const created = await call("/api/reporter/reports", {
        submission,
        title: `Misconduct concern for ${relationship}`,
        summary:
          "A stakeholder observed improper conduct during procurement and evaluation.",
        category: "corruption",
        relationship,
        privacyReviewed: true,
        policyVersion: 1,
      });
      expect(created.statusCode).toBe(201);
      const repView = await call(
        "/api/reporter/case",
        undefined,
        cookie(created),
      );
      expect(repView.statusCode).toBe(200);
      expect(repView.json().content.relationship).toBe(relationship);
    }
  });
  it("enforces ISO 37002 acknowledgment, detriment protection, procedural fairness, post-closure detriment and k-anonymous feedback analytics", async () => {
    const created = await call("/api/reporter/reports", {
      title: "Retaliation and procedural fairness test case",
      summary:
        "A detailed concern testing formal acknowledgment, detriment protection, procedural fairness, and feedback.",
      category: "harassment",
      relationship: "former_employee",
      privacyReviewed: true,
      policyVersion: 1,
    });
    expect(created.statusCode).toBe(201);
    const repCookie = cookie(created);
    const initialView = (
      await call("/api/reporter/case", undefined, repCookie)
    ).json();
    const cid = initialView.id as string;
    expect(initialView.acknowledgedAt).toBeNull();
    expect(initialView.acknowledgmentDueAt).toBeTypeOf("string");
    expect(initialView.nextFollowupDueAt).toBeTypeOf("string");

    // Formal receipt acknowledgment (Clause 8.2)
    expect(
      (await call(`/api/cases/${cid}/acknowledge`, {}, cookies.manager))
        .statusCode,
    ).toBe(200);
    const ackView = (
      await call("/api/reporter/case", undefined, repCookie)
    ).json();
    expect(ackView.acknowledgedAt).toBeTypeOf("string");

    // Detriment risk assessment requires protection plan when elevated/critical (Clause 8.3)
    expect(
      (
        await call(
          `/api/cases/${cid}/classification`,
          {
            category: "harassment",
            severity: "high",
            detrimentRisk: "elevated",
            protectionPlan: "short",
          },
          cookies.manager,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          `/api/cases/${cid}/classification`,
          {
            category: "harassment",
            severity: "high",
            detrimentRisk: "elevated",
            protectionPlan:
              "Restrict access to HR personnel files and monitor supervisor assignment changes.",
          },
          cookies.manager,
        )
      ).statusCode,
    ).toBe(200);

    // Protection plan is encrypted at rest and visible to staff, not reporter
    const staffView = (
      await call(`/api/cases/${cid}`, undefined, cookies.manager)
    ).json();
    expect(staffView.detrimentRisk).toBe("elevated");
    expect(staffView.protectionPlan).toContain("Restrict access to HR");
    const repAfterPlan = (
      await call("/api/reporter/case", undefined, repCookie)
    ).json();
    expect(repAfterPlan.detrimentRisk).toBe("elevated");
    expect(repAfterPlan.protectionPlan).toBeUndefined();

    // Feedback before closure is rejected
    expect(
      (
        await call(
          "/api/reporter/feedback",
          { trust: 5, communication: 4, protection: 5 },
          repCookie,
        )
      ).statusCode,
    ).toBe(409);

    // Transition to investigating and validate procedural fairness on substantiated closure (Clause 8.4.3)
    await call(`/api/cases/${cid}/state`, { state: "triage" }, cookies.manager);
    await call(
      `/api/cases/${cid}/state`,
      { state: "investigating" },
      cookies.manager,
    );
    expect(
      (
        await call(
          `/api/cases/${cid}/closure`,
          {
            outcome: "substantiated",
            rationale:
              "Corroborated witness statements and access logs confirm policy breach.",
            publicExplanation:
              "The investigation concluded and appropriate corrective measures were taken.",
            rootCause: "culture_leadership",
            proceduralFairness: {
              conflictChecked: true,
              subjectConfidentialityProtected: true,
              subjectResponseStatus: "not_applicable",
              subjectResponseRationale: "",
            },
          },
          cookies.manager,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          `/api/cases/${cid}/closure`,
          {
            outcome: "substantiated",
            rationale:
              "Corroborated witness statements and access logs confirm policy breach.",
            publicExplanation:
              "The investigation concluded and appropriate corrective measures were taken.",
            rootCause: "culture_leadership",
            proceduralFairness: {
              conflictChecked: true,
              subjectConfidentialityProtected: true,
              subjectResponseStatus: "heard",
              subjectResponseRationale:
                "The subject was interviewed on record and provided a written response.",
            },
          },
          cookies.manager,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          `/api/cases/${cid}/closure/review`,
          {
            approve: true,
            reason:
              "Independent review verified procedural fairness and evidence.",
          },
          cookies.manager2,
        )
      ).statusCode,
    ).toBe(200);

    // Post-closure detriment report works even when case is closed (Clauses 8.3 & 8.4.2)
    const detRes = await call(
      "/api/reporter/detriment",
      {
        body: "I was excluded from project renewals following closure of this report.",
        privacyReviewed: true,
      },
      repCookie,
    );
    expect(detRes.statusCode).toBe(201);
    const closedStaffView = (
      await call(`/api/cases/${cid}`, undefined, cookies.manager)
    ).json();
    expect(closedStaffView.detrimentFlagged).toBe(true);
    expect(closedStaffView.detrimentReports).toHaveLength(1);

    // Post-closure feedback works once and rejects duplicates (Clauses 8.5 & 9.1)
    expect(
      (
        await call(
          "/api/reporter/feedback",
          { trust: 5, communication: 4, protection: 5 },
          repCookie,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          "/api/reporter/feedback",
          { trust: 3, communication: 3, protection: 3 },
          repCookie,
        )
      ).statusCode,
    ).toBe(409);

    // Verify k-anonymity suppression (< 5 feedback entries -> empty array, >= 5 -> aggregated)
    const beforeFive = (
      await call("/api/admin/analytics", undefined, cookies.admin)
    ).json();
    expect(beforeFive.feedback).toEqual([]);
    expect(beforeFive.sla.length).toBeGreaterThan(0);
    expect(beforeFive.detriment.length).toBeGreaterThan(0);

    const extraCases = await rows(
      caseStore.db,
      sql`select id from cases where feedback is null limit 4`,
    );
    for (const ec of extraCases) {
      await rows(
        caseStore.db,
        sql`update cases set feedback=${JSON.stringify({ trust: 4, communication: 4, protection: 4 })}::jsonb where id=${ec.id}`,
      );
    }
    const afterFive = (
      await call("/api/admin/analytics", undefined, cookies.admin)
    ).json();
    expect(afterFive.feedback).toHaveLength(1);
    expect(afterFive.feedback[0].count).toBeGreaterThanOrEqual(5);
  });
});
