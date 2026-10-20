import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  seal,
  unseal,
  mac,
  equal,
  verifyCapability,
  type Capability,
} from "@whistle/runtime";
import type { CompanySettings } from "@whistle/shared";
import { rows, type Db, type Tx } from "./db/client.js";
import type { Config } from "./config.js";
export class PrivacyError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
  ) {
    super(code);
  }
}
export async function caseCall(
  config: Config,
  path: string,
  body: Record<string, unknown>,
) {
  const stamp = Date.now().toString(),
    raw = JSON.stringify(body);
  const response = await fetch(`${config.caseUrl}/internal/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-service-time": stamp,
      "x-service-signature": mac(config.eventKey, `${stamp}:${path}:${raw}`),
    },
    body: raw,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    const allowed = [
      "case_closed",
      "legal_hold",
      "retention_in_progress",
      "unauthorized",
    ];
    throw new PrivacyError(
      allowed.includes(body.error ?? "") ? response.status : 503,
      allowed.includes(body.error ?? "")
        ? body.error!
        : "case_service_unavailable",
    );
  }
  return response;
}
export function csrf(req: FastifyRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (
    req.headers["x-csrf"] !== "1" ||
    req.headers.origin !== new URL(req.server.privacyDeps.config.webUrl).origin
  )
    throw new PrivacyError(403, "csrf");
}
export async function authorize(req: FastifyRequest) {
  csrf(req);
  let cap: Capability;
  try {
    cap = verifyCapability(
      String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
      req.server.privacyDeps.config.publicKey,
    );
  } catch {
    throw new PrivacyError(401, "unauthorized");
  }
  if (cap.purpose !== "reporter") throw new PrivacyError(401, "unauthorized");
  const info = (await (
    await caseCall(req.server.privacyDeps.config, "introspect", {
      caseId: cap.sub,
      sid: cap.sid,
      version: cap.version,
    })
  ).json()) as {
    active: boolean;
    hold: boolean;
    state: string;
    settings: CompanySettings;
    policyVersion: number;
  };
  if (!info.active) throw new PrivacyError(401, "unauthorized");
  req.cap = cap;
  req.caseInfo = info;
}
export async function internalAuth(req: FastifyRequest) {
  const stamp = String(req.headers["x-service-time"] ?? ""),
    path = req.url.slice("/internal/".length),
    signature = String(req.headers["x-service-signature"] ?? "");
  if (
    !/^\d{13}$/.test(stamp) ||
    Math.abs(Date.now() - Number(stamp)) > 30000 ||
    !equal(
      signature,
      mac(
        req.server.privacyDeps.config.eventKey,
        `${stamp}:${path}:${JSON.stringify(req.body)}`,
      ),
    )
  )
    throw new PrivacyError(401, "unauthorized");
}
export async function queue(
  db: Db | Tx,
  config: Config,
  kind: string,
  caseId: string | null,
  body: Record<string, unknown>,
  dedupe: string | null = null,
) {
  const id = randomUUID();
  await rows(
    db,
    sql`insert into delivery_jobs(id,kind,case_id,body_enc,dedupe) values(${id},${kind},${caseId},${seal(body, config.keys, `job:${id}`)},${dedupe}) on conflict(dedupe) do nothing`,
  );
}
export { store, fileBytes, removeFiles } from "./storage.js";

export async function queueVerification(
  db: Db | Tx,
  config: Config,
  caseId: string,
  requestId: string | null = null,
) {
  const [revision] = await rows(
    db,
    sql`insert into verification_revisions(case_id,version) values(${caseId},1) on conflict(case_id) do update set version=verification_revisions.version+1 returning version`,
  );
  const [verified] = await rows(
    db,
    sql`select id from contacts where case_id=${caseId} and verified_at is not null limit 1`,
  );
  await queue(db, config, "event", caseId, {
    id: randomUUID(),
    kind: "verification",
    caseId,
    verified: !!verified,
    requestId,
    version: Number(revision!.version),
  });
}

export async function evidenceAudit(
  db: Db | Tx,
  config: Config,
  caseId: string,
  evidenceId: string,
  action: string,
  sha256?: string,
) {
  await queue(db, config, "event", caseId, {
    id: randomUUID(),
    kind: "audit",
    caseId,
    evidenceId,
    action,
    ...(sha256 ? { sha256 } : {}),
  });
}
