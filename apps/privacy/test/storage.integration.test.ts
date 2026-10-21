import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import sharp from "sharp";
import { DeleteBucketCommand } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { defaultSettings, createContinuationCode } from "@whistle/shared";
import { token } from "@whistle/runtime";
import { createDb, rows } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { loadConfig, type Config } from "../src/config.js";
import { buildApp } from "../src/app.js";
import {
  store,
  evidenceClient,
  fileBytes,
  readSealed,
  removeFiles,
  objectKey,
} from "../src/storage.js";
import {
  migrateEvidence,
  exportEvidence,
  importEvidence,
  purgeFilesystemCopies,
} from "../src/storage-admin.js";
import { linkIntakeEvidence } from "../src/evidence.js";
import { expire, drainEvidenceDeletions, startJobs } from "../src/jobs.js";
import { transform } from "../src/transform.js";
import type { FastifyInstance } from "fastify";

const origin = "http://localhost:9551";
const suite =
  process.env.STORAGE_INTEGRATION === "1" ? describe : describe.skip;
suite("real Garage evidence lifecycle", () => {
  let config: Config,
    storage: ReturnType<typeof createDb>,
    app: FastifyInstance,
    directory: string,
    image: Buffer;
  let exists = false;
  const requests: string[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wb-evidence-storage-"));
    const ownerUrl = (
      await readFile(
        new URL("../../../.suite-dev/test-database-url", import.meta.url),
        "utf8",
      )
    ).trim();
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
    await owner.unsafe(
      "DROP DATABASE IF EXISTS whistle_evidence_storage_test WITH (FORCE)",
    );
    await owner.unsafe("CREATE DATABASE whistle_evidence_storage_test");
    await owner.end();
    const database = ownerUrl.replace(
      /\/postgres$/,
      "/whistle_evidence_storage_test",
    );
    await runMigrations(database);
    storage = createDb(database);
    config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_WEB_URL: origin,
      PRIVACY_DATABASE_URL: database,
      VAULT_KEYRING: JSON.stringify({
        active: "test",
        keys: { test: randomBytes(32).toString("base64") },
      }),
      CAPABILITY_PUBLIC_KEY: "unused",
      SERVICE_EVENT_KEY: "synthetic-service-key",
      PRIVACY_ABUSE_KEY: "synthetic-abuse-key",
      PRIVACY_STORAGE: join(directory, "vault"),
      PRIVACY_EVIDENCE_BACKEND: "s3",
      PRIVACY_S3_ENDPOINT: "http://127.0.0.1:6414",
      PRIVACY_S3_BUCKET: "whistle-evidence",
      PRIVACY_S3_ACCESS_KEY: (
        await readFile(
          new URL(
            "../../../.suite-dev/secrets/storage_access_key",
            import.meta.url,
          ),
          "utf8",
        )
      ).trim(),
      PRIVACY_S3_SECRET_KEY: (
        await readFile(
          new URL(
            "../../../.suite-dev/secrets/storage_secret_key",
            import.meta.url,
          ),
          "utf8",
        )
      ).trim(),
    });
    image = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    vi.stubGlobal("fetch", async (url: string, opts: RequestInit) => {
      requests.push(String(url));
      if (String(url).endsWith("/configuration"))
        return new Response(
          JSON.stringify({
            settings: { ...defaultSettings, aiEnabled: false },
            configured: true,
            policyVersion: 1,
          }),
        );
      if (String(url).endsWith("/case-exists"))
        return new Response(JSON.stringify({ exists }));
      if (String(url).endsWith("/retention"))
        return new Response(
          JSON.stringify({
            settings: defaultSettings,
            configured: false,
            held: [],
            deleted: [],
          }),
        );
      if (String(url).endsWith("/convert")) {
        const result = await transform(Buffer.from(opts.body as Uint8Array));
        return new Response(
          JSON.stringify({
            data: result.bytes.toString("base64"),
            mime: result.mime,
            pages: result.pages,
            transformation: result.transformation,
          }),
        );
      }
      return new Response("{}", { status: 200 });
    });
    app = await buildApp({
      db: storage.db,
      config,
      limiter: { hit: async () => true },
    });
  });
  afterAll(async () => {
    if (storage) {
      for (const f of await rows(
        storage.db,
        sql`select id,storage_backend from files`,
      ))
        await removeFiles(
          config,
          String(f.id),
          f.storage_backend === "s3" ? "s3" : "filesystem",
        );
      await storage.close();
    }
    if (app) await app.close();
    vi.unstubAllGlobals();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const call = (
    path: string,
    body?: unknown,
    code?: string,
    method?: "GET" | "POST" | "PATCH" | "DELETE",
  ) =>
    app.inject({
      url: "/privacy/intake" + path,
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        origin,
        "x-csrf": "1",
        ...(code ? { "x-intake-code": code } : {}),
      },
      payload: body as never,
    });
  async function draft() {
    const id = randomUUID(),
      code = createContinuationCode();
    expect(
      (
        await call("", {
          id,
          code,
          consent: false,
          locale: "en",
          policyVersion: 1,
        })
      ).statusCode,
    ).toBe(200);
    return { id, code };
  }
  function upload(
    id: string,
    code: string,
    bytes = image,
    file = randomUUID(),
    target = app,
  ) {
    const boundary = "wb-boundary";
    return target.inject({
      url: `/privacy/intake/${id}/files`,
      method: "POST",
      headers: {
        origin,
        "x-csrf": "1",
        "x-intake-code": code,
        "x-evidence-id": file,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private-name.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  }
  it("uploads before chat without AI, resumes, processes, redacts and approves privately before linking", async () => {
    await expect(
      evidenceClient(config).send(
        new DeleteBucketCommand({ Bucket: config.s3.bucket }),
      ),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
    const d = await draft(),
      id = randomUUID();
    expect((await upload(d.id, d.code, image, id)).statusCode).toBe(202);
    expect((await upload(d.id, d.code, image, id)).statusCode).toBe(202);
    // A lost commit acknowledgment must not let orphan cleanup erase a live file.
    await rows(
      storage.db,
      sql`insert into evidence_deletions(id,storage_backend) values(${id},'s3')`,
    );
    await drainEvidenceDeletions(storage.db, config);
    expect(await fileBytes(config, id, "original", "s3")).toEqual(image);
    expect((await call(`/${d.id}/files`, undefined, token())).statusCode).toBe(
      401,
    );
    expect(
      (await upload(d.id, d.code, Buffer.from("unsupported HTML"))).statusCode,
    ).toBe(415);
    const other = await draft();
    expect((await upload(other.id, other.code, image, id)).statusCode).toBe(
      409,
    );
    expect(await fileBytes(config, id, "original", "s3")).toEqual(image);
    expect(await readSealed(config, id, "original", "s3")).not.toContain(
      image.toString("base64"),
    );
    const stop = startJobs(storage.db, config, { error: () => {} });
    try {
      await vi.waitFor(
        async () =>
          expect(
            (
              await rows(
                storage.db,
                sql`select status from files where id=${id}`,
              )
            )[0]!.status,
          ).toBe("review"),
        { timeout: 10000 },
      );
    } finally {
      await stop();
    }
    const list = (await call(`/${d.id}/files`, undefined, d.code)).json().files;
    expect(list).toHaveLength(1);
    expect((await call("/resume", {}, d.code)).json().id).toBe(d.id);
    expect(
      (await call(`/${d.id}/files/${id}/preview`, undefined, d.code))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          `/${d.id}/files/${id}/redact`,
          { rectangles: [{ page: 1, x: 0, y: 0, width: 0.5, height: 0.5 }] },
          d.code,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          `/${d.id}/files/${id}/approve`,
          { privacyReviewed: true, sha256: list[0].sha256 },
          d.code,
        )
      ).statusCode,
    ).toBe(409);
    const sha = (
      await rows(storage.db, sql`select sha256 from files where id=${id}`)
    )[0]!.sha256;
    expect(
      (
        await call(
          `/${d.id}/files/${id}/approve`,
          { privacyReviewed: true, sha256: sha },
          d.code,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      await rows(
        storage.db,
        sql`select id from delivery_jobs where kind='publish'`,
      ),
    ).toHaveLength(0);
    const caseId = randomUUID();
    await rows(
      storage.db,
      sql`update intakes set case_id=${caseId} where id=${d.id}`,
    );
    await linkIntakeEvidence(storage.db, config);
    expect(
      (
        await rows(storage.db, sql`select case_id from files where id=${id}`)
      )[0]!.case_id,
    ).toBeNull();
    exists = true;
    await linkIntakeEvidence(storage.db, config);
    await linkIntakeEvidence(storage.db, config);
    expect(
      (
        await rows(
          storage.db,
          sql`select case_id,intake_id from files where id=${id}`,
        )
      )[0],
    ).toMatchObject({ case_id: caseId, intake_id: null });
    expect(
      await rows(
        storage.db,
        sql`select id from delivery_jobs where kind='publish'`,
      ),
    ).toHaveLength(1);
    expect(requests.some((url) => url.includes("minimax"))).toBe(false);
    exists = false;
  });
  it("expires evidence, retries unavailable deletion and deletes original and derivative objects", async () => {
    const d = await draft(),
      id = randomUUID();
    await upload(d.id, d.code, image, id);
    await store(config, id, "derivative", image, "s3");
    await rows(
      storage.db,
      sql`update intakes set created_at=now()-interval '25 hours' where id=${d.id}`,
    );
    await expire(storage.db, config);
    expect(
      await rows(storage.db, sql`select id from files where id=${id}`),
    ).toHaveLength(0);
    const bad = {
      ...config,
      s3: { ...config.s3, endpoint: "http://127.0.0.1:1" },
    };
    await drainEvidenceDeletions(storage.db, bad);
    await drainEvidenceDeletions(storage.db, bad);
    expect(
      (
        await rows(
          storage.db,
          sql`select attempts from evidence_deletions where id=${id} and storage_backend='s3'`,
        )
      )[0]!.attempts,
    ).toBe(1);
    await rows(
      storage.db,
      sql`update evidence_deletions set next_at=now() where id=${id}`,
    );
    await drainEvidenceDeletions(storage.db, config);
    await drainEvidenceDeletions(storage.db, config);
    await expect(fileBytes(config, id, "original", "s3")).rejects.toThrow(
      "storage_unavailable",
    );
    await expect(fileBytes(config, id, "derivative", "s3")).rejects.toThrow(
      "storage_unavailable",
    );
  });
  it("migrates filesystem objects with verification and round-trips encrypted backup/restore", async () => {
    const d = await draft(),
      id = randomUUID(),
      hash = createHash("sha256").update(image).digest("hex");
    const original = await store(config, id, "original", image, "filesystem"),
      derivative = await store(config, id, "derivative", image, "filesystem");
    await rows(
      storage.db,
      sql`insert into files(id,intake_id,storage_backend,original_path,derivative_path,original_sha256,sha256,original_size) values(${id},${d.id},'filesystem',${original},${derivative},${hash},${hash},${image.length})`,
    );
    expect(await migrateEvidence(storage.db, config)).toBe(1);
    expect(await migrateEvidence(storage.db, config)).toBe(0);
    expect(await fileBytes(config, id, "original", "filesystem")).toEqual(
      image,
    );
    const backup = join(directory, "backup");
    expect(
      await exportEvidence(storage.db, config, backup),
    ).toBeGreaterThanOrEqual(2);
    const manifest = JSON.parse(
      await readFile(join(backup, "manifest.json"), "utf8"),
    );
    for (const item of manifest) await removeFiles(config, item.id, "s3");
    await importEvidence(storage.db, config, backup);
    expect(await fileBytes(config, id, "original", "s3")).toEqual(image);
    expect(await fileBytes(config, id, "derivative", "s3")).toEqual(image);
    await writeFile(join(backup, "manifest.json"), "[]");
    await expect(importEvidence(storage.db, config, backup)).rejects.toThrow(
      "evidence_snapshot_incomplete",
    );
    await writeFile(join(backup, "manifest.json"), JSON.stringify(manifest));
    const blob = join(backup, objectKey(id, "original"));
    await writeFile(blob, "tampered");
    await expect(importEvidence(storage.db, config, backup)).rejects.toThrow(
      "evidence_snapshot_mismatch",
    );
  });
  it("cleans up discarded drafts and refuses storage access after discard", async () => {
    const d = await draft(),
      u = await upload(d.id, d.code);
    const id = u.json().id;
    expect(
      (await call(`/${d.id}`, undefined, d.code, "DELETE")).statusCode,
    ).toBe(200);
    expect((await call(`/${d.id}/files`, undefined, d.code)).statusCode).toBe(
      401,
    );
    await expire(storage.db, config);
    await drainEvidenceDeletions(storage.db, config);
    await drainEvidenceDeletions(storage.db, config);
    await expect(fileBytes(config, id, "original", "s3")).rejects.toThrow(
      "storage_unavailable",
    );
  });
  it("waits for an active conversion lease before expiring a draft", async () => {
    const d = await draft(),
      id = randomUUID();
    await upload(d.id, d.code, image, id);
    await rows(storage.db, sql`update files set lease_at=now() where id=${id}`);
    await rows(
      storage.db,
      sql`update intakes set created_at=now()-interval '25 hours' where id=${d.id}`,
    );
    await expire(storage.db, config);
    expect(
      await rows(storage.db, sql`select id from files where id=${id}`),
    ).toHaveLength(1);
    await rows(storage.db, sql`update files set lease_at=null where id=${id}`);
    await expire(storage.db, config);
    expect(
      await rows(storage.db, sql`select id from files where id=${id}`),
    ).toHaveLength(0);
    await drainEvidenceDeletions(storage.db, config);
    await drainEvidenceDeletions(storage.db, config);
    await expect(fileBytes(config, id, "original", "s3")).rejects.toThrow(
      "storage_unavailable",
    );
  });
  it("rotates encryption on S3 and purges verified legacy copies", async () => {
    const d = await draft(),
      id = randomUUID();
    await upload(d.id, d.code, image, id);
    const rotated = {
      ...config,
      keys: {
        active: "next",
        keys: { ...config.keys.keys, next: randomBytes(32).toString("base64") },
      },
    };
    const before = await readSealed(config, id, "original", "s3");
    await store(
      rotated,
      id,
      "original",
      await fileBytes(rotated, id, "original", "s3"),
      "s3",
    );
    expect(await readSealed(rotated, id, "original", "s3")).not.toBe(before);
    expect(await fileBytes(rotated, id, "original", "s3")).toEqual(image);
    await expect(fileBytes(config, id, "original", "s3")).rejects.toThrow();
    await store(config, id, "original", image, "s3");
    expect(await purgeFilesystemCopies(storage.db, config)).toBeGreaterThan(0);
  });
  it("keeps evidence polling separate from text access limits", async () => {
    const d = await draft(),
      hits = new Map<string, number>();
    const limited = await buildApp({
      db: storage.db,
      config,
      limiter: {
        hit: async (key, maximum) => {
          const count = (hits.get(key) ?? 0) + 1;
          hits.set(key, count);
          return count <= maximum;
        },
      },
    });
    try {
      for (let n = 0; n < 125; n++) {
        expect(
          (
            await limited.inject({
              url: `/privacy/intake/${d.id}/files`,
              headers: { "x-intake-code": d.code },
            })
          ).statusCode,
        ).toBe(200);
      }
      expect(
        (
          await limited.inject({
            url: `/privacy/intake/${d.id}`,
            method: "PATCH",
            headers: { origin, "x-csrf": "1", "x-intake-code": d.code },
            payload: { locale: "id" },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await limited.close();
    }
  });
  it("leaves text drafts usable during object-storage failure and enforces file quotas", async () => {
    const d = await draft();
    const broken = await buildApp({
      db: storage.db,
      config: {
        ...config,
        s3: { ...config.s3, endpoint: "http://127.0.0.1:1" },
      },
      limiter: { hit: async () => true },
    });
    try {
      expect(
        (await upload(d.id, d.code, image, randomUUID(), broken)).statusCode,
      ).toBe(503);
    } finally {
      await broken.close();
    }
    expect(
      (
        await call(
          `/${d.id}`,
          {
            locale: "en",
            draft: {
              title: "Report during storage outage",
              summary: "This report can continue without uploading any file.",
              category: "fraud",
            },
          },
          d.code,
          "PATCH",
        )
      ).statusCode,
    ).toBe(200);
    const id = randomUUID();
    await rows(
      storage.db,
      sql`insert into files(id,intake_id,original_path,original_sha256,original_size) values(${id},${d.id},'fixture','fixture',${200 * 1024 * 1024})`,
    );
    expect((await upload(d.id, d.code)).statusCode).toBe(413);
    await rows(
      storage.db,
      sql`update files set original_size=1 where id=${id}`,
    );
    for (let n = 1; n < 20; n++) {
      await rows(
        storage.db,
        sql`insert into files(id,intake_id,original_path,original_sha256,original_size) values(${randomUUID()},${d.id},'fixture','fixture',1)`,
      );
    }
    expect((await upload(d.id, d.code)).statusCode).toBe(413);
  });
});
