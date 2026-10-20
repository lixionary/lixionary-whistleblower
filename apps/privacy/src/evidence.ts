import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { rows, type Tx } from "./db/client.js";
import { PrivacyError, evidenceAudit, queue } from "./service.js";
import { store, fileBytes, backendOf } from "./storage.js";
import { redact } from "./transform.js";

type Owner = {
  kind: "intake" | "case";
  id: string;
  closed?: boolean;
  hold?: boolean;
};
type Options = { owner: (req: FastifyRequest, tx: Tx) => Promise<Owner> };
const allowedTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const belongs = (o: Owner) =>
  o.kind === "case"
    ? sql`case_id=${o.id}`
    : sql`intake_id=${o.id} and case_id is null`;
export async function evidenceRoutes(app: FastifyInstance, { owner }: Options) {
  const { db, config, limiter } = app.privacyDeps;
  app.addHook("preHandler", async (req) => {
    await db.transaction((tx) => owner(req, tx));
  });
  const audit = async (
    tx: Tx,
    o: Owner,
    id: string,
    event: string,
    hash?: string,
  ) => {
    if (o.kind === "case")
      await evidenceAudit(tx, config, o.id, id, event, hash);
  };
  app.post("/files", async (req, reply) => {
    const identity = await db.transaction((tx) => owner(req, tx));
    if (identity.closed) throw new PrivacyError(409, "case_closed");
    if (
      !(await limiter.hit(
        `evidence-upload:${identity.kind}:${identity.id}`,
        20,
        3600,
      ))
    )
      throw new PrivacyError(429, "rate_limit");
    const f = await req.file();
    if (!f) throw new PrivacyError(400, "file_required");
    const bytes = await f.toBuffer();
    if (f.file.truncated) throw new PrivacyError(413, "file_too_large");
    const type = await fileTypeFromBuffer(bytes);
    if (!type || !allowedTypes.has(type.mime))
      throw new PrivacyError(415, "unsupported_type");
    const id = z.uuid().parse(req.headers["x-evidence-id"] ?? randomUUID());
    const hash = createHash("sha256").update(bytes).digest("hex");
    let attempted = false;
    try {
      await db.transaction(async (tx) => {
        const o = await owner(req, tx);
        if (o.closed) throw new PrivacyError(409, "case_closed");
        await rows(
          tx,
          sql`select pg_advisory_xact_lock(hashtextextended(${"evidence:" + o.kind + ":" + o.id},0))`,
        );
        await rows(
          tx,
          sql`select pg_advisory_xact_lock(hashtextextended(${"evidence-object:" + id},0))`,
        );
        const [deleting] = await rows(
          tx,
          sql`select id from evidence_deletions where id=${id}`,
        );
        if (deleting) throw new PrivacyError(409, "not_removable");
        const [existing] = await rows(
          tx,
          sql`select id,case_id,intake_id,original_sha256 from files where id=${id}`,
        );
        if (existing) {
          if (
            (o.kind === "case" ? existing.case_id : existing.intake_id) !==
              o.id ||
            existing.original_sha256 !== hash
          )
            throw new PrivacyError(409, "message_conflict");
          return;
        }
        const [quota] = await rows(
          tx,
          sql`select count(*)::int count,coalesce(sum(original_size),0)::bigint bytes from files where ${o.kind === "case" ? sql`(case_id=${o.id} or intake_id in (select id from intakes where case_id=${o.id}))` : belongs(o)}`,
        );
        if (
          Number(quota!.count) >= 20 ||
          Number(quota!.bytes) + bytes.length > 200 * 1024 * 1024
        )
          throw new PrivacyError(413, "case_file_limit");
        attempted = true;
        const path = await store(config, id, "original", bytes);
        await rows(
          tx,
          sql`insert into files(id,case_id,intake_id,storage_backend,original_path,original_sha256,original_size) values(${id},${o.kind === "case" ? o.id : null},${o.kind === "intake" ? o.id : null},${config.evidenceBackend},${path},${hash},${bytes.length})`,
        );
        await audit(tx, o, id, "evidence_uploaded", hash);
      });
    } catch (e) {
      if (attempted)
        await rows(
          db,
          sql`insert into evidence_deletions(id,storage_backend) values(${id},${config.evidenceBackend}) on conflict do nothing`,
        );
      throw e;
    }
    return reply.status(202).send({ id, status: "quarantined" });
  });
  app.get("/files", async (req) =>
    db.transaction(async (tx) => {
      const o = await owner(req, tx);
      return {
        files: await rows(
          tx,
          sql`select id,status,mime,size,pages,sha256,error_code,created_at,published_at from files where ${belongs(o)} order by created_at,id`,
        ),
      };
    }),
  );
  app.get("/files/:id/preview", async (req, reply) =>
    db.transaction(async (tx) => {
      const o = await owner(req, tx),
        id = z.uuid().parse((req.params as { id: string }).id);
      const [f] = await rows(
        tx,
        sql`select * from files where id=${id} and ${belongs(o)} and status in ('review','approved','published') for share`,
      );
      if (!f) throw new PrivacyError(404, "not_found");
      return reply
        .header("Content-Type", String(f.mime))
        .send(await fileBytes(config, id, "derivative", backendOf(f)));
    }),
  );
  app.post("/files/:id/redact", async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
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
      const o = await owner(req, tx);
      if (o.closed) throw new PrivacyError(409, "case_closed");
      const [f] = await rows(
        tx,
        sql`select * from files where id=${id} and ${belongs(o)} and status='review' for update`,
      );
      if (!f) throw new PrivacyError(409, "not_reviewable");
      const bytes = await redact(
        await fileBytes(config, id, "derivative", backendOf(f)),
        String(f.mime),
        v.rectangles,
      );
      await store(config, id, "derivative", bytes, backendOf(f));
      const hash = createHash("sha256").update(bytes).digest("hex");
      await rows(
        tx,
        sql`update files set sha256=${hash},size=${bytes.length},transformation='rasterized;metadata_removed;reporter_redacted' where id=${id}`,
      );
      await audit(tx, o, id, "evidence_redacted", hash);
    });
    return { ok: true };
  });
  app.post("/files/:id/approve", async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id),
      v = z
        .object({
          privacyReviewed: z.literal(true),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(req.body);
    await db.transaction(async (tx) => {
      const o = await owner(req, tx);
      if (o.closed) throw new PrivacyError(409, "case_closed");
      const [f] = await rows(
        tx,
        sql`select * from files where id=${id} and ${belongs(o)} and status='review' for update`,
      );
      if (!f) throw new PrivacyError(409, "not_reviewable");
      if (f.sha256 !== v.sha256) throw new PrivacyError(409, "preview_changed");
      await rows(
        tx,
        sql`update files set status='approved',approved_at=now() where id=${id}`,
      );
      await audit(tx, o, id, "evidence_approved", String(f.sha256));
      if (o.kind === "case")
        await queue(
          tx,
          config,
          "publish",
          o.id,
          { evidenceId: id },
          `publish:${id}:${f.sha256}`,
        );
    });
    return { ok: true };
  });
  app.delete("/files/:id", async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    await db.transaction(async (tx) => {
      const o = await owner(req, tx);
      if (o.hold) throw new PrivacyError(409, "legal_hold");
      const [f] = await rows(
        tx,
        sql`select * from files where id=${id} and ${belongs(o)} and status in ('review','rejected','quarantined'${sql.raw(o.kind === "intake" ? ",'approved'" : "")}) and (lease_at is null or lease_at<now()-interval '5 minutes') for update`,
      );
      if (!f) throw new PrivacyError(409, "not_removable");
      await rows(tx, sql`delete from files where id=${id}`);
      await audit(tx, o, id, "evidence_withdrawn");
      // Deletion is committed with a durable tombstone. Storage outages cannot
      // strand unowned objects after a draft is discarded or expires.
    });
    return { ok: true };
  });
}

