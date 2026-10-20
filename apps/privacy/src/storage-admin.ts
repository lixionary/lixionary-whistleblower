import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { unseal } from "@whistle/runtime";
import { rows, type Db } from "./db/client.js";
import type { Config } from "./config.js";
import { readSealed, writeSealed, objectKey } from "./storage.js";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function migrateEvidence(db: Db, config: Config) {
  let migrated = 0;
  for (;;) {
    const [candidate] = await rows(
      db,
      sql`select id from files where storage_backend='filesystem' and (lease_at is null or lease_at<now()-interval '5 minutes') limit 1`,
    );
    if (!candidate) break;
    const done = await db.transaction(async (tx) => {
      await rows(
        tx,
        sql`select pg_advisory_xact_lock(hashtextextended(${"evidence-object:" + candidate.id},0))`,
      );
      const [f] = await rows(
        tx,
        sql`select * from files where id=${candidate.id} and storage_backend='filesystem' and (lease_at is null or lease_at<now()-interval '5 minutes') for update skip locked`,
      );
      if (!f) return false;
      const id = String(f.id);
      for (const kind of ["original", "derivative"] as const) {
        if (kind === "derivative" && !f.derivative_path) continue;
        const value = await readSealed(config, id, kind, "filesystem");
        const bytes = Buffer.from(
          unseal<string>(value, config.keys, `file:${id}:${kind}`),
          "base64",
        );
        if (
          createHash("sha256").update(bytes).digest("hex") !==
          (kind === "original" ? f.original_sha256 : f.sha256)
        )
          throw new Error("evidence_checksum_mismatch");
        await writeSealed(config, id, kind, value, "s3");
        if (hash(await readSealed(config, id, kind, "s3")) !== hash(value))
          throw new Error("evidence_copy_mismatch");
      }
      await rows(
        tx,
        sql`update files set storage_backend='s3',original_path=${objectKey(id, "original")},derivative_path=${f.derivative_path ? objectKey(id, "derivative") : null} where id=${id}`,
      );
      return true;
    });
    if (!done) break;
    migrated++;
  }
  return migrated;
}
const manifestSchema = z.array(
  z.object({
    id: z.uuid(),
    kind: z.enum(["original", "derivative"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);
export async function exportEvidence(
  db: Db,
  config: Config,
  directory: string,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest: z.infer<typeof manifestSchema> = [];
  // Writers must be quiesced by the snapshot procedure, as for the database dumps.
  for (const f of await rows(
    db,
    sql`select id,derivative_path from files where storage_backend='s3' order by id`,
  )) {
    for (const kind of ["original", "derivative"] as const) {
      if (kind === "derivative" && !f.derivative_path) continue;
      const id = String(f.id),
        value = await readSealed(config, id, kind, "s3");
      await writeFile(join(directory, objectKey(id, kind)), value, {
        mode: 0o600,
      });
      manifest.push({ id, kind, sha256: hash(value) });
    }
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest), {
    mode: 0o600,
  });
  return manifest.length;
}
export async function importEvidence(
  db: Db,
  config: Config,
  directory: string,
) {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
  );
  const records = await rows(
    db,
    sql`select id,derivative_path,original_sha256,sha256 from files where storage_backend='s3'`,
  );
  const expected = new Set(
    records.flatMap((f) => [
      `${f.id}:original`,
      ...(f.derivative_path ? [`${f.id}:derivative`] : []),
    ]),
  );
  const provided = new Set(
    manifest.map((entry) => `${entry.id}:${entry.kind}`),
  );
  if (
    provided.size !== manifest.length ||
    provided.size !== expected.size ||
    [...expected].some((key) => !provided.has(key))
  )
    throw new Error("evidence_snapshot_incomplete");
  // Validate every blob before performing any writes.
  for (const entry of manifest) {
    const value = await readFile(
      join(directory, objectKey(entry.id, entry.kind)),
      "utf8",
    );
    if (hash(value) !== entry.sha256)
      throw new Error("evidence_snapshot_mismatch");
    const [f] = await rows(
      db,
      sql`select id,original_sha256,sha256 from files where id=${entry.id} and storage_backend='s3'`,
    );
    if (!f) throw new Error("evidence_snapshot_owner_missing");
    const bytes = Buffer.from(
      unseal<string>(value, config.keys, `file:${entry.id}:${entry.kind}`),
      "base64",
    );
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      (entry.kind === "original" ? f.original_sha256 : f.sha256)
    )
      throw new Error("evidence_snapshot_content_mismatch");
  }
  for (const entry of manifest) {
    const value = await readFile(
      join(directory, objectKey(entry.id, entry.kind)),
      "utf8",
    );
    await writeSealed(config, entry.id, entry.kind, value, "s3");
    if (
      hash(await readSealed(config, entry.id, entry.kind, "s3")) !==
      entry.sha256
    )
      throw new Error("evidence_restore_mismatch");
  }
  return manifest.length;
}

export async function purgeFilesystemCopies(db: Db, config: Config) {
  const { removeFiles } = await import("./storage.js");
  let purged = 0;
  for (const f of await rows(
    db,
    sql`select * from files where storage_backend='s3'`,
  )) {
    const id = String(f.id);
    for (const kind of ["original", "derivative"] as const) {
      if (kind === "derivative" && !f.derivative_path) continue;
      const value = await readSealed(config, id, kind, "s3");
      const bytes = Buffer.from(
        unseal<string>(value, config.keys, `file:${id}:${kind}`),
        "base64",
      );
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        (kind === "original" ? f.original_sha256 : f.sha256)
      )
        throw new Error("evidence_checksum_mismatch");
    }
    await removeFiles(config, id, "filesystem");
    purged++;
  }
  return purged;
}
