import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { admissionVerifySchema, continuationCodeSchema } from "@whistle/shared";
import { continuationHash } from "./continuation.js";
import {
  digest,
  mac,
  equal,
  seal,
  token,
  emailConfigured,
} from "@whistle/runtime";
import { rows, type Tx } from "./db/client.js";
import {
  csrf,
  internalAuth,
  PrivacyError,
  queue,
  caseCall,
} from "./service.js";
import type { Config } from "./config.js";
import { reserveIntake, lockIntake } from "./intake.js";

const rawToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const accessToken = (req: FastifyRequest) =>
  rawToken.safeParse(req.headers["x-report-access"]).data ?? "";
export const emailHash = (config: Config, email: string) =>
  mac(config.abuseKey, `employee:${email}`);

// All operations on a grant share a nonblocking transaction lock, including AI.
export async function grant(tx: Tx, raw: string, allowExpired = false) {
  const hash = digest(raw);
  const [lock] = await rows(
    tx,
    sql`select pg_try_advisory_xact_lock(hashtextextended(${"admission:" + hash},0)) locked`,
  );
  if (!lock?.locked) throw new PrivacyError(409, "report_busy");
  const [g] = await rows(
    tx,
    sql`select g.* from admission_grants g where g.token_hash=${hash} and g.revoked_at is null and g.reserved_at is null ${allowExpired ? sql`` : sql`and g.expires_at>now()`} for update of g`,
  );
  if (!g) throw new PrivacyError(401, "report_access_required");
  return g;
}

