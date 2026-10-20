import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { seal, unseal } from "@whistle/runtime";
import type { Config } from "./config.js";

export type EvidenceBackend = "filesystem" | "s3";
export class EvidenceStorageError extends Error {
  constructor() {
    super("storage_unavailable");
  }
}
const clients = new WeakMap<Config, S3Client>();
export function evidenceClient(config: Config) {
  let client = clients.get(config);
  if (!client) {
    client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey,
      },
      maxAttempts: 2,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    clients.set(config, client);
  }
  return client;
}
export function objectKey(id: string, kind: "original" | "derivative") {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("invalid_evidence_id");
  return `${id}.${kind}.sealed`;
}
export async function readSealed(
  config: Config,
  id: string,
  kind: "original" | "derivative",
  backend: EvidenceBackend,
) {
  const key = objectKey(id, kind);
  if (backend === "filesystem")
    return readFile(join(config.storage, key), "utf8");
  try {
    const result = await evidenceClient(config).send(
      new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(20000) },
    );
    if (!result.Body) throw new Error("missing_object_body");
    return await result.Body.transformToString();
  } catch {
    throw new EvidenceStorageError();
  }
}
export async function writeSealed(
  config: Config,
  id: string,
  kind: "original" | "derivative",
  value: string,
  backend: EvidenceBackend,
) {
  const key = objectKey(id, kind);
  if (backend === "s3") {
    try {
      await evidenceClient(config).send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: key,
          Body: value,
          ContentType: "application/octet-stream",
        }),
        { abortSignal: AbortSignal.timeout(20000) },
      );
    } catch {
      throw new EvidenceStorageError();
    }
    return key;
  }
  await mkdir(config.storage, { recursive: true, mode: 0o700 });
  const path = join(config.storage, key),
    temporary = path + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return path;
}
export async function store(
  config: Config,
  id: string,
  kind: "original" | "derivative",
  bytes: Buffer,
  backend: EvidenceBackend = config.evidenceBackend,
) {
  return writeSealed(
    config,
    id,
    kind,
    seal(bytes.toString("base64"), config.keys, `file:${id}:${kind}`),
    backend,
  );
}
export async function fileBytes(
  config: Config,
  id: string,
  kind: "original" | "derivative",
  backend: EvidenceBackend = "filesystem",
) {
  return Buffer.from(
    unseal<string>(
      await readSealed(config, id, kind, backend),
      config.keys,
      `file:${id}:${kind}`,
    ),
    "base64",
  );
}
export async function removeFiles(
  config: Config,
  id: string,
  backend: EvidenceBackend = "filesystem",
) {
  for (const kind of ["original", "derivative"] as const) {
    const key = objectKey(id, kind);
    if (backend === "filesystem")
      await unlink(join(config.storage, key)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    else
      try {
        await evidenceClient(config).send(
          new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }),
          { abortSignal: AbortSignal.timeout(20000) },
        );
      } catch {
        throw new EvidenceStorageError();
      }
  }
}
export const backendOf = (file: Record<string, unknown>): EvidenceBackend =>
  file.storage_backend === "s3" ? "s3" : "filesystem";
