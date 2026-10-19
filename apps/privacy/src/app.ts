import { admissionRoutes } from "./admission.js";
import { conversationRoutes } from "./conversation.js";
import { intakeRoutes } from "./intake.js";
import { randomUUID, randomInt, createHash } from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  digest,
  mac,
  equal,
  seal,
  unseal,
  safeError,
  emailConfigured,
  createMinimaxClient,
  type Capability,
} from "@whistle/runtime";
import type { CompanySettings } from "@whistle/shared";
import type { Config } from "./config.js";
import { rows, type Db } from "./db/client.js";
import {
  PrivacyError,
  authorize,
  internalAuth,
  csrf,
  caseCall,
  queue,
  queueVerification,
  store,
  fileBytes,
  removeFiles,
  evidenceAudit,
} from "./service.js";
import { redact } from "./transform.js";
export interface Dependencies {
  db: Db;
  config: Config;
  limiter: { hit(key: string, max: number, seconds: number): Promise<boolean> };
}
declare module "fastify" {
  interface FastifyInstance {
    privacyDeps: Dependencies;
  }
  interface FastifyRequest {
    cap?: Capability;
    privateLease?: string;
    caseInfo?: {
      active: boolean;
      hold: boolean;
      state: string;
      settings: CompanySettings;
      policyVersion: number;
    };
  }
}
export async function buildApp(deps: Dependencies) {
  const { db, config, limiter } = deps;
  const ai = createMinimaxClient(config.ai);
  const app = Fastify({
    bodyLimit: 128 * 1024,
    trustProxy: config.trustProxy,
    logger:
      config.env === "test"
        ? false
        : {
            level: "info",
            serializers: {
              req: () => ({}),
              res: (r) => ({ statusCode: r.statusCode }),
            },
          },
  });
  app.decorate("privacyDeps", deps);
  await app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    if (
      !req.url.startsWith("/internal/") &&
      !(await limiter.hit(mac(config.abuseKey, `ip:${req.ip}`), 300, 60))
    )
      throw new PrivacyError(429, "rate_limit");
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: "not_found" }),
  );
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof PrivacyError)
      return reply.status(e.statusCode).send({ error: e.code });
    if (e instanceof z.ZodError)
      return reply.status(400).send({ error: "validation_error" });
    if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
      return reply.status(413).send({ error: "file_too_large" });
    app.log.error(safeError(e), "private request failed");
    return reply.status(500).send({ error: "internal_error" });
  });
  app.get("/privacy/health", async () => {
    await rows(db, sql`select 1`);
    return { ok: true };
  });
  app.register(
    async (api) => {
      api.addHook("preHandler", authorize);
      api.addHook("preHandler", async (req) => {
        const destructive =
          (req.method === "DELETE" &&
            [
              "/privacy/reporter/conversation",
              "/privacy/reporter/conversation/draft",
            ].includes(req.url)) ||
          (req.method === "DELETE" &&
            /^\/privacy\/reporter\/(contacts|files)\/[a-f0-9-]+$/.test(
              req.url,
            )) ||
          (req.method === "POST" &&
            req.url === "/privacy/reporter/contacts/challenge");
        if (destructive) {
          const r = (await (
            await caseCall(config, "privacy/lease", {
              caseId: req.cap!.sub,
              sid: req.cap!.sid,
              version: req.cap!.version,
            })
          ).json()) as { lease: string };
          req.privateLease = r.lease;
        }
      });
      api.addHook("onResponse", async (req) => {
        if (req.privateLease)
          try {
            await caseCall(config, "retention/release", {
              caseId: req.cap!.sub,
              lease: req.privateLease,
            });
          } catch (e) {
            app.log.error(
              safeError(e),
              "private operation lease release failed",
            );
          }
      });
      api.register(conversationRoutes);
      api.get("/contacts", async (req) => ({
        contacts: (
          await rows(
            db,
            sql`select * from contacts where case_id=${req.cap!.sub}`,
          )
        ).map((c) => ({
          id: c.id,
          kind: c.kind,
          destination: unseal(
            c.destination_enc as string,
            config.keys,
            `contact:${c.id}`,
          ),
          verifiedAt: c.verified_at,
          notifications: c.notifications,
        })),
      }));
      api.post("/contacts/challenge", async (req) => {
        const v = z
          .object({
            kind: z.enum(["email", "phone"]),
            locale: z.enum(["en", "id"]).default("en"),
            destination: z.string().min(3).max(254),
            notifications: z.boolean().default(false),
          })
          .parse(req.body);
        if (
          v.kind === "phone" &&
          (!config.twilio.sid || !config.twilio.token || !config.twilio.from)
        )
          throw new PrivacyError(503, "sms_unavailable");
        if (v.kind === "email" && !emailConfigured(config.email))
          throw new PrivacyError(503, "email_unavailable");
        const destination =
          v.kind === "email"
            ? z.email().parse(v.destination.trim().toLowerCase())
            : z
                .string()
                .regex(/^\+[1-9][0-9]{7,14}$/)
                .parse(v.destination.trim());
        const key = mac(config.abuseKey, `${req.cap!.sub}:${destination}`);
        for (const [suffix, max, secs] of [
          ["resend", 1, 60],
          ["hour", 5, 3600],
          ["day", 20, 89550],
        ] as const)
          if (!(await limiter.hit(`${key}:${suffix}`, max, secs)))
            throw new PrivacyError(429, "otp_rate_limit");
        for (const subject of [destination, req.cap!.sub])
          for (const [suffix, max, secs] of [
            ["hour", 5, 3600],
            ["day", 20, 89550],
          ] as const)
            if (
              !(await limiter.hit(
                mac(config.abuseKey, `otp:${subject}:${suffix}`),
                max,
                secs,
              ))
            )
              throw new PrivacyError(429, "otp_rate_limit");
        const code = String(randomInt(0, 1000000)).padStart(6, "0"),
          challengeId = randomUUID();
        await db.transaction(async (tx) => {
          if (req.caseInfo!.hold) throw new PrivacyError(409, "legal_hold");
          const [existing] = await rows(
            tx,
            sql`select * from contacts where case_id=${req.cap!.sub} and kind=${v.kind} for update`,
          );
          const contactId = String(existing?.id ?? randomUUID());
          await rows(
            tx,
            sql`insert into contacts(id,case_id,kind,destination_enc,destination_hash,notifications,locale) values(${contactId},${req.cap!.sub},${v.kind},${seal(destination, config.keys, `contact:${contactId}`)},${key},${v.notifications},${v.locale}) on conflict(case_id,kind) do update set destination_enc=excluded.destination_enc,destination_hash=excluded.destination_hash,notifications=excluded.notifications,locale=excluded.locale,verified_at=null,created_at=now()`,
          );
          await rows(
            tx,
            sql`update challenges set used_at=now() where contact_id=${contactId} and used_at is null`,
          );
          await rows(
            tx,
            sql`insert into challenges(id,case_id,contact_id,code_hash,expires_at) values(${challengeId},${req.cap!.sub},${contactId},${mac(config.abuseKey, `${challengeId}:${code}`)},now()+interval '5 minutes')`,
          );
          await queue(tx, config, "otp", req.cap!.sub, {
            destination,
            kind: v.kind,
            code,
            locale: v.locale,
            expiresAt: Date.now() + 300000,
          });
          await queueVerification(tx, config, req.cap!.sub);
        });
        return { challengeId, expiresIn: 300 };
      });
      api.post("/contacts/verify", async (req) => {
        const v = z
          .object({
            challengeId: z.uuid(),
            code: z.string().regex(/^\d{6}$/),
            requestId: z.uuid().nullable().default(null),
          })
          .parse(req.body);
        if (
          !(await limiter.hit(
            mac(config.abuseKey, `verify:${req.cap!.sub}`),
            5,
            300,
          ))
        )
          throw new PrivacyError(429, "otp_rate_limit");
        const verified = await db.transaction(async (tx) => {
          const [c] = await rows(
            tx,
            sql`select * from challenges where id=${v.challengeId} and case_id=${req.cap!.sub} and used_at is null and expires_at>now() for update`,
          );
          if (!c || Number(c.attempts) >= 5) return false;
          await rows(
            tx,
            sql`update challenges set attempts=attempts+1 where id=${c.id}`,
          );
          if (
            !equal(
              String(c.code_hash),
              mac(config.abuseKey, `${c.id}:${v.code}`),
            )
          )
            return false;
          await rows(
            tx,
            sql`update challenges set used_at=now() where id=${c.id}`,
          );
          await rows(
            tx,
            sql`update contacts set verified_at=now() where id=${c.contact_id}`,
          );
          await queueVerification(tx, config, req.cap!.sub, v.requestId);
          return true;
        });
        if (!verified) throw new PrivacyError(400, "invalid_or_expired_code");
        return { verified: true, meaning: "contact_control_only" };
      });
      api.patch("/contacts/:id", async (req) => {
        const p = z.object({ id: z.uuid() }).parse(req.params),
          v = z.object({ notifications: z.boolean() }).parse(req.body);
        const [c] = await rows(
          db,
          sql`update contacts set notifications=${v.notifications} where id=${p.id} and case_id=${req.cap!.sub} returning id`,
        );
        if (!c) throw new PrivacyError(404, "not_found");
        return { ok: true };
      });
      api.delete("/contacts/:id", async (req) => {
        if (req.caseInfo!.hold) throw new PrivacyError(409, "legal_hold");
        const p = z.object({ id: z.uuid() }).parse(req.params);
        await db.transaction(async (tx) => {
          await rows(
            tx,
            sql`delete from contacts where id=${p.id} and case_id=${req.cap!.sub}`,
          );
          const [other] = await rows(
            tx,
            sql`select id from contacts where case_id=${req.cap!.sub} and verified_at is not null`,
          );
          await queueVerification(tx, config, req.cap!.sub);
        });
        return { ok: true };
      });
      api.post("/files", async (req, reply) => {
        if (req.caseInfo!.state === "closed")
          throw new PrivacyError(409, "case_closed");
        if (
          !(await limiter.hit(
            mac(config.abuseKey, `upload:${req.cap!.sub}`),
            20,
            3600,
          ))
        )
          throw new PrivacyError(429, "rate_limit");
        const f = await req.file();
        if (!f) throw new PrivacyError(400, "file_required");
        const bytes = await f.toBuffer();
        if (f.file.truncated) throw new PrivacyError(413, "file_too_large");
        const id = randomUUID();
        await db.transaction(async (tx) => {
          await rows(
            tx,
            sql`select pg_advisory_xact_lock(hashtextextended(${req.cap!.sub},0))`,
          );
          const [quota] = await rows(
            tx,
            sql`select count(*)::int count,coalesce(sum(original_size),0)::bigint bytes from files where case_id=${req.cap!.sub}`,
          );
          if (
            Number(quota!.count) >= 20 ||
            Number(quota!.bytes) + bytes.length > 200 * 1024 * 1024
          )
            throw new PrivacyError(413, "case_file_limit");
          const path = await store(config, id, "original", bytes);
          try {
            await rows(
              tx,
              sql`insert into files(id,case_id,original_path,original_sha256,original_size) values(${id},${req.cap!.sub},${path},${createHash("sha256").update(bytes).digest("hex")},${bytes.length})`,
            );
            await evidenceAudit(
              tx,
              config,
              req.cap!.sub,
              id,
              "evidence_uploaded",
              createHash("sha256").update(bytes).digest("hex"),
            );
          } catch (e) {
            await removeFiles(config, id);
            throw e;
          }
        });
        return reply.status(202).send({ id, status: "quarantined" });
      });
      api.get("/files", async (req) => ({
        files: await rows(
          db,
          sql`select id,status,mime,size,pages,sha256,error_code,created_at,published_at from files where case_id=${req.cap!.sub} order by created_at`,
        ),
      }));
      api.get("/files/:id/preview", async (req, reply) => {
        const { id } = z.object({ id: z.uuid() }).parse(req.params);
        const [f] = await rows(
          db,
          sql`select * from files where id=${id} and case_id=${req.cap!.sub} and status in ('review','published')`,
        );
        if (!f) throw new PrivacyError(404, "not_found");
        return reply
          .header("Content-Type", String(f.mime))
          .send(await fileBytes(config, id, "derivative"));
      });
      api.post("/files/:id/redact", async (req) => {
        const { id } = z.object({ id: z.uuid() }).parse(req.params);
        const v = z
          .object({
            rectangles: z
              .array(
                z.object({
                  page: z.number().int().min(1).max(50),
                  x: z.number().min(0).max(1),
                  y: z.number().min(0).max(1),
                  width: z.number().positive().max(1),
                  height: z.number().positive().max(1),
                }),
              )
              .min(1)
              .max(200),
          })
          .parse(req.body);
        await db.transaction(async (tx) => {
          const [f] = await rows(
            tx,
            sql`select * from files where id=${id} and case_id=${req.cap!.sub} and status='review' for update`,
          );
          if (!f) throw new PrivacyError(409, "not_reviewable");
          const bytes = await redact(
            await fileBytes(config, id, "derivative"),
            String(f.mime),
            v.rectangles,
          );
          await store(config, id, "derivative", bytes);
          await rows(
            tx,
            sql`update files set sha256=${createHash("sha256").update(bytes).digest("hex")},size=${bytes.length},transformation='rasterized;metadata_removed;reporter_redacted' where id=${id}`,
          );
          await evidenceAudit(
            tx,
            config,
            req.cap!.sub,
            id,
            "evidence_redacted",
            createHash("sha256").update(bytes).digest("hex"),
          );
        });
        return { ok: true };
      });
      api.post("/files/:id/approve", async (req) => {
        const { id } = z.object({ id: z.uuid() }).parse(req.params);
        const approval = z
          .object({
            privacyReviewed: z.literal(true),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(req.body);
        if (req.caseInfo!.state === "closed")
          throw new PrivacyError(409, "case_closed");
        await db.transaction(async (tx) => {
          const [f] = await rows(
            tx,
            sql`select * from files where id=${id} and case_id=${req.cap!.sub} and status='review' for update`,
          );
          if (!f) throw new PrivacyError(409, "not_reviewable");
          if (f.sha256 !== approval.sha256)
            throw new PrivacyError(409, "preview_changed");
          await rows(
            tx,
            sql`update files set status='approved',approved_at=now() where id=${id}`,
          );
          await evidenceAudit(
            tx,
            config,
            req.cap!.sub,
            id,
            "evidence_approved",
            String(f.sha256),
          );
          await queue(tx, config, "publish", req.cap!.sub, { evidenceId: id });
        });
        return { ok: true };
      });
      api.delete("/files/:id", async (req) => {
        if (req.caseInfo!.hold) throw new PrivacyError(409, "legal_hold");
        const { id } = z.object({ id: z.uuid() }).parse(req.params);
        await db.transaction(async (tx) => {
          const [f] = await rows(
            tx,
            sql`select id from files where id=${id} and case_id=${req.cap!.sub} and status in ('review','rejected','quarantined') and (lease_at is null or lease_at<now()-interval '5 minutes') for update`,
          );
          if (!f) throw new PrivacyError(409, "not_removable");
          await rows(tx, sql`delete from files where id=${id}`);
          await evidenceAudit(
            tx,
            config,
            req.cap!.sub,
            id,
            "evidence_withdrawn",
          );
          await removeFiles(config, id);
        });
        return { ok: true };
      });
    },
    { prefix: "/privacy/reporter" },
  );
  await admissionRoutes(app);
  app.register(intakeRoutes, { prefix: "/privacy/intake" });
  app.register(
    async (internal) => {
      internal.addHook("preHandler", internalAuth);
      internal.post("/operations", async () => ({
        providers: {
          email: emailConfigured(config.email),
          phone: !!(
            config.twilio.sid &&
            config.twilio.token &&
            config.twilio.from
          ),
          ai: ai.enabled,
        },
        jobs: await rows(
          db,
          sql`select kind,count(*)::int pending,max(attempts)::int attempts from delivery_jobs where sent_at is null group by kind`,
        ),
        files: await rows(
          db,
          sql`select status,count(*)::int count from files group by status`,
        ),
      }));
      internal.post("/stats", async (req) => {
        const v = z
          .object({ from: z.iso.datetime(), to: z.iso.datetime() })
          .parse(req.body);
        // Counts only: no content is decrypted and nothing identifies a reporter.
        const [ai] = await rows(
          db,
          sql`with latest as (
            select distinct on (i.id) i.id,o.status,o.lease_until,o.created_at op_at
            from intakes i left join conversation_operations o on o.intake_id=i.id
            where i.case_id is not null and i.revoked_at is null
              and i.created_at>=${v.from}::timestamptz and i.created_at<${v.to}::timestamptz
            order by i.id,o.created_at desc nulls last
          )
          select count(*)::int total,
            count(*) filter(where status is null)::int not_started,
            count(*) filter(where status='failed' or (status='running' and lease_until<=now()))::int failed,
            count(*) filter(where status='running' and lease_until>now() or (status='done' and op_at>=now()-interval '7 days'))::int active,
            count(*) filter(where status='done' and op_at<now()-interval '7 days')::int idle
          from latest`,
        );
        return { ai };
      });
      internal.post("/claim", async (req) => {
        const v = z
          .object({
            caseId: z.uuid(),
            intakeId: z.uuid(),
            intakeToken: z.string(),
            eventId: z.uuid(),
          })
          .parse(req.body);
        await db.transaction(async (tx) => {
          const [erased] = await rows(
            tx,
            sql`select case_id from erased_cases where case_id=${v.caseId}`,
          );
          if (erased) throw new PrivacyError(410, "case_erased");
          const [r] = await rows(
            tx,
            sql`insert into service_receipts(id) values(${v.eventId}) on conflict do nothing returning id`,
          );
          if (!r) return;
          const [intake] = await rows(
            tx,
            sql`update intakes set case_id=${v.caseId} where id=${v.intakeId} and token_hash=${digest(v.intakeToken)} and (case_id is null or case_id=${v.caseId}) and revoked_at is null and created_at>now()-interval '24 hours' returning id`,
          );
          if (!intake) throw new PrivacyError(409, "invalid_intake");
        });
        return { ok: true };
      });
      internal.post("/notify", async (req) => {
        const v = z
          .object({ caseId: z.uuid(), eventId: z.uuid() })
          .parse(req.body);
        await queue(
          db,
          config,
          "notify",
          v.caseId,
          { eventId: v.eventId },
          `notify:${v.eventId}`,
        );
        return { ok: true };
      });
      internal.post("/evidence", async (req, reply) => {
        const v = z
          .object({ caseId: z.uuid(), evidenceId: z.uuid() })
          .parse(req.body);
        const [f] = await rows(
          db,
          sql`select * from files where case_id=${v.caseId} and id=${v.evidenceId} and status in ('approved','published') and approved_at is not null`,
        );
        if (!f) throw new PrivacyError(404, "not_found");
        return reply
          .header("Content-Type", String(f.mime))
          .send(await fileBytes(config, v.evidenceId, "derivative"));
      });
      internal.post("/delete", async (req) => {
        const v = z
          .object({ caseId: z.uuid(), eventId: z.uuid() })
          .parse(req.body);
        await erase(v.caseId);
        return { ok: true };
      });
    },
    { prefix: "/internal" },
  );
  async function erase(caseId: string) {
    await db.transaction(async (tx) => {
      await rows(
        tx,
        sql`insert into erased_cases(case_id) values(${caseId}) on conflict do nothing`,
      );
      const files = await rows(
        tx,
        sql`select id from files where case_id=${caseId} for update`,
      );
      for (const f of files) await removeFiles(config, String(f.id));
      for (const table of [
        "conversation_usage",
        "admission_grants",
        "contacts",
        "files",
        "intakes",
        "delivery_jobs",
        "verification_revisions",
      ])
        await rows(
          tx,
          sql`delete from ${sql.identifier(table)} where case_id=${caseId}`,
        );
    });
  }
  return app;
}