export async function admissionRoutes(app: FastifyInstance) {
  const { db, config, limiter } = app.privacyDeps;
  app.register(
    async (publicApi) => {
      publicApi.addHook("preHandler", async (req) => {
        csrf(req);
        if (
          !(await limiter.hit(
            mac(
              config.abuseKey,
              `admission-ip:${req.ip}:${req.routeOptions.url}`,
            ),
            req.routeOptions.url?.endsWith("/challenge") ? 60 : 100,
            3600,
          ))
        )
          throw new PrivacyError(429, "rate_limit");
      });

      publicApi.post("/challenge", async (req) => {
        const v = z
          .object({
            email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
            purpose: z.enum(["report", "request"]).default("report"),
            locale: z.enum(["en", "id"]).default("en"),
          })
          .parse(req.body);
        const hash = emailHash(config, v.email);
        if (!emailConfigured(config.email))
          throw new PrivacyError(503, "email_unavailable");
        for (const [suffix, max, seconds] of [
          ["resend", 1, 60],
          ["hour", 5, 3600],
          ["day", 20, 86400],
        ] as const)
          if (
            !(await limiter.hit(
              `admission-otp:${hash}:${suffix}`,
              max,
              seconds,
            ))
          )
            throw new PrivacyError(429, "otp_rate_limit");
        const id = randomUUID(),
          code = String(randomInt(0, 1000000)).padStart(6, "0");
        await db.transaction(async (tx) => {
          await rows(
            tx,
            sql`select pg_advisory_xact_lock(hashtextextended(${"challenge:" + hash},0))`,
          );
          await rows(
            tx,
            sql`update admission_challenges set used_at=now(),proof_hash=null where email_hash=${hash} and submitted_at is null`,
          );
          await rows(
            tx,
            sql`insert into admission_challenges(id,email_hash,email_enc,purpose,code_hash,locale,expires_at) values(${id},${hash},${seal(v.email, config.keys, "admission-challenge:" + id)},${v.purpose},${mac(config.abuseKey, id + ":" + code)},${v.locale},now()+interval '5 minutes')`,
          );
          await queue(tx, config, "admission_otp", null, {
            destination: v.email,
            kind: "email",
            code,
            locale: v.locale,
            challengeId: id,
            expiresAt: Date.now() + 300000,
          });
        });
        return {
          status: "otp",
          challengeId: id,
          expiresIn: 300,
          resendAfter: 60,
        };
      });

      publicApi.post("/verify", async (req) => {
        const v = admissionVerifySchema.parse(req.body);
        const result = await db.transaction(async (tx) => {
          const [c] = await rows(
            tx,
            sql`select * from admission_challenges where id=${v.challengeId} and used_at is null and expires_at>now() for update`,
          );
          if (!c || Number(c.attempts) >= 5) return null;
          await rows(
            tx,
            sql`update admission_challenges set attempts=attempts+1 where id=${c.id}`,
          );
          if (
            !equal(
              String(c.code_hash),
              mac(config.abuseKey, c.id + ":" + v.code),
            )
          )
            return null;
          await rows(
            tx,
            sql`update admission_challenges set used_at=now() where id=${c.id}`,
          );
          if (v.resumeToken) {
            const g = await grant(tx, v.resumeToken, true);
            await rows(
              tx,
              sql`update admission_grants set expires_at=now()+interval '2 hours' where id=${g.id}`,
            );
            return { reportToken: v.resumeToken, expiresIn: 7200 };
          }
          const id = randomUUID(),
            raw = token();
          await rows(
            tx,
            sql`insert into admission_grants(id,token_hash,expires_at) values(${id},${digest(raw)},now()+interval '2 hours')`,
          );
          return { reportToken: raw, expiresIn: 7200 };
        });
        if (!result) throw new PrivacyError(400, "invalid_or_expired_code");
        return result;
      });

      publicApi.post("/cancel", async (req) => {
        const v = z
          .object({
            reportToken: rawToken.optional(),
            challengeId: z.uuid().optional(),
          })
          .parse(req.body);
        if (v.challengeId)
          await rows(
            db,
            sql`update admission_challenges set used_at=now(),proof_hash=null where id=${v.challengeId}`,
          );
        if (v.reportToken)
          await db.transaction(async (tx) => {
            const [g] = await rows(
              tx,
              sql`select id from admission_grants where token_hash=${digest(v.reportToken!)} and reserved_at is null for update`,
            );
            if (g) {
              await rows(
                tx,
                sql`delete from intakes where admission_id=${g.id} and case_id is null`,
              );
              await rows(
                tx,
                sql`delete from admission_grants where id=${g.id}`,
              );
            }
          });
        return { ok: true };
      });
    },
    { prefix: "/privacy/admission" },
  );

  app.register(
    async (internal) => {
      internal.addHook("preHandler", internalAuth);

      internal.post("/intake/release", async (req) => {
        const v = z
          .object({
            intakeId: z.uuid(),
            intakeToken: continuationCodeSchema,
            caseId: z.uuid(),
            submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(req.body);
        await db.transaction(async (tx) => {
          await lockIntake(tx, v.intakeId);
          const [r] = await rows(
            tx,
            sql`select id from intakes where id=${v.intakeId} and token_hash=${continuationHash(config, v.intakeToken)} and case_id=${v.caseId} and submission_hash=${v.submissionHash} for update`,
          );
          if (!r) return;
          const result = (await (
            await caseCall(config, "case-exists", { caseId: v.caseId })
          ).json()) as { exists: boolean };
          if (result.exists) return;
          await rows(
            tx,
            sql`update intakes set case_id=null,submission_hash=null where id=${v.intakeId}`,
          );
          await rows(
            tx,
            sql`delete from conversation_usage where case_id=${v.caseId}`,
          );
          await rows(tx, sql`delete from contacts where case_id=${v.caseId}`);
          await rows(
            tx,
            sql`delete from delivery_jobs where case_id=${v.caseId}`,
          );
        });
        return { ok: true };
      });

      internal.post("/admission/reserve", async (req) => {
        const v = z
          .object({
            reportToken: rawToken.optional(),
            submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
            caseId: z.uuid(),
            aiConsent: z.boolean().default(false),
            policyVersion: z.number().int().positive().optional(),
            locale: z.enum(["en", "id"]).default("en"),
            intakeId: z.uuid().optional(),
            intakeToken: continuationCodeSchema.optional(),
            reporterEmail: z
              .string()
              .trim()
              .toLowerCase()
              .pipe(z.email().max(254))
              .optional(),
          })
          .parse(req.body);
        let challengeId: string | undefined;
        await db.transaction(async (tx) => {
          if (v.intakeId && !v.reportToken) {
            await reserveIntake(tx, config, {
              ...v,
              intakeId: v.intakeId,
            });
          }
          if (v.reportToken) {
            const [old] = await rows(
              tx,
              sql`select * from admission_grants where token_hash=${digest(v.reportToken)}`,
            );
            if (old?.reserved_at) {
              if (
                old.submission_hash !== v.submissionHash ||
                old.case_id !== v.caseId ||
                new Date(String(old.reserved_at)).getTime() <
                  Date.now() - 86400000
              )
                throw new PrivacyError(401, "report_access_required");
              return;
            }
            const g = await grant(tx, v.reportToken);
            if (v.intakeId) {
              const [i] = await rows(
                tx,
                sql`update intakes set case_id=${v.caseId} where id=${v.intakeId} and admission_id=${g.id} and token_hash=${v.intakeToken ? continuationHash(config, v.intakeToken) : ""} and revoked_at is null and case_id is null returning id`,
              );
              if (!i) throw new PrivacyError(409, "invalid_intake");
            } else
              await rows(
                tx,
                sql`delete from intakes where admission_id=${g.id} and case_id is null`,
              );
            await rows(
              tx,
              sql`update admission_grants set submission_hash=${v.submissionHash},case_id=${v.caseId},reserved_at=now() where id=${g.id}`,
            );
          }
          if (v.aiConsent && !v.intakeId) {
            if (!v.policyVersion)
              throw new PrivacyError(400, "validation_error");
            const id = randomUUID();
            await rows(
              tx,
              sql`insert into intakes(id,token_hash,case_id,locale,consent_version,transcript_enc) values(${id},${digest(token())},${v.caseId},${v.locale},${v.policyVersion},${seal([], config.keys, "intake:" + id)})`,
            );
          }
          if (v.reporterEmail && emailConfigured(config.email)) {
            const destination = v.reporterEmail;
            const key = mac(config.abuseKey, `${v.caseId}:${destination}`);
            const code = String(randomInt(0, 1000000)).padStart(6, "0");
            challengeId = randomUUID();
            const contactId = randomUUID();
            await rows(
              tx,
              sql`insert into contacts(id,case_id,kind,destination_enc,destination_hash,notifications,locale) values(${contactId},${v.caseId},'email',${seal(destination, config.keys, `contact:${contactId}`)},${key},true,${v.locale}) on conflict(case_id,kind) do update set destination_enc=excluded.destination_enc,destination_hash=excluded.destination_hash,notifications=excluded.notifications,locale=excluded.locale,verified_at=null,created_at=now()`,
            );
            await rows(
              tx,
              sql`update challenges set used_at=now() where contact_id=${contactId} and used_at is null`,
            );
            await rows(
              tx,
              sql`insert into challenges(id,case_id,contact_id,code_hash,expires_at) values(${challengeId},${v.caseId},${contactId},${mac(config.abuseKey, `${challengeId}:${code}`)},now()+interval '5 minutes')`,
            );
            await queue(tx, config, "otp", v.caseId, {
              destination,
              kind: "email",
              code,
              locale: v.locale,
              expiresAt: Date.now() + 300000,
            });
          }
        });
        return { ok: true, challengeId };
      });
    },
    { prefix: "/internal" },
  );
}
