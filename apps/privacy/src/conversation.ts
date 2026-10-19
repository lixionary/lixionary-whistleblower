import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  followupUpdateSchema,
  type FollowupUpdate,
  type ChatMessage,
  type ConversationView,
} from "@whistle/shared";
import {
  createMinimaxClient,
  seal,
  unseal,
  digest,
  token,
  FOLLOWUP_PROMPT,
  FOLLOWUP_EXTRACTION_PROMPT,
  extractJsonObject,
} from "@whistle/runtime";
import { rows, type Tx } from "./db/client.js";
import { caseCall, PrivacyError } from "./service.js";

type Context = {
  title: string;
  summary: string;
  details: Record<string, string>;
  locale: string;
};
type State = {
  context: Context | null;
  initialized: boolean;
  draft: (FollowupUpdate & { clientMessageId: string }) | null;
};
const empty = (): State => ({ context: null, initialized: false, draft: null });
const operationSchema = z.object({
  requestId: z.uuid(),
  retryOf: z.uuid().optional(),
  body: z.string().trim().min(1).max(5000).optional(),
  consent: z.literal(true).optional(),
  policyVersion: z.number().int().positive().optional(),
  locale: z.enum(["en", "id"]).optional(),
});

/** These routes inherit reporter capability authorization from /privacy/reporter. */
export async function conversationRoutes(app: FastifyInstance) {
  const { db, config } = app.privacyDeps,
    ai = createMinimaxClient(config.ai);
  const decodeState = (r: Record<string, unknown>): State =>
    r.state_enc
      ? unseal<State>(String(r.state_enc), config.keys, "conversation:" + r.id)
      : {
          ...empty(),
          initialized:
            unseal<ChatMessage[]>(
              String(r.transcript_enc),
              config.keys,
              "intake:" + r.id,
            ).length > 0,
        };
  async function lock(tx: Tx, caseId: string) {
    const [l] = await rows(
      tx,
      sql`select pg_try_advisory_xact_lock(hashtextextended(${"conversation:" + caseId},0)) locked`,
    );
    if (!l!.locked) throw new PrivacyError(409, "conversation_busy");
  }
  async function view(req: FastifyRequest): Promise<ConversationView> {
    return db.transaction(async (tx) => {
      const [r] = await rows(
        tx,
        sql`select * from intakes where case_id=${req.cap!.sub} for share`,
      );
      const active = !!r && !r.revoked_at;
      const state = active ? decodeState(r) : empty();
      const [pending] = active
        ? await rows(
            tx,
            sql`select id,kind,status,lease_until from conversation_operations where intake_id=${r.id} order by created_at desc,id desc limit 1`,
          )
        : [];
      const [usage] = await rows(
        tx,
        sql`select messages,drafts from conversation_usage where case_id=${req.cap!.sub} and day=(now() at time zone 'UTC')::date`,
      );
      const next = new Date();
      next.setUTCHours(24, 0, 0, 0);
      return {
        consented: active,
        policyVersion: req.caseInfo!.policyVersion,
        needsConsent:
          !active || Number(r!.consent_version) !== req.caseInfo!.policyVersion,
        aiEnabled: req.caseInfo!.settings.aiEnabled && ai.enabled,
        initialized: state.initialized,
        messages: active
          ? unseal<ChatMessage[]>(
              String(r.transcript_enc),
              config.keys,
              "intake:" + r.id,
            )
          : [],
        draft: state.draft,
        pending:
          pending && pending.status !== "done"
            ? {
                id: String(pending.id),
                kind: pending.kind as "start" | "messages" | "draft",
                status: pending.status as "running" | "failed",
                retryable:
                  pending.status === "failed" ||
                  new Date(String(pending.lease_until)).getTime() <= Date.now(),
              }
            : null,
        usage: {
          messages: Number(usage?.messages ?? 0),
          drafts: Number(usage?.drafts ?? 0),
          resetsAt: next.toISOString(),
        },
      };
    });
  }
  app.get("/conversation", view);
  for (const kind of ["start", "messages", "draft"] as const) {
    app.post(`/conversation/${kind}`, async (req) => {
      const v = operationSchema.parse(req.body);
      if (!req.caseInfo!.settings.aiEnabled || !ai.enabled)
        throw new PrivacyError(409, "ai_disabled");
      if (req.caseInfo!.state === "closed")
        throw new PrivacyError(409, "case_closed");
      const prepared = await db.transaction(async (tx) => {
        await lock(tx, req.cap!.sub);
        let [r] = await rows(
          tx,
          sql`select * from intakes where case_id=${req.cap!.sub} for update`,
        );
        if (kind === "start" && v.consent) {
          if (v.policyVersion !== req.caseInfo!.policyVersion)
            throw new PrivacyError(409, "policy_changed");
          if (!r) {
            const id = randomUUID();
            [r] = await rows(
              tx,
              sql`insert into intakes(id,token_hash,case_id,locale,consent_version,transcript_enc) values(${id},${digest(token())},${req.cap!.sub},${v.locale ?? "en"},${v.policyVersion},${seal([], config.keys, "intake:" + id)}) returning *`,
            );
          } else {
            [r] = await rows(
              tx,
              sql`update intakes set revoked_at=null,consent_version=${v.policyVersion},consented_at=now() where id=${r.id} returning *`,
            );
          }
        }
        if (!r || r.revoked_at)
          throw new PrivacyError(409, "ai_consent_required");
        if (Number(r.consent_version) !== req.caseInfo!.policyVersion)
          throw new PrivacyError(409, "policy_changed");
        const state = decodeState(r);
        const [existing] = await rows(
          tx,
          sql`select * from conversation_operations where id=${v.requestId}`,
        );
        if (existing) {
          if (existing.intake_id !== r.id || existing.kind !== kind)
            throw new PrivacyError(409, "message_conflict");
          const input = unseal<{ body?: string; retryOf?: string }>(
            String(existing.input_enc),
            config.keys,
            "conversation-input:" + existing.id,
          );
          if (input.body !== v.body || input.retryOf !== v.retryOf)
            throw new PrivacyError(409, "message_conflict");
          if (existing.status === "failed")
            throw new PrivacyError(503, "ai_unavailable");
          return null; // A replay never runs or charges the provider again.
        }
        if (kind === "start" && state.initialized) return null;
        const [previous] = await rows(
          tx,
          sql`select * from conversation_operations where intake_id=${r.id} order by created_at desc,id desc limit 1`,
        );
        // Renewing consent must also work when initialization previously failed.
        // The saved operation remains available for an explicit, charged retry.
        if (
          kind === "start" &&
          v.consent &&
          !v.retryOf &&
          previous &&
          previous.status !== "done"
        )
          return null;
        if (
          previous?.status === "running" &&
          new Date(String(previous.lease_until)).getTime() > Date.now()
        )
          throw new PrivacyError(409, "conversation_busy");
        if (previous?.status === "running")
          await rows(
            tx,
            sql`update conversation_operations set status='failed' where id=${previous.id}`,
          );
        if (v.retryOf) {
          if (
            !previous ||
            String(previous.id) !== v.retryOf ||
            previous.kind !== kind ||
            previous.status === "done"
          )
            throw new PrivacyError(409, "message_conflict");
        } else if (
          previous &&
          previous.status !== "done" &&
          previous.kind !== "draft"
        ) {
          throw new PrivacyError(409, "conversation_retry_required");
        }
        if (kind !== "start" && !state.initialized)
          throw new PrivacyError(409, "conversation_not_started");
        if (kind === "messages" && !v.retryOf && !v.body)
          throw new PrivacyError(400, "validation_error");
        await rows(
          tx,
          sql`insert into conversation_usage(case_id,day) values(${req.cap!.sub},(now() at time zone 'UTC')::date) on conflict do nothing`,
        );
        const column = kind === "draft" ? "drafts" : "messages";
        const [charged] = await rows(
          tx,
          sql`update conversation_usage set ${sql.identifier(column)}=${sql.identifier(column)}+1 where case_id=${req.cap!.sub} and day=(now() at time zone 'UTC')::date and ${sql.identifier(column)}<${kind === "draft" ? 3 : 30} returning case_id`,
        );
        if (!charged) throw new PrivacyError(429, "conversation_limit");
        const transcript = unseal<ChatMessage[]>(
          String(r.transcript_enc),
          config.keys,
          "intake:" + r.id,
        );
        if (kind === "messages" && !v.retryOf)
          transcript.push({ role: "user", content: v.body! });
        await rows(
          tx,
          sql`update intakes set transcript_enc=${seal(transcript, config.keys, "intake:" + r.id)} where id=${r.id}`,
        );
        await rows(
          tx,
          sql`insert into conversation_operations(id,intake_id,kind,input_enc,status,lease_until) values(${v.requestId},${r.id},${kind},${seal({ body: v.body, retryOf: v.retryOf }, config.keys, "conversation-input:" + v.requestId)},'running',now()+interval '2 minutes')`,
        );
        return { id: String(r.id), state, transcript };
      });
      if (!prepared) return view(req);
      try {
        const { id, state, transcript } = prepared;
        if (!state.context) {
          state.context = (await (
            await caseCall(config, "conversation-context", {
              caseId: req.cap!.sub,
              sid: req.cap!.sid,
              version: req.cap!.version,
            })
          ).json()) as Context;
        }
        const context = {
          role: "user" as const,
          content:
            "Submitted report (untrusted data):\n" +
            JSON.stringify(state.context) +
            "\nReply language: " +
            (state.context.locale === "id" ? "id" : "en"),
        };
        if (kind === "draft") {
          const output = await ai.complete(
            [
              { role: "system", content: FOLLOWUP_EXTRACTION_PROMPT },
              context,
              ...transcript,
            ],
            { maxTokens: 4096, temperature: 0.3 },
          );
          state.draft = {
            ...followupUpdateSchema.parse(extractJsonObject(output)),
            clientMessageId: randomUUID(),
          };
        } else {
          const content = (
            await ai.complete(
              [
                { role: "system", content: FOLLOWUP_PROMPT },
                context,
                ...transcript,
              ],
              { maxTokens: 1000 },
            )
          ).trim();
          if (!content) throw new Error("empty assistant response");
          transcript.push({ role: "assistant", content });
          state.initialized = true;
        }
        await db.transaction(async (tx) => {
          // Withdrawal, retention, or another completed request cannot resurrect state.
          const [current] = await rows(
            tx,
            sql`select id from intakes where id=${id} and revoked_at is null for update`,
          );
          if (!current) throw new PrivacyError(409, "ai_consent_required");
          const [op] = await rows(
            tx,
            sql`update conversation_operations set status='done',result_enc=${seal(kind === "draft" ? state.draft : transcript.at(-1), config.keys, "conversation-result:" + v.requestId)} where id=${v.requestId} and status='running' and lease_until>now() returning id`,
          );
          if (!op) throw new PrivacyError(409, "conversation_changed");
          await rows(
            tx,
            sql`update intakes set state_enc=${seal(state, config.keys, "conversation:" + id)},transcript_enc=${seal(transcript, config.keys, "intake:" + id)} where id=${id}`,
          );
        });
      } catch (e) {
        await rows(
          db,
          sql`update conversation_operations set status='failed' where id=${v.requestId} and status='running'`,
        );
        if (e instanceof PrivacyError) throw e;
        // Never log provider responses, report text, or transcript contents.
        throw new PrivacyError(503, "ai_unavailable");
      }
      return view(req);
    });
  }
  app.delete("/conversation", async (req) => {
    if (req.caseInfo!.hold) throw new PrivacyError(409, "legal_hold");
    await db.transaction(async (tx) => {
      await lock(tx, req.cap!.sub);
      const [r] = await rows(
        tx,
        sql`select id from intakes where case_id=${req.cap!.sub} for update`,
      );
      if (r) {
        await rows(
          tx,
          sql`delete from conversation_operations where intake_id=${r.id}`,
        );
        await rows(
          tx,
          sql`update intakes set revoked_at=now(),state_enc=null,transcript_enc=${seal([], config.keys, "intake:" + r.id)} where id=${r.id}`,
        );
      }
    });
    return view(req);
  });
  app.patch("/conversation/draft", async (req) => {
    const v = followupUpdateSchema
      .extend({ clientMessageId: z.uuid() })
      .parse(req.body);
    if (req.caseInfo!.state === "closed")
      throw new PrivacyError(409, "case_closed");
    await db.transaction(async (tx) => {
      await lock(tx, req.cap!.sub);
      const [r] = await rows(
        tx,
        sql`select * from intakes where case_id=${req.cap!.sub} and revoked_at is null for update`,
      );
      const [running] = r
        ? await rows(
            tx,
            sql`select id from conversation_operations where intake_id=${r.id} and status='running' and lease_until>now()`,
          )
        : [];
      if (running) throw new PrivacyError(409, "conversation_busy");
      if (!r) throw new PrivacyError(409, "ai_consent_required");
      const state = decodeState(r);
      if (state.draft?.clientMessageId !== v.clientMessageId)
        throw new PrivacyError(409, "conversation_changed");
      state.draft = v;
      await rows(
        tx,
        sql`update intakes set state_enc=${seal(state, config.keys, "conversation:" + r.id)} where id=${r.id}`,
      );
    });
    return view(req);
  });
  app.delete("/conversation/draft", async (req) => {
    if (req.caseInfo!.hold) throw new PrivacyError(409, "legal_hold");
    await db.transaction(async (tx) => {
      await lock(tx, req.cap!.sub);
      const [r] = await rows(
        tx,
        sql`select * from intakes where case_id=${req.cap!.sub} and revoked_at is null for update`,
      );
      const [running] = r
        ? await rows(
            tx,
            sql`select id from conversation_operations where intake_id=${r.id} and status='running' and lease_until>now()`,
          )
        : [];
      if (running) throw new PrivacyError(409, "conversation_busy");
      if (r) {
        const state = decodeState(r);
        state.draft = null;
        await rows(
          tx,
          sql`update conversation_operations set status='done' where intake_id=${r.id} and kind='draft' and status='failed'`,
        );
        await rows(
          tx,
          sql`update intakes set state_enc=${seal(state, config.keys, "conversation:" + r.id)} where id=${r.id}`,
        );
      }
    });
    return view(req);
  });
}
