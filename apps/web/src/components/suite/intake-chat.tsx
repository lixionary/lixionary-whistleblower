"use client";
import { useEffect, useRef, useState } from "react";
import {
  intakeGreeting,
  type CompanySettings,
  type PrivateIntakeView,
  type IntakeReview,
} from "@whistle/shared";
import { api, ApiError } from "@/lib/api";
import { Check, ErrorBox, Field, Text, useAction, type Lang } from "./common";
import { SafeMarkdown } from "./markdown";

type Company = Pick<
  CompanySettings,
  "policy" | "privacyNotice" | "aiEnabled"
> & { version: number };
export type ActiveIntake = { id: string; code: string };
const secret = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export function IntakeChat({
  lang,
  company,
  policy,
  consent,
  onPolicy,
  onConsent,
  onReview,
  onFallback,
  onIntake,
  onPolicyChanged,
  reviewing,
}: {
  lang: Lang;
  company: Company;
  policy: boolean;
  consent: boolean;
  onPolicy: (value: boolean) => void;
  onConsent: (value: boolean) => void;
  onReview: (draft: IntakeReview) => void;
  onFallback: () => void;
  onIntake: (value: ActiveIntake | null) => void;
  onPolicyChanged: () => Promise<void>;
  reviewing: boolean;
}) {
  const a = useAction(lang),
    label = (en: string, id: string) => (lang === "id" ? id : en);
  const [state, setState] = useState<PrivateIntakeView>(),
    [active, setActive] = useState<ActiveIntake>(),
    [body, setBody] = useState(""),
    [resume, setResume] = useState(""),
    [copied, setCopied] = useState(false),
    [expired, setExpired] = useState(false);
  const creation = useRef<ActiveIntake | null>(null),
    request = useRef<{ path: string; payload: unknown } | null>(null);
  const call = <T,>(
    s: ActiveIntake,
    path: string,
    method = "GET",
    payload?: unknown,
  ) =>
    api<T>(`/privacy/intake/${s.id}${path}`, {
      method,
      headers: { "x-intake-code": s.code },
      body: payload,
    });
  const adopt = (s: ActiveIntake, next: PrivateIntakeView) => {
    setActive(s);
    setState(next);
    setExpired(false);
    onIntake(s);
    if (next.needsConsent) {
      onPolicy(false);
      onConsent(false);
    }
  };
  async function load(s: ActiveIntake) {
    const next = await call<PrivateIntakeView>(s, "");
    setState(next);
    return next;
  }
  async function handle(error: unknown) {
    if (error instanceof ApiError && error.code === "policy_changed") {
      onPolicy(false);
      onConsent(false);
      await onPolicyChanged();
    }
    if (error instanceof ApiError && error.code === "intake_expired") {
      setExpired(true);
      onIntake(null);
    }
    throw error;
  }
  async function invoke(s: ActiveIntake, path: string, payload: unknown) {
    request.current = { path, payload };
    try {
      setState(await call<PrivateIntakeView>(s, path, "POST", payload));
      request.current = null;
    } catch (error) {
      if (error instanceof ApiError) request.current = null;
      await handle(error);
    } finally {
      await load(s).catch(() => {});
    }
  }
  useEffect(() => {
    if (!state) return;
    const timer = setTimeout(
      () => {
        setExpired(true);
        onIntake(null);
      },
      Math.max(0, new Date(state.expiresAt).getTime() - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [state?.expiresAt]);
  useEffect(() => {
    if (!active || !state?.pending || expired) return;
    const timer = setInterval(() => void load(active).catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [active?.id, state?.pending?.id, expired]);
  async function send() {
    let s = active;
    if (!s) {
      creation.current ??= { id: crypto.randomUUID(), code: secret() };
      s = creation.current;
      const next = await api<PrivateIntakeView>("/privacy/intake", {
        method: "POST",
        body: {
          ...s,
          consent: true,
          policyVersion: company.version,
          locale: lang,
        },
      }).catch(handle);
      adopt(s, next!);
    }
    const content = body.trim();
    try {
      await invoke(s, "/messages", {
        requestId: crypto.randomUUID(),
        body: content,
        locale: lang,
        consent: true,
        policyVersion: company.version,
      });
      setBody((current) => (current.trim() === content ? "" : current));
    } catch (e) {
      // A saved message appears in the transcript even when its AI reply fails.
      const next = await load(s).catch(() => undefined);
      if (
        next?.messages.at(-1)?.role === "user" &&
        next.messages.at(-1)?.content === content
      )
        setBody((current) => (current.trim() === content ? "" : current));
      throw e;
    }
  }
  const allowed =
    policy &&
    consent &&
    company.aiEnabled &&
    state?.aiEnabled !== false &&
    !expired;
  return (
    <>
      {active && state && (
        <section
          className="continuation-card"
          aria-label={label(
            "Continue your conversation",
            "Lanjutkan percakapan Anda",
          )}
        >
          <h2>
            {label(
              "Your private continuation code",
              "Kode pribadi untuk melanjutkan",
            )}
          </h2>
          <p className="continuation-code">{active.code}</p>
          <p>
            {label(
              "Save this code to return on any device. Anyone with it can read your unfinished conversation. This is not a report number; your report has not been submitted.",
              "Simpan kode ini untuk kembali dari perangkat mana pun. Siapa pun yang memiliki kode ini dapat membaca percakapan Anda. Ini bukan nomor laporan; laporan Anda belum dikirim.",
            )}
          </p>
          <p>
            {label("Expires", "Berlaku hingga")}:{" "}
            <time dateTime={state.expiresAt}>
              {new Date(state.expiresAt).toLocaleString(lang)}
            </time>{" "}
            · {label("24 hours from the start", "24 jam sejak dimulai")}
          </p>
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void a.run(async () => {
                  await navigator.clipboard.writeText(active.code);
                  setCopied(true);
                })
              }
            >
              {copied
                ? label("Copied", "Disalin")
                : label("Copy code", "Salin kode")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      `${label("Private continuation code", "Kode pribadi untuk melanjutkan")}: ${active.code}\n${label("Expires", "Berlaku hingga")}: ${state.expiresAt}\n${window.location.origin}/report#continue\n`,
                    ],
                    { type: "text/plain" },
                  ),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = "private-conversation.txt";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              {label("Download code", "Unduh kode")}
            </button>
          </div>
        </section>
      )}
      {!reviewing && (
        <div>
          <section
            aria-label={label(
              "Private reporting assistant",
              "Asisten pelaporan pribadi",
            )}
            className="intake-chat"
          >
            <div
              className="intake-messages"
              role="log"
              aria-live="polite"
              aria-label={label("Conversation", "Percakapan")}
            >
              {(
                state?.messages ?? [
                  { role: "assistant", content: intakeGreeting(lang) },
                ]
              ).map((m, i) => (
                <article key={i} className={`intake-message ${m.role}`}>
                  <strong>
                    {m.role === "assistant"
                      ? label("Assistant", "Asisten")
                      : label("You", "Anda")}
                  </strong>
                  <SafeMarkdown content={m.content} />
                </article>
              ))}
            </div>
            <details>
              <summary>
                {label(
                  "Policy and privacy notice",
                  "Kebijakan dan pemberitahuan privasi",
                )}
              </summary>
              <h3>{label("Policy", "Kebijakan")}</h3>
              <p>{company.policy[lang]}</p>
              <h3>{label("Privacy notice", "Pemberitahuan privasi")}</h3>
              <p>{company.privacyNotice[lang]}</p>
            </details>
            <Check
              label={label(
                "I have read the policy and privacy notice.",
                "Saya telah membaca kebijakan dan pemberitahuan privasi.",
              )}
              checked={policy}
              onChange={(e) => onPolicy(e.target.checked)}
            />
            <Check
              label={label(
                "I consent to MiniMax processing this private conversation to help prepare my report.",
                "Saya menyetujui MiniMax memproses percakapan pribadi ini untuk membantu menyiapkan laporan saya.",
              )}
              checked={consent}
              onChange={(e) => onConsent(e.target.checked)}
            />
            <p className="muted">
              {label(
                "Only the report you review and submit is shared with investigators. You can use a form instead without AI.",
                "Hanya laporan yang Anda tinjau dan kirim yang dibagikan kepada penyelidik. Anda dapat menggunakan formulir tanpa AI.",
              )}
            </p>
            <ErrorBox error={a.error} />
            {expired && (
              <p role="alert">
                {label(
                  "This conversation has expired. Start a new conversation or use the form.",
                  "Percakapan ini telah kedaluwarsa. Mulai percakapan baru atau gunakan formulir.",
                )}
              </p>
            )}
            {(!company.aiEnabled || state?.aiEnabled === false) && (
              <p role="status">
                {label(
                  "The assistant is unavailable. You can use the form instead.",
                  "Asisten tidak tersedia. Anda dapat menggunakan formulir.",
                )}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void a.run(send);
              }}
            >
              <Text
                label={label("Message to assistant", "Pesan untuk asisten")}
                maxLength={4000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
                disabled={a.busy || expired}
              />
              <button
                disabled={
                  a.busy || !allowed || !body.trim() || !!state?.pending
                }
              >
                {a.busy
                  ? label("Please wait…", "Mohon tunggu…")
                  : label("Send", "Kirim")}
              </button>
            </form>
            <div className="actions">
              {(request.current || state?.pending) && (
                <button
                  className="secondary"
                  type="button"
                  disabled={
                    a.busy ||
                    !allowed ||
                    (!request.current && !state?.pending?.retryable)
                  }
                  onClick={() =>
                    void a.run(async () => {
                      if (request.current) {
                        await invoke(
                          active!,
                          request.current.path,
                          request.current.payload,
                        );
                        return;
                      }
                      await invoke(active!, `/${state!.pending!.kind}`, {
                        requestId: crypto.randomUUID(),
                        retryOf: state!.pending!.id,
                        locale: lang,
                        consent: true,
                        policyVersion: company.version,
                      });
                    })
                  }
                >
                  {label("Retry AI", "Coba lagi AI")}
                </button>
              )}
              {active && !expired && (
                <button
                  type="button"
                  className="secondary"
                  disabled={a.busy}
                  onClick={() =>
                    void a.run(async () => {
                      const latest = await load(active);
                      if (latest.draft) {
                        onReview(latest.draft);
                        return;
                      }
                      if (!allowed) {
                        onFallback();
                        return;
                      }
                      await invoke(active, "/draft", {
                        requestId: crypto.randomUUID(),
                        locale: lang,
                        consent: true,
                        policyVersion: company.version,
                      });
                      const next = await load(active);
                      if (next.draft) onReview(next.draft);
                    })
                  }
                >
                  {label("Review report", "Tinjau laporan")}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    if (active && !expired) {
                      const latest = await load(active);
                      if (latest.draft) {
                        onReview(latest.draft);
                        return;
                      }
                    }
                    if (expired) onIntake(null);
                    onFallback();
                  })
                }
              >
                {label("Use a form instead", "Gunakan formulir")}
              </button>
              {active && (
                <button
                  type="button"
                  className="secondary"
                  disabled={a.busy}
                  onClick={() =>
                    void a.run(async () => {
                      if (!expired) await call(active, "", "DELETE");
                      setActive(undefined);
                      setState(undefined);
                      setBody("");
                      setExpired(false);
                      creation.current = null;
                      request.current = null;
                      onIntake(null);
                      onConsent(false);
                      onPolicy(false);
                    })
                  }
                >
                  {label("Discard conversation", "Hapus percakapan")}
                </button>
              )}
            </div>
          </section>
          {!active && (
            <section id="continue">
              <h2>
                {label("Continue a conversation", "Lanjutkan percakapan")}
              </h2>
              <p>
                {label(
                  "Enter your private continuation code. Submitted reports use the case portal.",
                  "Masukkan kode pribadi percakapan Anda. Laporan yang sudah dikirim menggunakan portal laporan.",
                )}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void a.run(async () => {
                    const code = resume.trim();
                    const next = await api<PrivateIntakeView>(
                      "/privacy/intake/resume",
                      {
                        method: "POST",
                        headers: { "x-intake-code": code },
                        body: {},
                      },
                    );
                    adopt({ id: next.id, code }, next);
                    setResume("");
                  });
                }}
              >
                <Field
                  label={label("Continuation code", "Kode untuk melanjutkan")}
                  value={resume}
                  onChange={(e) => setResume(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
                <button disabled={a.busy}>
                  {label("Continue conversation", "Lanjutkan percakapan")}
                </button>
              </form>
            </section>
          )}
        </div>
      )}
    </>
  );
}
