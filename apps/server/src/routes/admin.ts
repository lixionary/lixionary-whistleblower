import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  settingsSchema,
  staffRoles,
  type CaseState,
  type DashboardData,
} from "@whistle/shared";
import { hashSecret, token } from "@whistle/runtime";
import { requireStaff } from "../auth.js";
import { rows } from "../db/client.js";
import {
  admin,
  audit,
  digest,
  enqueue,
  seal,
  settings,
  access,
  privacyCall,
} from "../service.js";
import { HttpError } from "../lib/errors.js";
import {
  limitPasswordReset,
  queuePasswordReset,
} from "../staff-password-reset.js";
export async function adminRoutes(app: FastifyInstance) {
  const { db, config, limiter } = app.deps;
  app.addHook("preHandler", requireStaff);
  app.get("/analytics", async (req) => {
    const predicate =
      req.staff!.role === "admin" ? sql`true` : access(req.staff!);
    const s = await settings(db);
    const groups = await rows(
      db,
      sql`select c.state,count(*)::int count,round(avg(extract(epoch from (coalesce(c.closed_at,now())-c.created_at))/89550)::numeric,1) average_days,case when count(c.acknowledged_at)>=5 then round(avg(extract(epoch from (c.acknowledged_at-c.created_at))/89550)::numeric,1) end acknowledgment_days from cases c where ${predicate} group by c.state having count(*)>=5`,
    );
    const outcomes = await rows(
      db,
      sql`select c.closure->>'outcome' outcome,count(*)::int count from cases c where c.state='closed' and ${predicate} group by c.closure->>'outcome' having count(*)>=5`,
    );
    const rootCauses = await rows(
      db,
      sql`select coalesce(c.closure->>'rootCause','not_applicable') root_cause,count(*)::int count from cases c where c.state='closed' and ${predicate} group by coalesce(c.closure->>'rootCause','not_applicable') having count(*)>=5`,
    );
    const correctiveActions = await rows(
      db,
      sql`select count(*)::int total,count(r.completed_at)::int completed from case_records r join cases c on c.id=r.case_id where r.kind='task' and ${predicate} having count(distinct c.id)>=5`,
    );
    const sla = await rows(
      db,
      sql`select count(*)::int total,count(*) filter(where c.acknowledged_at is not null and c.acknowledged_at<=c.created_at+${s.body.acknowledgmentDays}*interval '1 day')::int within_acknowledgment_sla,count(*) filter(where c.state<>'closed' and (c.acknowledged_at is null and c.created_at<now()-${s.body.acknowledgmentDays}*interval '1 day' or coalesce(c.last_response_at,c.created_at)<now()-${s.body.followupDays}*interval '1 day'))::int overdue from cases c where ${predicate} having count(*)>=5`,
    );
    const detriment = await rows(
      db,
      sql`select count(*)::int total,count(*) filter(where c.detriment_risk in ('elevated','critical'))::int elevated_or_critical,count(*) filter(where c.detriment_flagged)::int flagged from cases c where ${predicate} having count(*)>=5`,
    );
    const feedback = await rows(
      db,
      sql`select count(*)::int count,round(avg((c.feedback->>'trust')::numeric),1) trust,round(avg((c.feedback->>'communication')::numeric),1) communication,round(avg((c.feedback->>'protection')::numeric),1) protection from cases c where c.feedback is not null and ${predicate} having count(*)>=5`,
    );
    await audit(db, req.staff!.id, "aggregate_metrics_viewed");
    return {
      groups,
      outcomes,
      rootCauses,
      correctiveActions,
      sla,
      detriment,
      feedback,
      suppressionThreshold: 5,
    };
  });
  app.register(async (a) => {
    a.addHook("preHandler", async (req) => admin(req.staff!));
    a.get("/settings", async () => settings(db));
    a.put("/settings", async (req) => {
      const v = settingsSchema.parse(req.body);
      await settings(db);
      await db.transaction(async (tx) => {
        if (!v.retention || !v.defaultTeamId || !v.restrictedTeamId)
          throw new HttpError(
            400,
            "Configuration incomplete",
            "configuration_incomplete",
          );
        const teams = await rows(
          tx,
          sql`select * from teams where id in (${v.defaultTeamId},${v.restrictedTeamId})`,
        );
        if (
          !teams.some((t) => t.id === v.defaultTeamId && !t.restricted) ||
          !teams.some((t) => t.id === v.restrictedTeamId && t.restricted)
        )
          throw new HttpError(400, "Invalid teams", "invalid_teams");
        const overlap = await rows(
          tx,
          sql`select a.staff_id from team_members a join team_members b on a.staff_id=b.staff_id where a.team_id=${v.defaultTeamId} and b.team_id=${v.restrictedTeamId}`,
        );
        if (overlap.length)
          throw new HttpError(400, "Independent team required", "team_overlap");
        for (const team of [v.defaultTeamId, v.restrictedTeamId]) {
          const [n] = await rows(
            tx,
            sql`select count(*)::int n from team_members t join staff s on s.id=t.staff_id where t.team_id=${team} and s.active and s.role='manager'`,
          );
          if (Number(n?.n) < 2)
            throw new HttpError(
              400,
              "Two managers per team required",
              "reviewer_capacity",
            );
        }
        await rows(
          tx,
          sql`insert into settings(id,version,body,configured) values(1,1,${JSON.stringify(v)}::jsonb,true) on conflict(id) do update set version=settings.version+1,body=excluded.body,configured=true,updated_at=now()`,
        );
        const current = await rows(
          tx,
          sql`select version,body from settings where id=1`,
        );
        await rows(
          tx,
          sql`insert into settings_history(version,body,actor_id) values(${current[0]!.version},${JSON.stringify(current[0]!.body)}::jsonb,${req.staff!.id})`,
        );
        await audit(tx, req.staff!.id, "settings_changed", null, {
          version: current[0]!.version,
        });
      });
      return settings(db);
    });
    a.get("/settings/history", async () => ({
      history: await rows(
        db,
        sql`select version,actor_id,created_at,body from settings_history order by version desc limit 100`,
      ),
    }));
    a.get("/staff", async () => ({
      staff: await rows(
        db,
        sql`select id,email,name,role,active,mfa_enc is not null mfa_enrolled,created_at from staff order by name`,
      ),
    }));
    a.get("/staff/:id", async (req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const [staff] = await rows(
        db,
        sql`select id,email,name,role,active,mfa_enc is not null mfa_enrolled,created_at from staff where id=${id}`,
      );
      if (!staff) throw new HttpError(404, "Not found", "not_found");
      return { staff };
    });
    a.post("/staff/:id/password-reset", async (req) => {
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const [staff] = await rows(
        db,
        sql`select email,active from staff where id=${id}`,
      );
      if (!staff) throw new HttpError(404, "Not found", "not_found");
      if (!staff.active)
        throw new HttpError(409, "Inactive account", "staff_inactive");
      await limitPasswordReset(limiter, String(staff.email));
      const queued = await db.transaction((tx) =>
        queuePasswordReset(tx, config, id, req.staff!.id),
      );
      if (!queued)
        throw new HttpError(409, "Inactive account", "staff_inactive");
      return { ok: true };
    });
    a.post("/staff", async (req) => {
      const v = z
        .object({
          email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
          name: z.string().trim().min(1).max(100),
          role: z.enum(staffRoles),
        })
        .parse(req.body);
      const raw = token();
      const randomPassword = await hashSecret(token());
      await db.transaction(async (tx) => {
        const [s] = await rows(
          tx,
          sql`insert into staff(email,name,role,password_hash,active) values(${v.email},${v.name},${v.role},${randomPassword},false) on conflict(email) do nothing returning id`,
        );
        if (!s)
          throw new HttpError(409, "Email already exists", "staff_exists");
        await rows(
          tx,
          sql`insert into staff_tokens(staff_id,token_hash,purpose,expires_at) values(${s!.id},${digest(raw)},'invitation',now()+interval '24 hours')`,
        );
        await enqueue(
          tx,
          "staff_token",
          null,
          {
            tokenEnc: seal(raw, config.keys, "staff-token"),
            purpose: "invitation",
          },
          String(s!.id),
        );
        await audit(tx, req.staff!.id, "staff_invited", null, {
          staffId: s!.id,
          role: v.role,
        });
      });
      return { ok: true };
    });
    a.patch("/staff/:id", async (req) => {
      const p = z.object({ id: z.uuid() }).parse(req.params);
      const v = z
        .object({
          active: z.boolean(),
          role: z.enum(staffRoles),
          name: z.string().trim().min(1).max(100),
        })
        .parse(req.body);
      await db.transaction(async (tx) => {
        await rows(tx, sql`select pg_advisory_xact_lock(739200)`);
        const [target] = await rows(
          tx,
          sql`select * from staff where id=${p.id} for update`,
        );
        if (!target) throw new HttpError(404, "Not found", "not_found");
        if (
          target.role === "admin" &&
          target.active &&
          (!v.active || v.role !== "admin")
        ) {
          const [n] = await rows(
            tx,
            sql`select count(*)::int n from staff where role='admin' and active`,
          );
          if (Number(n?.n) < 2)
            throw new HttpError(409, "Last administrator", "last_admin");
        }
        await rows(
          tx,
          sql`update staff set name=${v.name},role=${v.role},active=${v.active} where id=${p.id}`,
        );
        await rows(tx, sql`delete from staff_sessions where staff_id=${p.id}`);
        const preserveInvitation = !target.active && !v.active;
        await rows(
          tx,
          sql`delete from staff_tokens where staff_id=${p.id} ${preserveInvitation ? sql`and purpose<>'invitation'` : sql``}`,
        );
        await rows(
          tx,
          sql`delete from jobs where staff_id=${p.id} and kind='staff_token' ${preserveInvitation ? sql`and body->>'purpose' is distinct from 'invitation'` : sql``}`,
        );
        if (v.role === "admin" || !v.active) {
          await rows(tx, sql`delete from team_members where staff_id=${p.id}`);
          await rows(tx, sql`delete from case_members where staff_id=${p.id}`);
          await rows(
            tx,
            sql`update cases set owner_id=null where owner_id=${p.id}`,
          );
        }
        await audit(tx, req.staff!.id, "staff_updated", null, {
          staffId: p.id,
          role: v.role,
          active: v.active,
        });
      });
      return { ok: true };
    });
    a.get("/teams", async () => ({
      teams: await rows(
        db,
        sql`select t.*,coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'role',s.role)) filter(where s.id is not null),'[]') members from teams t left join team_members m on m.team_id=t.id left join staff s on s.id=m.staff_id group by t.id order by t.name`,
      ),
    }));
    a.post("/teams", async (req) => {
      const v = z
        .object({
          name: z.string().trim().min(1).max(100),
          restricted: z.boolean(),
        })
        .parse(req.body);
      const [t] = await rows(
        db,
        sql`insert into teams(name,restricted) values(${v.name},${v.restricted}) returning *`,
      );
      await audit(db, req.staff!.id, "team_created", null, {
        teamId: t!.id,
        restricted: v.restricted,
      });
      return t;
    });
    a.put("/teams/:id/members", async (req) => {
      const p = z.object({ id: z.uuid() }).parse(req.params);
      const v = z
        .object({ staffIds: z.array(z.uuid()).max(100) })
        .parse(req.body);
      await db.transaction(async (tx) => {
        await rows(tx, sql`select pg_advisory_xact_lock(739201)`);
        const [team] = await rows(
          tx,
          sql`select * from teams where id=${p.id} for update`,
        );
        if (!team) throw new HttpError(404, "Not found", "not_found");
        for (const sid of v.staffIds) {
          const [s] = await rows(
            tx,
            sql`select id from staff where id=${sid} and active and role<>'admin'`,
          );
          if (!s) throw new HttpError(400, "Invalid member", "invalid_member");
          const [conflict] = await rows(
            tx,
            sql`select t.id from team_members m join teams t on t.id=m.team_id where m.staff_id=${sid} and t.restricted<>${team.restricted} and t.id<>${p.id}`,
          );
          if (conflict)
            throw new HttpError(
              400,
              "Independent teams required",
              "team_overlap",
            );
        }
        await rows(tx, sql`delete from team_members where team_id=${p.id}`);
        for (const sid of new Set(v.staffIds))
          await rows(
            tx,
            sql`insert into team_members(team_id,staff_id) values(${p.id},${sid})`,
          );
        await rows(
          tx,
          sql`delete from case_members cm using cases c where cm.case_id=c.id and c.team_id=${p.id} and not cm.recused and not exists(select 1 from team_members m where m.team_id=${p.id} and m.staff_id=cm.staff_id)`,
        );
        await rows(
          tx,
          sql`update cases c set owner_id=null where c.team_id=${p.id} and not exists(select 1 from team_members m where m.team_id=${p.id} and m.staff_id=c.owner_id)`,
        );
        await audit(tx, req.staff!.id, "team_members_changed", null, {
          teamId: p.id,
          count: v.staffIds.length,
        });
      });
      return { ok: true };
    });
    a.get("/audit", async (req) => {
      const q = z
        .object({
          after: z.coerce.number().int().min(0).default(0),
          until: z.coerce.number().int().min(0).optional(),
        })
        .parse(req.query);
      const [last] = await rows(
        db,
        sql`select coalesce(max(seq),0)::bigint seq from audit_events`,
      );
      const until = q.until ?? Number(last!.seq);
      await audit(db, req.staff!.id, "audit_history_viewed", null, {
        after: q.after,
        until,
      });
      return {
        events: await rows(
          db,
          sql`select * from audit_events where seq>${q.after} and seq<=${until} order by seq limit 1000`,
        ),
        until,
      };
    });
    a.get("/dashboard", async (req) => {
      const day = z.iso.date();
      const today = new Date().toISOString().slice(0, 10);
      const q = z
        .object({
          from: day.optional(),
          to: day.default(today),
        })
        .parse(req.query);
      const from =
        q.from ??
        new Date(Date.parse(q.to) - 29 * 86400000).toISOString().slice(0, 10);
      const days = (Date.parse(q.to) - Date.parse(from)) / 86400000;
      if (!(days >= 0 && days <= 365))
        throw new HttpError(400, "Invalid date range", "validation_error");
      const end = new Date(Date.parse(q.to) + 86400000).toISOString();
      const start = new Date(from).toISOString();
      const s = await settings(db);
      const inRange = sql`c.created_at>=${start}::timestamptz and c.created_at<${end}::timestamptz`;
      const states = await rows<{ state: CaseState; count: number }>(
        db,
        sql`select c.state,count(*)::int count from cases c where ${inRange} group by c.state`,
      );
      const count = (...names: string[]) =>
        states
          .filter((r) => names.includes(r.state))
          .reduce((n, r) => n + r.count, 0);
      const [support] = await rows<{ overdue: number }>(
        db,
        sql`select count(*) filter(where c.created_at<now()-${s.body.acknowledgmentDays}*interval '1 day' and c.acknowledged_at is null)::int overdue from cases c where c.state in ('received','triage') and ${inRange}`,
      );
      const [manager] = await rows<{ waiting_on_staff: number }>(
        db,
        sql`select count(*)::int waiting_on_staff from cases c where c.state='investigating' and ${inRange} and (select m.author from case_messages m where m.case_id=c.id order by m.created_at desc limit 1)='reporter'`,
      );
      const outcomes = await rows<{ outcome: string; count: number }>(
        db,
        sql`select coalesce(c.closure->>'outcome','unknown') outcome,count(*)::int count from cases c where c.state='closed' and ${inRange} group by 1 order by 2 desc`,
      );
      const trend = await rows<{
        day: string;
        created: number;
        closed: number;
      }>(
        db,
        sql`select to_char(d,'YYYY-MM-DD') as day,
          (select count(*)::int from cases c where (c.created_at at time zone 'UTC')::date=d) created,
          (select count(*)::int from cases c where (c.closed_at at time zone 'UTC')::date=d) closed
          from generate_series(${from}::date,${q.to}::date,interval '1 day') d order by d`,
      );
      let ai: DashboardData["ai"] = null;
      try {
        const body = (await (
          await privacyCall(req, "stats", { from: start, to: end })
        ).json()) as { ai: Record<string, number> };
        ai = {
          total: body.ai.total!,
          notStarted: body.ai.not_started!,
          active: body.ai.active!,
          failed: body.ai.failed!,
          idle: body.ai.idle!,
        };
      } catch {
        // The case figures stay useful while the private service is down.
      }
      await audit(db, req.staff!.id, "dashboard_viewed");
      return {
        range: { from, to: q.to },
        total: states.reduce((n, r) => n + r.count, 0),
        states,
        waitingForSupport: {
          count: count("received", "triage"),
          overdue: support?.overdue ?? 0,
        },
        caseManager: {
          waitingOnReporter: count("waiting_reporter"),
          waitingOnStaff: manager?.waiting_on_staff ?? 0,
        },
        ai,
        outcomes,
        pendingClosure: count("closure_review"),
        trend,
      } satisfies DashboardData;
    });
    a.get("/operations", async (req) => {
      let privacy: unknown;
      try {
        privacy = await (await privacyCall(req, "operations", {})).json();
      } catch {
        privacy = { unavailable: true };
      }
      return {
        privacy,
        jobs: await rows(
          db,
          sql`select kind,count(*)::int pending,max(attempts)::int attempts from jobs where sent_at is null group by kind`,
        ),
        deletions: await rows(
          db,
          sql`select count(*)::int pending from deletion_manifest where not privacy_complete`,
        ),
        audit: await rows(
          db,
          sql`select seq,hash from audit_events order by seq desc limit 1`,
        ),
      };
    });
  });
}
