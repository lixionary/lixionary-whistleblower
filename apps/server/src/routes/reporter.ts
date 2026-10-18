import type { FastifyPluginAsync } from "fastify";
import { sql } from "drizzle-orm";
import { randomUUID, randomInt } from "node:crypto";
import { z } from "zod";
import {
  suiteReportSchema,
  submissionSecretsSchema,
  reporterFeedbackSchema,
} from "@whistle/shared";
import {
  checkSecret,
  checkNormalizedSecret,
  hashSecret,
  normalizeSecret,
  generateCrockford,
  token,
  digest,
  seal,
  unseal,
  mac,
} from "@whistle/runtime";
import { rows } from "../db/client.js";
import {
  csrf,
  REPORTER_COOKIE,
  requireReporter,
  createReporterSession,
} from "../auth.js";
import {
  audit,
  enqueue,
  settings,
  viewCase,
  reporterCapability,
  privacyCall,
  type CaseRow,
} from "../service.js";
import { HttpError } from "../lib/errors.js";
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const code = () =>
  "WB-" +
  Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)])
    .join("")
    .replace(/(.{4})(.{4})/, "$1-$2");
const credentials = z.object({
  caseCode: z
    .string()
    .toUpperCase()
    .regex(/^WB-[0-9A-Z]{4}-[0-9A-Z]{4}$/),
  pin: z.string().min(6).max(200),
});
export const reporterRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, limiter } = app.deps;
  app.get("/company", async () => {
    const s = await settings(db);
    return {
      version: s.version,
      companyName: s.body.companyName,
      policy: s.body.policy,
      privacyNotice: s.body.privacyNotice,
      categories: s.body.categories,
      businessUnits: s.body.businessUnits,
      aiEnabled: s.body.aiEnabled,
    };
  });
  app.post("/reports", async (req, reply) => {
    csrf(req);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(String(req.headers["x-report-access"] ?? ""))
    )
      throw new HttpError(
        401,
        "Employee verification required",
        "report_access_required",
      );
    if (
      !(await limiter.hit(mac(config.abuseKey, "submit:" + req.ip), 10, 3600))
    )
      throw new HttpError(429, "Limit", "rate_limit");
    const v = suiteReportSchema.parse(req.body);
    const s = await settings(db);
    if (config.production && !s.configured)
      throw new HttpError(503, "Setup required", "setup_required");
    // Retry credentials stay in browser memory. Only their hashes persist.
    const retry = submissionSecretsSchema.parse(
      (req.body as { submission?: unknown }).submission,
    );
    const submissionHash = retry ? digest(retry.submissionToken) : null;
    const hex = submissionHash?.slice(0, 32);
    const id = hex
      ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
      : randomUUID();
    const pin = retry?.pin ?? generateCrockford(2, 4),
      recoveryCode = retry?.recoveryCode ?? generateCrockford(4, 4);
    const row = await db.transaction(async (tx) => {
      if (submissionHash) {
        const [erased] = await rows(
          tx,
          sql`select case_id from deletion_manifest where case_id=${id}`,
        );
        if (erased)
          throw new HttpError(410, "Submission expired", "submission_expired");
        await rows(
          tx,
          sql`select pg_advisory_xact_lock(hashtextextended(${submissionHash},0))`,
        );
        const [existing] = await rows<
          CaseRow & { pin_hash: string; recovery_hash: string }
        >(tx, sql`select * from cases where submission_hash=${submissionHash}`);
        if (existing) {
          if (
            !(await checkNormalizedSecret(existing.pin_hash, pin)) ||
            !(await checkNormalizedSecret(existing.recovery_hash, recoveryCode))
          )
            throw new HttpError(
              409,
              "Retry credentials changed",
              "submission_conflict",
            );
          await privacyCall(req, "admission/reserve", {
            reportToken: String(req.headers["x-report-access"] ?? ""),
            submissionHash: submissionHash!,
            caseId: id,
          });
          return existing;
        }
      }
      if (v.policyVersion !== s.version)
        throw new HttpError(409, "Review current policy", "policy_changed");
      if (
        !s.body.categories.some((c) => c.key === v.category) ||
        (v.businessUnit && !s.body.businessUnits.includes(v.businessUnit))
      )
        throw new HttpError(
          400,
          "Invalid category or unit",
          "validation_error",
        );
      await privacyCall(req, "admission/reserve", {
        reportToken: String(req.headers["x-report-access"] ?? ""),
        submissionHash: submissionHash!,
        caseId: id,
        aiConsent: v.aiConsent,
        policyVersion: v.policyVersion,
        locale: v.locale,
        ...(v.intakeId
          ? { intakeId: v.intakeId, intakeToken: v.intakeToken }
          : {}),
      });
      const [r] = await rows<CaseRow>(
        tx,
        sql`insert into cases(id,case_code,pin_hash,recovery_hash,submission_hash,content_enc,category,sensitive,team_id) values(${id},${code()},${await hashSecret(normalizeSecret(pin))},${await hashSecret(normalizeSecret(recoveryCode))},${submissionHash},${seal({ ...v, aiConsent: undefined, intakeId: undefined, intakeToken: undefined }, config.keys, "case:" + id)},${v.category},${v.sensitive},${v.sensitive ? s.body.restrictedTeamId : s.body.defaultTeamId}) returning *`,
      );
      await audit(tx, "reporter", "report_submitted", id, {
        policyVersion: s.version,
      });
      await enqueue(tx, "staff_alert", id, { event: "received" });
      return r!;
    });
    const sid = await createReporterSession(req, reply, row);
    return reply.status(201).send({
      caseCode: row.case_code,
      pin,
      recoveryCode,
      capability: reporterCapability(req, row, sid),
    });
  });
  app.post("/session", async (req, reply) => {
    csrf(req);
    const v = credentials.parse(req.body);
    if (!(await limiter.hit("case-login:" + digest(v.caseCode), 10, 900)))
      throw new HttpError(429, "Limit", "rate_limit");
    const [r] = await rows<CaseRow & { pin_hash: string }>(
      db,
      sql`select * from cases where case_code=${v.caseCode}`,
    );
    if (!(await checkNormalizedSecret(r?.pin_hash, v.pin)))
      throw new HttpError(401, "Invalid credentials", "invalid_credentials");
    await createReporterSession(req, reply, r!);
    return { ok: true };
  });
  app.delete(
    "/session",
    { preHandler: requireReporter },
    async (req, reply) => {
      await rows(
        db,
        sql`delete from reporter_sessions where id=${req.reporterSessionId!}`,
      );
      reply.clearCookie(REPORTER_COOKIE, { path: "/" });
      return { ok: true };
    },
  );
  app.get("/case", { preHandler: requireReporter }, async (req) => {
    await rows(
      db,
      sql`update reporter_sessions set read_at=now() where id=${req.reporterSessionId!}`,
    );
    return viewCase(db, req.reporter!, config.keys, false);
  });
  app.post("/capability", { preHandler: requireReporter }, (req) => ({
    capability: reporterCapability(req, req.reporter!, req.reporterSessionId!),
  }));
  app.post("/messages", { preHandler: requireReporter }, async (req, reply) => {
    const { body, clientMessageId } = z
      .object({
        clientMessageId: z.uuid().optional(),
        body: z.string().trim().min(1).max(10000),
        privacyReviewed: z.literal(true),
      })
      .parse(req.body);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      const [c] = await rows(
        tx,
        sql`select state from cases where id=${req.reporter!.id} for update`,
      );
      if (clientMessageId) {
        const [existing] = await rows(
          tx,
          sql`select body_enc,id from case_messages where case_id=${req.reporter!.id} and client_message_id=${clientMessageId}`,
        );
        if (existing) {
          if (
            unseal<string>(
              String(existing.body_enc),
              config.keys,
              "message:" + existing.id,
            ) !== body
          )
            throw new HttpError(
              409,
              "Retry content changed",
              "message_conflict",
            );
          return;
        }
      }
      if (c!.state === "closed")
        throw new HttpError(409, "Case closed", "case_closed");
      await rows(
        tx,
        sql`insert into case_messages(id,case_id,author,body_enc,client_message_id) values(${id},${req.reporter!.id},'reporter',${seal(body, config.keys, "message:" + id)},${clientMessageId ?? null})`,
      );
      await rows(
        tx,
        sql`update cases set updated_at=now() where id=${req.reporter!.id}`,
      );
      await audit(tx, "reporter", "reporter_message", req.reporter!.id);
      await enqueue(tx, "staff_alert", req.reporter!.id, { event: "reply" });
    });
    return reply.status(201).send({ ok: true });
  });
  app.post("/reopen", { preHandler: requireReporter }, async (req) => {
    const { reason } = z
      .object({ reason: z.string().trim().min(10).max(4000) })
      .parse(req.body);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      const [c] = await rows(
        tx,
        sql`select state from cases where id=${req.reporter!.id} for update`,
      );
      if (c?.state !== "closed")
        throw new HttpError(409, "Not closed", "invalid_transition");
      await rows(
        tx,
        sql`insert into case_records(id,case_id,kind,body_enc) values(${id},${req.reporter!.id},'reopen',${seal({ reason }, config.keys, "record:" + id)})`,
      );
      await audit(tx, "reporter", "reopening_requested", req.reporter!.id);
      await enqueue(tx, "staff_alert", req.reporter!.id, { event: "reopen" });
    });
    return { ok: true };
  });
  app.post(
    "/detriment",
    { preHandler: requireReporter },
    async (req, reply) => {
      const { body } = z
        .object({
          body: z.string().trim().min(10).max(10000),
          privacyReviewed: z.literal(true),
        })
        .parse(req.body);
      const id = randomUUID();
      await db.transaction(async (tx) => {
        await rows(
          tx,
          sql`insert into case_records(id,case_id,kind,body_enc) values(${id},${req.reporter!.id},'detriment',${seal({ text: body }, config.keys, "record:" + id)})`,
        );
        await rows(
          tx,
          sql`update cases set detriment_flagged=true,updated_at=now() where id=${req.reporter!.id}`,
        );
        await audit(tx, "reporter", "detriment_reported", req.reporter!.id);
        await enqueue(tx, "staff_alert", req.reporter!.id, {
          event: "detriment",
        });
      });
      return reply.status(201).send({ id });
    },
  );
  app.post("/feedback", { preHandler: requireReporter }, async (req) => {
    const v = reporterFeedbackSchema.parse(req.body);
    await db.transaction(async (tx) => {
      const [c] = await rows(
        tx,
        sql`select state,feedback from cases where id=${req.reporter!.id} for update`,
      );
      if (c?.state !== "closed")
        throw new HttpError(409, "Not closed", "invalid_transition");
      if (c.feedback)
        throw new HttpError(409, "Feedback exists", "feedback_exists");
      await rows(
        tx,
        sql`update cases set feedback=${JSON.stringify({ ...v, submittedAt: new Date().toISOString() })}::jsonb,updated_at=now() where id=${req.reporter!.id}`,
      );
      await audit(
        tx,
        "reporter",
        "reporter_feedback_submitted",
        req.reporter!.id,
      );
    });
    return { ok: true };
  });
  app.post(
    "/verification/:id/decline",
    { preHandler: requireReporter },
    async (req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      await db.transaction(async (tx) => {
        const [r] = await rows(
          tx,
          sql`update verification_requests set state='declined' where id=${id} and case_id=${req.reporter!.id} and state='pending' returning id`,
        );
        if (!r)
          throw new HttpError(409, "Request changed", "invalid_transition");
        await rows(
          tx,
          sql`update cases set verification_state=case when verified_at is null then 'none' else 'verified' end where id=${req.reporter!.id}`,
        );
        await audit(tx, "reporter", "verification_declined", req.reporter!.id);
        await enqueue(tx, "staff_alert", req.reporter!.id, {
          event: "verification_declined",
        });
      });
      return { ok: true };
    },
  );
  app.post("/recover", async (req, reply) => {
    csrf(req);
    const v = z
      .object({
        caseCode: credentials.shape.caseCode,
        recoveryCode: z.string().min(8).max(200),
      })
      .parse(req.body);
    if (!(await limiter.hit("recover:" + digest(v.caseCode), 5, 900)))
      throw new HttpError(429, "Limit", "rate_limit");
    const pin = generateCrockford(2, 4),
      recoveryCode = generateCrockford(4, 4);
    const row = await db.transaction(async (tx) => {
      const [r] = await rows<CaseRow & { recovery_hash: string }>(
        tx,
        sql`select * from cases where case_code=${v.caseCode} for update`,
      );
      if (!(await checkNormalizedSecret(r?.recovery_hash, v.recoveryCode)))
        throw new HttpError(401, "Invalid credentials", "invalid_credentials");
      const [next] = await rows<CaseRow>(
        tx,
        sql`update cases set pin_hash=${await hashSecret(normalizeSecret(pin))},recovery_hash=${await hashSecret(normalizeSecret(recoveryCode))},secret_version=secret_version+1 where id=${r!.id} returning *`,
      );
      await rows(tx, sql`delete from reporter_sessions where case_id=${r!.id}`);
      await audit(tx, "reporter", "reporter_access_recovered", r!.id);
      return next!;
    });
    await createReporterSession(req, reply, row);
    return { caseCode: row.case_code, pin, recoveryCode };
  });
  app.post("/rotate", { preHandler: requireReporter }, async (req, reply) => {
    const pin = generateCrockford(2, 4),
      recoveryCode = generateCrockford(4, 4);
    const row = await db.transaction(async (tx) => {
      const [r] = await rows<CaseRow>(
        tx,
        sql`update cases set pin_hash=${await hashSecret(normalizeSecret(pin))},recovery_hash=${await hashSecret(normalizeSecret(recoveryCode))},secret_version=secret_version+1 where id=${req.reporter!.id} and secret_version=${req.reporter!.secret_version} returning *`,
      );
      await rows(
        tx,
        sql`delete from reporter_sessions where case_id=${req.reporter!.id}`,
      );
      await audit(tx, "reporter", "reporter_secrets_rotated", req.reporter!.id);
      if (!r) throw new HttpError(401, "Session revoked", "unauthorized");
      return r;
    });
    await createReporterSession(req, reply, row);
    return { caseCode: row.case_code, pin, recoveryCode };
  });
};
