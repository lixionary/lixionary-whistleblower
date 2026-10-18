"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  followupKeys,
  type ConversationView,
  type FollowupUpdate,
} from "@whistle/shared";
import { api, ApiError } from "@/lib/api";
import {
  Check,
  Text,
  ErrorBox,
  privateApi,
  useAction,
  usePoll,
} from "./common";
import { SafeMarkdown } from "./markdown";

type Draft = FollowupUpdate & { clientMessageId: string };
export function CaseConversation({
  t,
  lang,
  closed,
  onShared,
}: {
  t: (key: string) => string;
  lang: "en" | "id";
  closed: boolean;
  onShared: () => Promise<void>;
}) {
  const a = useAction(lang),
    label = (en: string, id: string) => (lang === "id" ? id : en);
  const [state, setState] = useState<ConversationView>(),
    [body, setBody] = useState(""),
    [consent, setConsent] = useState(false),
    [draft, setDraft] = useState<Draft | null>(null),
    [reviewed, setReviewed] = useState(false);
  const mounted = useRef(false),
    bootstrapping = useRef(false),
    draftId = useRef<string | null>(null),
    request = useRef<{ path: string; payload: unknown } | null>(null),
    publishing = useRef(false);
  const accept = useCallback((next: ConversationView) => {
    if (!mounted.current) return;
    setState(next);
    const id = next.draft?.clientMessageId ?? null;
    if (id !== draftId.current) {
      draftId.current = id;
      setDraft(next.draft);
      setReviewed(false);
    }
  }, []);
  const load = useCallback(async () => {
    const next = await privateApi<ConversationView>("/conversation");
    accept(next);
    return next;
  }, [accept]);
  const invoke = async (path: string, payload: unknown) => {
    request.current = { path, payload };
    try {
      const next = await privateApi<ConversationView>("/conversation/" + path, {
        method: "POST",
        body: payload,
      });
      request.current = null;
      accept(next);
    } catch (error) {
      if (error instanceof ApiError) request.current = null;
      throw error;
    } finally {
      await load().catch(() => {});
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!bootstrapping.current) {
      bootstrapping.current = true;
      void a
        .run(async () => {
          const next = await load();
          if (
            mounted.current &&
            next.consented &&
            !next.needsConsent &&
            next.aiEnabled &&
            !next.initialized &&
            !next.pending &&
            !closed
          )
            await invoke("start", { requestId: crypto.randomUUID() });
        })
        .finally(() => {
          bootstrapping.current = false;
        });
    }
    return () => {
      mounted.current = false;
    };
  }, [load]);
  usePoll(
    useCallback(async () => {
      await load();
    }, [load]),
  );
  if (!state)
    return (
      <section
        aria-label={label("Private AI follow-up", "Tindak lanjut AI pribadi")}
      >
        <h2>{label("Private AI follow-up", "Tindak lanjut AI pribadi")}</h2>
        <ErrorBox error={a.error} />
        <button
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              await load();
            })
          }
        >
          {label("Load conversation", "Muat percakapan")}
        </button>
      </section>
    );
  const blocked =
    a.busy ||
    !!state.pending ||
    !!request.current ||
    closed ||
    !state.aiEnabled ||
    state.needsConsent;
  const start = () =>
    void a.run(async () => {
      await invoke("start", {
        requestId: crypto.randomUUID(),
        consent: true,
        policyVersion: state.policyVersion,
        locale: lang,
      });
      setConsent(false);
    });
  return (
    <section
      aria-label={label("Private AI follow-up", "Tindak lanjut AI pribadi")}
    >
      <h2>{label("Private AI follow-up", "Tindak lanjut AI pribadi")}</h2>
      <p>
        {label(
          "Your report has been submitted. This conversation stays private. Only updates you review and share reach investigators. Return with your case code and access secret to continue, within the company’s retention period.",
          "Laporan Anda telah terkirim. Percakapan ini tetap pribadi. Hanya pembaruan yang Anda tinjau dan bagikan yang diterima penyelidik. Kembali dengan kode laporan dan rahasia akses untuk melanjutkan, selama masa penyimpanan perusahaan.",
        )}
      </p>
      <ErrorBox error={a.error} />
      {!state.aiEnabled && (
        <p role="status">
          {label(
            "AI is currently unavailable. Your case and saved conversation remain accessible.",
            "AI saat ini tidak tersedia. Laporan dan percakapan tersimpan tetap dapat diakses.",
          )}
        </p>
      )}
      {closed && (
        <p>
          {label(
            "This case is closed. Request reopening below to continue the conversation.",
            "Laporan ini ditutup. Minta pembukaan kembali di bawah untuk melanjutkan percakapan.",
          )}
        </p>
      )}
      {state.needsConsent && state.aiEnabled && !closed && (
        <>
          <Check
            label={t("aiConsent")}
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <button disabled={!consent || a.busy} onClick={start}>
            {label("Start private follow-up", "Mulai tindak lanjut pribadi")}
          </button>
        </>
      )}
      <div aria-live="polite" aria-relevant="additions text">
        {state.messages.map((m, i) => (
          <article key={i}>
            <strong>
              {m.role === "assistant" ? "AI" : label("You", "Anda")}
            </strong>
            {m.role === "assistant" ? (
              <SafeMarkdown content={m.content} />
            ) : (
              <p style={{ whiteSpace: "pre-wrap" }}>{m.content}</p>
            )}
          </article>
        ))}
      </div>
      {state.consented && (
        <>
          <p className="muted">
            {label("Daily AI attempts", "Percobaan AI harian")}:{" "}
            {state.usage.messages}/30 · {label("Updates", "Pembaruan")}:{" "}
            {state.usage.drafts}/3. {label("Resets", "Direset")}:{" "}
            {new Date(state.usage.resetsAt).toLocaleString(lang, {
              timeZone: "UTC",
            })}{" "}
            (UTC).
          </p>
          {state.pending && (
            <p role="status">
              {state.pending.retryable
                ? label(
                    "The last AI attempt did not finish. Your conversation is saved.",
                    "Percobaan AI terakhir belum selesai. Percakapan Anda tersimpan.",
                  )
                : label(
                    "The assistant is preparing a reply…",
                    "Asisten sedang menyiapkan balasan…",
                  )}
            </p>
          )}
          {(state.pending?.retryable || request.current) && (
            <button
              disabled={
                a.busy || closed || !state.aiEnabled || state.needsConsent
              }
              onClick={() =>
                void a.run(async () => {
                  if (state.pending?.retryable) {
                    request.current = null;
                    await invoke(state.pending.kind, {
                      requestId: crypto.randomUUID(),
                      retryOf: state.pending.id,
                    });
                  } else if (request.current)
                    await invoke(request.current.path, request.current.payload);
                })
              }
            >
              {label("Retry AI", "Coba lagi AI")}
            </button>
          )}
          {state.pending?.kind === "draft" && state.pending.retryable && (
            <button
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  request.current = null;
                  accept(
                    await privateApi<ConversationView>("/conversation/draft", {
                      method: "DELETE",
                    }),
                  );
                })
              }
            >
              {label("Skip failed update", "Lewati pembaruan gagal")}
            </button>
          )}
          {!state.initialized &&
            !state.pending &&
            !request.current &&
            !state.needsConsent && (
              <button
                disabled={a.busy || closed || !state.aiEnabled}
                onClick={() =>
                  void a.run(async () => {
                    await invoke("start", { requestId: crypto.randomUUID() });
                  })
                }
              >
                {label("Continue AI", "Lanjutkan AI")}
              </button>
            )}
          {state.initialized && (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void a.run(async () => {
                    const value = body;
                    await invoke("messages", {
                      requestId: crypto.randomUUID(),
                      body: value,
                    });
                    setBody("");
                  });
                }}
              >
                <Text
                  label={label(
                    "Message to private AI",
                    "Pesan untuk AI pribadi",
                  )}
                  value={body}
                  required
                  maxLength={5000}
                  disabled={blocked}
                  onChange={(e) => setBody(e.target.value)}
                />
                <button disabled={blocked || !body.trim()}>
                  {label("Send to AI", "Kirim ke AI")}
                </button>
              </form>
              <button
                disabled={blocked || state.usage.drafts >= 3}
                onClick={() =>
                  void a.run(async () => {
                    await invoke("draft", { requestId: crypto.randomUUID() });
                  })
                }
              >
                {label("Review update", "Tinjau pembaruan")}
              </button>
            </>
          )}
          <button
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                const next = await privateApi<ConversationView>(
                  "/conversation",
                  { method: "DELETE" },
                );
                request.current = null;
                setBody("");
                accept(next);
              })
            }
          >
            {t("withdraw")}
          </button>
        </>
      )}
      {draft && (
        <form
          aria-label={label("Review AI update", "Tinjau pembaruan AI")}
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              if (publishing.current) return;
              publishing.current = true;
              try {
                const text = [
                  label(
                    "Reporter-reviewed AI follow-up",
                    "Tindak lanjut AI yang ditinjau pelapor",
                  ),
                  draft.summary,
                  ...followupKeys
                    .filter((k) => draft.details[k])
                    .map((k) => `${t(k)}: ${draft.details[k]}`),
                ].join("\n\n");
                if (text.length > 10000) {
                  a.setError(
                    label(
                      "Shorten this update to 10,000 characters before sharing.",
                      "Persingkat pembaruan ini menjadi 10.000 karakter sebelum dibagikan.",
                    ),
                  );
                  return;
                }
                await privateApi("/conversation/draft", {
                  method: "PATCH",
                  body: draft,
                });
                await api("/api/reporter/messages", {
                  method: "POST",
                  body: {
                    body: text,
                    privacyReviewed: true,
                    clientMessageId: draft.clientMessageId,
                  },
                });
                await onShared();
                accept(
                  await privateApi<ConversationView>("/conversation/draft", {
                    method: "DELETE",
                  }),
                );
              } finally {
                publishing.current = false;
              }
            });
          }}
        >
          <h3>{label("Review AI update", "Tinjau pembaruan AI")}</h3>
          <Text
            label={label("Update summary", "Ringkasan pembaruan")}
            required
            maxLength={10000}
            value={draft.summary}
            onChange={(e) => {
              setDraft({ ...draft, summary: e.target.value });
              setReviewed(false);
            }}
          />
          {followupKeys.map((k) => (
            <Text
              key={k}
              label={t(k)}
              maxLength={5000}
              value={draft.details[k]}
              onChange={(e) => {
                setDraft({
                  ...draft,
                  details: { ...draft.details, [k]: e.target.value },
                });
                setReviewed(false);
              }}
            />
          ))}
          <Check
            label={t("review")}
            checked={reviewed}
            required
            onChange={(e) => setReviewed(e.target.checked)}
          />
          <button disabled={a.busy || !!state.pending || !reviewed || closed}>
            {label(
              "Share update with investigators",
              "Bagikan pembaruan kepada penyelidik",
            )}
          </button>
          <button
            type="button"
            disabled={a.busy}
            onClick={() =>
              void a.run(async () => {
                accept(
                  await privateApi<ConversationView>("/conversation/draft", {
                    method: "DELETE",
                  }),
                );
              })
            }
          >
            {label("Discard update", "Buang pembaruan")}
          </button>
        </form>
      )}
    </section>
  );
}