// The reservation is not a committed case. Only this reconciler moves private
// files to case ownership, and publication still requires per-file approval.
export async function linkIntakeEvidence(
  db: import("./db/client.js").Db,
  config: import("./config.js").Config,
) {
  const pending = await rows(
    db,
    sql`select distinct i.id,i.case_id from intakes i join files f on f.intake_id=i.id where i.case_id is not null limit 100`,
  );
  for (const i of pending) {
    const exists = await (
      await import("./service.js")
    ).caseCall(config, "case-exists", { caseId: i.case_id });
    if (!((await exists.json()) as { exists: boolean }).exists) continue;
    await db.transaction(async (tx) => {
      const [current] = await rows(
        tx,
        sql`select id from intakes where id=${i.id} and case_id=${i.case_id} for update`,
      );
      if (!current) return;
      const linked = await rows(
        tx,
        sql`update files set case_id=${i.case_id},intake_id=null where intake_id=${i.id} returning id,status,sha256`,
      );
      for (const f of linked) {
        await evidenceAudit(
          tx,
          config,
          String(i.case_id),
          String(f.id),
          "evidence_uploaded",
        );
        if (f.status === "approved")
          await queue(
            tx,
            config,
            "publish",
            String(i.case_id),
            { evidenceId: f.id },
            `publish:${f.id}:${f.sha256}`,
          );
      }
    });
  }
}
