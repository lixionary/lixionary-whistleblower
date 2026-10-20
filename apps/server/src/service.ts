import { sql, type SQL } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  capability,
  digest,
  mac,
  seal,
  unseal,
  type Keyring,
} from "@whistle/runtime";
import {
  defaultSettings,
  type CompanySettings,
  type StaffIdentity,
  type SuiteReport,
  type CaseView,
} from "@whistle/shared";
import { rows, type Db, type Tx } from "./db/client.js";
import { HttpError } from "./lib/errors.js";
export type CaseRow = Record<string, unknown> & {
  id: string;
  case_code: string;
  state: CaseView["state"];
  content_enc: string;
  secret_version: number;
  team_id: string | null;
  owner_id: string | null;
  sensitive: boolean;
  hold: boolean;
  category: string;
  severity: string;
  created_at: Date;
  updated_at: Date;
  acknowledged_at?: Date | null;
  last_response_at?: Date | null;
  closed_at: Date | null;
  closure: Record<string, unknown> | null;
  detriment_risk?: CaseView["detrimentRisk"];
  protection_plan_enc?: string | null;
  detriment_flagged?: boolean;
  feedback?: Record<string, unknown> | null;
  verification_state: string;
  verified_at: Date | null;
};
export async function settings(db: Db | Tx) {
  let [row] = await rows(db, sql`select * from settings where id=1`);
  if (!row) {
    await rows(
      db,
      sql`insert into settings(id,body) values(1,${JSON.stringify(defaultSettings)}::jsonb) on conflict do nothing`,
    );
    [row] = await rows(db, sql`select * from settings where id=1`);
  }
  await rows(
    db,
    sql`insert into settings_history(version,body,actor_id) values(${row!.version},${JSON.stringify(row!.body)}::jsonb,'system') on conflict do nothing`,
  );
  return {
    version: Number(row!.version),
    configured: Boolean(row!.configured),
    body: {
      ...defaultSettings,
      ...(row!.body as CompanySettings),
    } as CompanySettings,
  };
}
export async function audit(
  db: Db | Tx,
  actor: string,
  action: string,
  caseId: string | null = null,
  meta: Record<string, unknown> = {},
) {
  await rows(db, sql`select pg_advisory_xact_lock(734592)`);
  await rows(
    db,
    sql`insert into audit_events(actor_id,action,case_id,meta) values(${actor},${action},${caseId},${JSON.stringify(meta)}::jsonb)`,
  );
}
export function access(user: StaffIdentity): SQL {
  if (user.role === "admin") return sql`false`;
  return sql`exists(select 1 from team_members eligible where eligible.team_id=c.team_id and eligible.staff_id=${user.id}::uuid) and not exists(select 1 from case_members x where x.case_id=c.id and x.staff_id=${user.id}::uuid and x.recused) and (
    exists(select 1 from case_members m where m.case_id=c.id and m.staff_id=${user.id}::uuid and not m.recused)
    or (${user.role}='manager' and exists(select 1 from team_members t where t.team_id=c.team_id and t.staff_id=${user.id}::uuid)))`;
}
export async function allowedCase(
  db: Db | Tx,
  user: StaffIdentity,
  id: string,
  lock = false,
): Promise<CaseRow> {
  const [row] = await rows<CaseRow>(
    db,
    sql`select c.* from cases c where c.id=${id}::uuid and ${access(user)} ${lock ? sql`for update` : sql``}`,
  );
  if (!row) throw new HttpError(404, "Case not found", "not_found");
  return row;
}
export function manager(user: StaffIdentity) {
  if (user.role !== "manager")
    throw new HttpError(403, "Case manager required", "forbidden");
}
export function admin(user: StaffIdentity) {
  if (user.role !== "admin")
    throw new HttpError(403, "System administrator required", "forbidden");
}
export async function viewCase(
  db: Db,
  row: CaseRow,
  keys: Keyring,
  staffView: boolean,
): Promise<Record<string, unknown>> {
  const s = await settings(db);
  const closure = row.closure_enc
    ? unseal<Record<string, unknown>>(
        String(row.closure_enc),
        keys,
        `closure:${row.id}`,
      )
    : null;
  const protectionPlan = row.protection_plan_enc
    ? unseal<string>(
        String(row.protection_plan_enc),
        keys,
        `protection:${row.id}`,
      )
    : null;
  const content = unseal<SuiteReport>(row.content_enc, keys, `case:${row.id}`);
  const messages = await rows(
    db,
    sql`select id,author,staff_id,body_enc,created_at from case_messages where case_id=${row.id} order by created_at,id`,
  );
  const records = await rows(
    db,
    sql`select * from case_records where case_id=${row.id} order by created_at`,
  );
  const decoded: Record<string, unknown>[] = records.map((x) => ({
    ...x,
    body: unseal<Record<string, unknown>>(
      String(x.body_enc),
      keys,
      `record:${x.id}`,
    ),
    body_enc: undefined,
  }));
  const files = await rows(
    db,
    sql`select id,label,mime,size,sha256,original_sha256,transformation,created_at,purged_at from evidence where case_id=${row.id}`,
  );
  const requests = await rows(
    db,
    sql`select id,reason_enc,state,created_at from verification_requests where case_id=${row.id} order by created_at desc`,
  );
  const createdMs = new Date(String(row.created_at)).getTime();
  const lastRespMs = row.last_response_at
    ? new Date(String(row.last_response_at)).getTime()
    : createdMs;
  const acknowledgmentDueAt = new Date(
    createdMs + (s.body.acknowledgmentDays ?? 7) * 86400000,
  ).toISOString();
  const nextFollowupDueAt =
    row.state === "closed"
      ? null
      : new Date(
          lastRespMs + (s.body.followupDays ?? 30) * 86400000,
        ).toISOString();
  const safe = {
    id: row.id,
    caseCode: row.case_code,
    state: row.state,
    content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at ?? null,
    acknowledgmentDueAt,
    nextFollowupDueAt,
    closedAt: row.closed_at,
    detrimentRisk: row.detriment_risk ?? "unassessed",
    detrimentFlagged: Boolean(row.detriment_flagged),
    feedback: row.feedback ?? null,
    messages: messages.map((m) => ({
      id: m.id,
      author: m.author,
      body: unseal<string>(String(m.body_enc), keys, `message:${m.id}`),
      createdAt: m.created_at,
    })),
    evidence: files,
    verification: {
      state: row.verification_state,
      verifiedAt: row.verified_at,
    },
    verificationRequests: requests.map((r) => ({
      id: r.id,
      state: r.state,
      createdAt: r.created_at,
      reason: unseal<string>(
        String(r.reason_enc),
        keys,
        `verification:${r.id}`,
      ),
    })),
    publicOutcome: row.state === "closed" ? closure?.publicExplanation : null,
    reopenRequests: decoded
      .filter((r) => r.kind === "reopen")
      .map((r) => ({ id: r.id, body: r.body, created_at: r.created_at })),
    detrimentReports: decoded
      .filter((r) => r.kind === "detriment")
      .map((r) => ({ id: r.id, body: r.body, created_at: r.created_at })),
  };
  if (!staffView) return safe;
  return {
    ...safe,
    category: row.category,
    sensitive: row.sensitive,
    severity: row.severity,
    protectionPlan,
    ownerId: row.owner_id,
    teamId: row.team_id,
    hold: row.hold,
    closure,
    notes: decoded.filter((r) => r.kind === "note"),
    findings: decoded.filter((r) => r.kind === "finding"),
    tasks: decoded.filter((r) => r.kind === "task"),
    members: await rows(
      db,
      sql`select m.staff_id,m.recused,m.subscribed,s.name,s.role from case_members m join staff s on s.id=m.staff_id where m.case_id=${row.id}`,
    ),
    audit: await rows(
      db,
      sql`select seq,id,actor_id,action,meta,created_at,hash from audit_events where case_id=${row.id} order by seq desc limit 1000`,
    ),
  };
}
export async function enqueue(
  db: Db | Tx,
  kind: string,
  caseId: string | null = null,
  body: Record<string, unknown> = {},
  staffId: string | null = null,
  dedupe: string | null = null,
) {
  await rows(
    db,
    sql`insert into jobs(kind,case_id,body,staff_id,dedupe) values(${kind},${caseId},${JSON.stringify(body)}::jsonb,${staffId},${dedupe}) on conflict(dedupe) do nothing`,
  );
}
export async function privacyCall(
  req: FastifyRequest,
  path: string,
  body: Record<string, unknown>,
) {
  const config = req.server.deps.config;
  const ts = Date.now().toString();
  const raw = JSON.stringify(body);
  const result = await fetch(`${config.privacyUrl}/internal/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-service-time": ts,
      "x-service-signature": mac(config.eventKey, `${ts}:${path}:${raw}`),
    },
    body: raw,
    signal: AbortSignal.timeout(10000),
  });
  if (!result.ok) {
    const body = (await result.json().catch(() => ({}))) as { error?: string };
    const allowed = [
      "report_access_required",
      "report_busy",
      "invalid_intake",
      "intake_expired",
      "intake_submitted",
      "policy_changed",
      "duplicate_email",
      "not_found",
      "request_resolved",
      "validation_error",
    ];
    const code = allowed.includes(body.error ?? "")
      ? body.error!
      : "privacy_unavailable";
    throw new HttpError(
      code === "privacy_unavailable" ? 503 : result.status,
      "Private service request failed",
      code,
    );
  }
  return result;
}
export function reporterCapability(
  req: FastifyRequest,
  report: CaseRow,
  sid: string,
) {
  return capability(
    {
      sub: report.id,
      sid,
      version: report.secret_version,
      purpose: "reporter",
    },
    req.server.deps.config.signingKey,
  );
}
export { seal, unseal, digest };
