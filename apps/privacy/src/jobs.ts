import { linkIntakeEvidence } from "./evidence.js";
import { backendOf, EvidenceStorageError } from "./storage.js";
import { randomUUID, createHash } from "node:crypto";
import twilio from "twilio";
import { sql } from "drizzle-orm";
import { seal, unseal, safeError, createEmailSender } from "@whistle/runtime";
import type { CompanySettings } from "@whistle/shared";
import type { Db } from "./db/client.js";
import { rows } from "./db/client.js";
import type { Config } from "./config.js";
import {
  caseCall,
  fileBytes,
  store,
  removeFiles,
  queueVerification,
  PrivacyError,
  evidenceAudit,
} from "./service.js";
export function startJobs(
  db: Db,
  config: Config,
  log: { error: (o: unknown, s: string) => void },
) {
  let busy = false,
    maintaining = false,
    stopped = false;
  const mail = createEmailSender(config.email);
  const sms =
    config.twilio.sid && config.twilio.token
      ? twilio(config.twilio.sid, config.twilio.token, { timeout: 20000 })
      : null;
  async function deliver(destination: string, kind: string, text: string) {
    if (kind === "email")
      await mail.send({
        to: destination,
        subject: "Private reporting portal",
        text,
      });
    else {
      if (!sms || !config.twilio.from) throw new Error("sms_not_configured");
      await sms.messages.create({
        to: destination,
        from: config.twilio.from,
        body: text,
      });
    }
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const [j] = await rows(
        db,
        sql`update delivery_jobs set lease_at=now(),attempts=attempts+1 where id=(select id from delivery_jobs where sent_at is null and next_at<=now() and (lease_at is null or lease_at<now()-interval '5 minutes') order by next_at for update skip locked limit 1) returning *`,
      );
      if (j) {
        try {
          const b = unseal<Record<string, unknown>>(
            String(j.body_enc),
            config.keys,
            `job:${j.id}`,
          );
          if (j.kind === "admission_otp") {
            const [c] = await rows(
              db,
              sql`select id from admission_challenges where id=${b.challengeId} and used_at is null and expires_at>now()`,
            );
            if (c && Number(b.expiresAt) > Date.now())
              await deliver(
                String(b.destination),
                "email",
                b.locale === "id"
                  ? `Kode verifikasi Anda adalah ${b.code}. Berlaku 5 menit. Jangan bagikan kode kepada staf.`
                  : `Your verification code is ${b.code}. It expires in 5 minutes. Never share it with staff.`,
              );
          } else if (j.kind === "admission_decision") {
            const approved = b.decision === "approved";
            await deliver(
              String(b.destination),
              "email",
              b.locale === "id"
                ? approved
                  ? `Permintaan akses Anda disetujui. Kembali ke ${config.webUrl}/report dan verifikasi email Anda untuk membuat laporan.`
                  : "Permintaan akses Anda ditolak. Hubungi administrator perusahaan untuk informasi lebih lanjut."
                : approved
                  ? `Your access request was approved. Return to ${config.webUrl}/report and verify your email to create a report.`
                  : "Your access request was declined. Contact your company administrator for more information.",
            );
          } else if (j.kind === "directory_audit")
            await caseCall(config, "directory-audit", b);
          else if (j.kind === "otp") {
            if (Number(b.expiresAt) > Date.now())
              await deliver(
                String(b.destination),
                String(b.kind),
                b.locale === "id"
                  ? `Kode verifikasi Anda adalah ${b.code}. Berlaku 5 menit. Jangan bagikan kode kepada staf.`
                  : `Your verification code is ${b.code}. It expires in 5 minutes. Never share it with staff.`,
              );
          } else if (j.kind === "event") await caseCall(config, "events", b);
          else if (j.kind === "notify") {
            const s = (await (
              await caseCall(config, "configuration", {})
            ).json()) as { settings: CompanySettings };
            const contacts = await rows(
              db,
              sql`select * from contacts where case_id=${j.case_id} and verified_at is not null and notifications`,
            );
            for (const c of contacts)
              await deliver(
                unseal<string>(
                  String(c.destination_enc),
                  config.keys,
                  `contact:${c.id}`,
                ),
                String(c.kind),
                `${s.settings.notificationTemplates[c.locale === "id" ? "id" : "en"]}\n${config.webUrl}/case`,
              );
          } else if (j.kind === "publish") {
            await db.transaction(async (tx) => {
              const [f] = await rows(
                tx,
                sql`select * from files where id=${b.evidenceId} and status in ('approved','published') for update`,
              );
              if (!f) return;
              try {
                await caseCall(config, "events", {
                  id: String(j.id),
                  kind: "evidence",
                  caseId: f.case_id,
                  evidenceId: f.id,
                  label: "Evidence",
                  mime: f.mime,
                  size: Number(f.size),
                  sha256: f.sha256,
                  originalSha256: f.original_sha256,
                  transformation: f.transformation,
                });
                await rows(
                  tx,
                  sql`update files set status='published',published_at=now() where id=${f.id}`,
                );
              } catch (e) {
                if (e instanceof PrivacyError && e.code === "case_closed")
                  await rows(
                    tx,
                    sql`update files set status='review',approved_at=null where id=${f.id}`,
                  );
                else throw e;
              }
            });
          } else throw new Error("unknown_job");
          await rows(
            db,
            sql`update delivery_jobs set sent_at=now(),lease_at=null,body_enc=${seal({}, config.keys, `job:${j.id}`)} where id=${j.id} and lease_at=${j.lease_at}`,
          );
        } catch (e) {
          await rows(
            db,
            sql`update delivery_jobs set lease_at=null,next_at=now()+${Math.min(3600, 2 ** Math.min(Number(j.attempts), 11))}*interval '1 second',error_code='delivery_failed' where id=${j.id} and lease_at=${j.lease_at}`,
          );
          log.error(safeError(e), "private delivery failed");
        }
      }
      if (stopped) return;
      const [f] = await rows(
        db,
        sql`update files set lease_at=now() where id=(select id from files where status='quarantined' and (lease_at is null or lease_at<now()-interval '5 minutes') order by created_at for update skip locked limit 1) returning *`,
      );
      if (f) {
        try {
          const original = await fileBytes(
            config,
            String(f.id),
            "original",
            backendOf(f),
          );
          const response = await fetch(
            `${process.env.CONVERTER_ORIGIN ?? "http://127.0.0.1:6406"}/convert`,
            {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: new Uint8Array(original),
              signal: AbortSignal.timeout(150000),
            },
          );
          if (!response.ok) throw new Error("conversion_failed");
          const r = (await response.json()) as {
            data: string;
            mime: string;
            pages: number;
            transformation: string;
          };
          const bytes = Buffer.from(r.data, "base64");
          if (bytes.length > 50000000) throw new Error("size_limit");
          const derivative = await store(
            config,
            String(f.id),
            "derivative",
            bytes,
            backendOf(f),
          );
          await rows(
            db,
            sql`update files set status='review',derivative_path=${derivative},mime=${r.mime},size=${bytes.length},sha256=${createHash("sha256").update(bytes).digest("hex")},pages=${r.pages},transformation=${r.transformation},lease_at=null where id=${f.id} and lease_at=${f.lease_at}`,
          );
          if (f.case_id)
            await evidenceAudit(
              db,
              config,
              String(f.case_id),
              String(f.id),
              "evidence_processed",
              createHash("sha256").update(bytes).digest("hex"),
            );
        } catch (e) {
          if (e instanceof EvidenceStorageError) {
            await rows(
              db,
              sql`update files set lease_at=now(),error_code='storage_unavailable' where id=${f.id} and lease_at=${f.lease_at}`,
            );
          } else {
            await rows(
              db,
              sql`update files set status='rejected',error_code='conversion_failed',lease_at=null where id=${f.id} and lease_at=${f.lease_at}`,
            );
            if (f.case_id)
              await evidenceAudit(
                db,
                config,
                String(f.case_id),
                String(f.id),
                "evidence_rejected",
              );
            log.error(safeError(e), "evidence rejected");
          }
        }
      }
    } catch (e) {
      log.error(safeError(e), "private job claim failed");
    } finally {
      busy = false;
    }
  }
  const active = new Set<Promise<void>>();
  const track = (operation: Promise<void>) => {
    active.add(operation);
    void operation.finally(() => active.delete(operation));
  };
  async function maintainEvidence() {
    if (maintaining || stopped) return;
    maintaining = true;
    try {
      try {
        await linkIntakeEvidence(db, config);
      } catch (e) {
        log.error(safeError(e), "private evidence linking failed");
      }
      await drainEvidenceDeletions(db, config);
    } catch (e) {
      log.error(safeError(e), "private evidence cleanup failed");
    } finally {
      maintaining = false;
    }
  }
  const timer = setInterval(() => {
    track(tick());
    track(maintainEvidence());
  }, 2000);
  timer.unref();
  track(tick());
  track(maintainEvidence());
  const retention = setInterval(
    () =>
      track(
        expire(db, config).catch((e) =>
          log.error(safeError(e), "private retention failed"),
        ),
      ),
    60000,
  );
  retention.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(retention);
    await Promise.all(active);
    mail.close();
  };
}
export async function expire(db: Db, config: Config) {
  await rows(db, sql`delete from rate_limits where expires_at<=now()`);
  await rows(
    db,
    sql`delete from conversation_usage where day<(now() at time zone 'UTC')::date-1`,
  );
  await db.transaction(async (tx) => {
    await rows(
      tx,
      sql`delete from admission_challenges where expires_at<now()-interval '1 day'`,
    );
    await rows(
      tx,
      sql`delete from intakes where case_id is null and admission_id in (select id from admission_grants where revoked_at is not null or expires_at<now()-interval '1 day')`,
    );
    await rows(
      tx,
      sql`delete from admission_grants where (reserved_at is not null and reserved_at<now()-interval '1 day') or (reserved_at is null and (revoked_at is not null or expires_at<now()-interval '1 day'))`,
    );
  });
  // Unsubmitted intake expiry is independent of configured case retention.
  await rows(
    db,
    sql`delete from intakes i where case_id is null and (created_at<now()-interval '24 hours' or revoked_at is not null) and not exists(select 1 from files f where f.intake_id=i.id and f.lease_at>now()-interval '5 minutes')`,
  );
  const info = (await (await caseCall(config, "retention", {})).json()) as {
    settings: CompanySettings;
    configured: boolean;
    held: { id: string }[];
    deleted: { case_id: string }[];
  };
  if (!info.configured || !info.settings.retention) return;
  const held = info.held.map((x) => x.id);
  const allowed = (column: string) =>
    held.length
      ? sql`${sql.identifier(column)} not in (${sql.join(
          held.map((x) => sql`${x}`),
          sql`,`,
        )})`
      : sql`true`;
  const r = info.settings.retention;
  for (const kind of ["contacts", "transcripts", "evidence"] as const) {
    const table =
      kind === "transcripts"
        ? "intakes"
        : kind === "evidence"
          ? "files"
          : "contacts";
    const candidates = await rows(
      db,
      sql`select id,case_id,created_at,${kind === "evidence" ? sql`storage_backend` : sql`null as storage_backend`} from ${sql.identifier(table)} where case_id is not null and created_at<now()-${r[kind]}*interval '1 day' and ${allowed("case_id")} ${kind === "transcripts" ? sql`and not exists(select 1 from files where intake_id=intakes.id)` : sql``} limit 100`,
    );
    for (const row of candidates) {
      const lease = (await (
        await caseCall(config, "retention/lease", {
          caseId: row.case_id,
          kind,
          createdAt: new Date(String(row.created_at)).toISOString(),
        })
      ).json()) as { allowed: boolean; lease: string };
      if (!lease.allowed) continue;
      const deleted = await db.transaction(async (tx) => {
        const [current] = await rows(
          tx,
          sql`select id from ${sql.identifier(table)} where id=${row.id} and created_at=${row.created_at} and created_at<now()-${r[kind]}*interval '1 day' ${kind === "evidence" ? sql`and (lease_at is null or lease_at<now()-interval '5 minutes')` : sql``} for update skip locked`,
        );
        if (!current) return false;
        if (kind === "evidence")
          await removeFiles(config, String(row.id), backendOf(row));
        await rows(
          tx,
          sql`delete from ${sql.identifier(table)} where id=${row.id}`,
        );
        if (kind === "contacts")
          await queueVerification(tx, config, String(row.case_id));
        return true;
      });
      await caseCall(config, "retention/release", {
        caseId: row.case_id,
        lease: lease.lease,
        ...(deleted && kind === "evidence"
          ? { evidenceId: row.id }
          : deleted && kind === "contacts"
            ? { contactRemoved: true }
            : {}),
      });
    }
  }
  // Reservations can survive a failed main-database transaction. Reconcile
  // through the signed service boundary; a service outage preserves data.
  const reservations = await rows(
    db,
    sql`select id,case_id from intakes where case_id is not null and created_at<now()-interval '24 hours' limit 100`,
  );
  for (const i of reservations) {
    const result = (await (
      await caseCall(config, "case-exists", { caseId: i.case_id })
    ).json()) as { exists: boolean };
    if (!result.exists)
      await rows(
        db,
        sql`delete from intakes where id=${i.id} and not exists(select 1 from files where intake_id=${i.id} and lease_at>now()-interval '5 minutes')`,
      );
  }
  await rows(
    db,
    sql`delete from challenges where expires_at<now()-interval '1 day'`,
  );
  await rows(
    db,
    sql`delete from delivery_jobs where sent_at<now()-interval '7 days'`,
  );
}

export async function drainEvidenceDeletions(db: Db, config: Config) {
  await db.transaction(async (tx) => {
    const [d] = await rows(
      tx,
      sql`select * from evidence_deletions where next_at<=now() order by next_at for update skip locked limit 1`,
    );
    if (!d) return;
    await rows(
      tx,
      sql`select pg_advisory_xact_lock(hashtextextended(${"evidence-object:" + d.id},0))`,
    );
    const [live] = await rows(
      tx,
      sql`select id from files where id=${d.id} and storage_backend=${d.storage_backend}`,
    );
    if (live) {
      await rows(
        tx,
        sql`delete from evidence_deletions where id=${d.id} and storage_backend=${d.storage_backend}`,
      );
      return;
    }
    try {
      await removeFiles(config, String(d.id), backendOf(d));
      await rows(
        tx,
        sql`delete from evidence_deletions where id=${d.id} and storage_backend=${d.storage_backend}`,
      );
    } catch {
      await rows(
        tx,
        sql`update evidence_deletions set attempts=attempts+1,next_at=now()+interval '1 minute' where id=${d.id} and storage_backend=${d.storage_backend}`,
      );
    }
  });
}
