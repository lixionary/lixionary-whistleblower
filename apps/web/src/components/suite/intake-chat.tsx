"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Clock,
  Copy,
  Download,
  FileText,
  KeyRound,
  Lock,
  MessageSquare,
  Send,
} from "lucide-react";
import {
  intakeGreeting,
  createContinuationCode,
  continuationCodeSchema,
  type CompanySettings,
  type PrivateIntakeView,
  type IntakeReview,
} from "@whistle/shared";
import { api, ApiError } from "@/lib/api";
import { Check, ErrorBox, Field, useAction, type Lang } from "./common";
import { Evidence } from "./evidence";
import { SafeMarkdown } from "./markdown";

type Company = Pick<
  CompanySettings,
  "policy" | "privacyNotice" | "aiEnabled"
> & { version: number };
export type ActiveIntake = { id: string; code: string };
// Daily AI allowance per intake (see docs/reporting-flow.md).
const MESSAGE_LIMIT = 30,
  DRAFT_LIMIT = 3;
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
  children,
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
  /** The review form, shown in place of the conversation while reviewing. */
  children?: ReactNode;
}) {
  const a = useAction(lang),
    r = useAction(lang),
    label = (en: string, id: string) => (lang === "id" ? id : en);
  const [state, setState] = useState<PrivateIntakeView>(),
    [active, setActive] = useState<ActiveIntake>(),
    [body, setBody] = useState(""),
    [resume, setResume] = useState(""),
    [copied, setCopied] = useState(false),
    [codeSaved, setCodeSaved] = useState(false),
    [sending, setSending] = useState(false),
    [discarding, setDiscarding] = useState(false),
    [expired, setExpired] = useState(false),
    [now, setNow] = useState(() => Date.now());
  const creation = useRef<ActiveIntake | null>(null),
    sendLock = useRef(false),
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
    if (!state) return;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [!!state]);
  useEffect(() => {
    if (!active || !state?.pending || expired) return;
    const timer = setInterval(() => void load(active).catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [active?.id, state?.pending?.id, expired]);
  async function ensureActive() {
    let s = active;
    if (!s) {
      creation.current ??= {
        id: crypto.randomUUID(),
        code: createContinuationCode(),
      };
      for (let attempt = 0; ; attempt++) {
        s = creation.current;
        try {
          const next = await api<PrivateIntakeView>("/privacy/intake", {
            method: "POST",
            body: {
              ...s,
              consent,
              policyVersion: company.version,
              locale: lang,
            },
          });
          setCodeSaved(false);
          adopt(s, next);
          break;
        } catch (error) {
          if (
            error instanceof ApiError &&
            error.code === "continuation_code_unavailable" &&
            attempt < 2
          ) {
            creation.current = { ...s, code: createContinuationCode() };
            continue;
          }
          await handle(error);
        }
      }
    }
    return s;
  }
  async function send() {
    const s = await ensureActive();
    const content = body.trim();
    setSending(true);
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
    } finally {
      setSending(false);
    }
  }
  const aiAvailable = company.aiEnabled && state?.aiEnabled !== false;
  const allowed = policy && consent && aiAvailable && !expired;
  const canSend = !a.busy && allowed && !!body.trim() && !state?.pending;
  const showConsent = !active || !policy || (aiAvailable && !consent);
  const minutesLeft = state
    ? Math.max(
        0,
        Math.floor((new Date(state.expiresAt).getTime() - now) / 60000),
      )
    : 0;
  const expiresIn = label(
    `Expires in ${Math.floor(minutesLeft / 60)} h ${minutesLeft % 60} min`,
    `Berakhir dalam ${Math.floor(minutesLeft / 60)} j ${minutesLeft % 60} mnt`,
  );
  const expiresAt = state
    ? new Date(state.expiresAt).toLocaleString(lang, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
  return (
    <section
      className="intake"
      aria-label={label(
        "Private reporting assistant",
        "Asisten pelaporan pribadi",
      )}
    >
      <div className="intake-head">
        <div className="intake-title">
          <p className="eyebrow">
            {reviewing
              ? label("Private draft", "Draf pribadi")
              : label("Private reporting", "Pelaporan pribadi")}
          </p>
          <h1>
            {reviewing
              ? label("Review your report", "Tinjau laporan Anda")
              : label("Create a report", "Buat laporan")}
          </h1>
          {state && !expired ? (
            <div className="intake-meta">
              <span>
                <Clock size={14} aria-hidden="true" />
                {expiresIn}
              </span>
              {reviewing ? (
                <span>
                  <FileText size={14} aria-hidden="true" />
                  {label("Drafts today", "Draf hari ini")}{" "}
                  <span className="mono">
                    {state.usage.drafts} / {DRAFT_LIMIT}
                  </span>
                </span>
              ) : (
                <span>
                  <MessageSquare size={14} aria-hidden="true" />
                  {label("Messages today", "Pesan hari ini")}{" "}
                  <span className="mono">
                    {state.usage.messages} / {MESSAGE_LIMIT}
                  </span>
                </span>
              )}
            </div>
          ) : (
            <p>
              {reviewing
                ? label(
                    "Edit anything that isn’t right. Only what you submit from this page reaches investigators.",
                    "Ubah apa pun yang kurang tepat. Hanya yang Anda kirim dari halaman ini yang diterima penyelidik.",
                  )
                : label(
                    "Describe what happened in your own words. Nothing reaches investigators until you review the report and submit it.",
                    "Ceritakan apa yang terjadi dengan kata-kata Anda sendiri. Tidak ada yang sampai ke penyelidik sebelum Anda meninjau dan mengirim laporan.",
                  )}
            </p>
          )}
        </div>
        {!reviewing && (
          <div className="lx-row">
            <button
              type="button"
              className="ds-button ds-button-ghost"
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
            {active && !expired && (
              <button
                type="button"
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
          </div>
        )}
      </div>

      {active && state && !expired && !codeSaved && (
        <section
          className="lx-secret"
          aria-label={label(
            "Continue your conversation",
            "Lanjutkan percakapan Anda",
          )}
        >
          <AlertTriangle size={24} aria-hidden="true" />
          <div className="lx-secret-body">
            <div>
              <h2>
                {label(
                  "Save your continuation code",
                  "Simpan kode untuk melanjutkan",
                )}
              </h2>
              <p>
                {label(
                  `Anyone with this code can open your unfinished conversation. It is not a report number, and it stops working 24 hours after you started (${expiresAt}). Save it now — once you leave this page it can’t be shown again.`,
                  `Siapa pun yang memiliki kode ini dapat membuka percakapan Anda yang belum selesai. Ini bukan nomor laporan, dan berhenti berlaku 24 jam sejak dimulai (${expiresAt}). Simpan sekarang — setelah Anda meninggalkan halaman ini, kode tidak dapat ditampilkan lagi.`,
                )}
              </p>
            </div>
            <p className="lx-code">{active.code}</p>
            <div className="lx-row">
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
                <Copy size={16} aria-hidden="true" />
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
                <Download size={16} aria-hidden="true" />
                {label("Download code", "Unduh kode")}
              </button>
              <button type="button" onClick={() => setCodeSaved(true)}>
                {label("I’ve saved it", "Sudah saya simpan")}
              </button>
            </div>
          </div>
        </section>
      )}
      {active && state && !expired && codeSaved && (
        <p className="lx-saved">
          <strong>
            <KeyRound size={16} aria-hidden="true" />
            {label(
              "Continuation code saved",
              "Kode untuk melanjutkan tersimpan",
            )}
          </strong>
          <span className="muted">
            {label(
              `Resume from any device until ${expiresAt}`,
              `Lanjutkan dari perangkat mana pun hingga ${expiresAt}`,
            )}
          </span>
          <button
            type="button"
            className="ds-button ds-button-ghost ds-button-sm"
            onClick={() => setCodeSaved(false)}
          >
            {label("Show code", "Tampilkan kode")}
          </button>
        </p>
      )}

      <div className="intake-layout">
        <div className="intake-primary">
          {reviewing ? (
            children
          ) : (
            <div className="intake-card">
              <div className="intake-card-head">
                <span>
                  <Lock size={16} aria-hidden="true" />
                  {label("Your Assistant", "Asisten Anda")}
                </span>
                <span className="badge badge-dot">
                  {label("Private", "Pribadi")}
                </span>
              </div>
              <div
                className="intake-log"
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
                    {m.role === "assistant" && (
                      <span className="intake-avatar" aria-hidden="true">
                        <MessageSquare size={16} />
                      </span>
                    )}
                    <div className="markdown-content">
                      <strong className="sr-only">
                        {m.role === "assistant"
                          ? label("Assistant", "Asisten")
                          : label("You", "Anda")}
                      </strong>
                      <SafeMarkdown content={m.content} />
                    </div>
                  </article>
                ))}
                {sending && (
                  <article
                    className="intake-message assistant"
                    aria-label={label(
                      "The assistant is replying",
                      "Asisten sedang membalas",
                    )}
                  >
                    <span className="intake-avatar" aria-hidden="true">
                      <MessageSquare size={16} />
                    </span>
                    <div className="markdown-content" aria-hidden="true">
                      <span className="typing-dot">●</span>{" "}
                      <span className="typing-dot">●</span>{" "}
                      <span className="typing-dot">●</span>
                    </div>
                  </article>
                )}
              </div>
              {showConsent && (
                <div className="intake-consent lx-card lx-stack">
                  <div>
                    <h2>
                      {active
                        ? label("Before you continue", "Sebelum melanjutkan")
                        : label("Before you start", "Sebelum memulai")}
                    </h2>
                    <p>
                      {label(
                        "You can report anonymously. Optional contact details stay hidden from staff, but what you describe may still identify you. Only the report you review and submit is shared with investigators.",
                        "Anda dapat melapor secara anonim. Kontak opsional disembunyikan dari staf, tetapi cerita Anda tetap dapat mengungkap identitas Anda. Hanya laporan yang Anda tinjau dan kirim yang dibagikan kepada penyelidik.",
                      )}
                    </p>
                    <details>
                      <summary>
                        {label(
                          "Read the policy and privacy notice",
                          "Baca kebijakan dan pemberitahuan privasi",
                        )}
                      </summary>
                      <h3>{label("Policy", "Kebijakan")}</h3>
                      <p>{company.policy[lang]}</p>
                      <h3>
                        {label("Privacy notice", "Pemberitahuan privasi")}
                      </h3>
                      <p>{company.privacyNotice[lang]}</p>
                    </details>
                  </div>
                  <div className="lx-well lx-stack">
                    <Check
                      label={label(
                        "I have read the policy and privacy notice.",
                        "Saya telah membaca kebijakan dan pemberitahuan privasi.",
                      )}
                      checked={policy}
                      onChange={(e) => onPolicy(e.target.checked)}
                    />
                    {aiAvailable && (
                      <Check
                        label={label(
                          "I consent to MiniMax processing this private conversation to help prepare my report.",
                          "Saya menyetujui MiniMax memproses percakapan pribadi ini untuk membantu menyiapkan laporan saya.",
                        )}
                        checked={consent}
                        onChange={(e) => onConsent(e.target.checked)}
                      />
                    )}
                  </div>
                </div>
              )}
              {(a.error || expired || !aiAvailable) && (
                <div className="intake-alert">
                  <ErrorBox error={a.error} />
                  {expired && (
                    <p role="alert" className="error">
                      {label(
                        "This conversation has expired. Start a new conversation or use the form.",
                        "Percakapan ini telah kedaluwarsa. Mulai percakapan baru atau gunakan formulir.",
                      )}
                    </p>
                  )}
                  {!aiAvailable && (
                    <p role="status" className="lx-help">
                      {label(
                        "The assistant is unavailable. You can use the form instead.",
                        "Asisten tidak tersedia. Anda dapat menggunakan formulir.",
                      )}
                    </p>
                  )}
                </div>
              )}
              <form
                className="intake-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!canSend || sendLock.current) return;
                  sendLock.current = true;
                  void a.run(send).finally(() => {
                    sendLock.current = false;
                  });
                }}
              >
                <label htmlFor="intake-message" className="sr-only">
                  {label("Message to assistant", "Pesan untuk asisten")}
                </label>
                <textarea
                  id="intake-message"
                  enterKeyHint="send"
                  rows={3}
                  maxLength={4000}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key !== "Enter" ||
                      e.shiftKey ||
                      e.nativeEvent.isComposing ||
                      e.keyCode === 229
                    )
                      return;
                    e.preventDefault();
                    if (canSend && !e.repeat)
                      e.currentTarget.form?.requestSubmit();
                  }}
                  aria-describedby="intake-message-shortcuts"
                  required
                  disabled={a.busy || expired}
                  placeholder={
                    allowed
                      ? active
                        ? label("Type your answer", "Ketik jawaban Anda")
                        : label(
                            "Describe what happened",
                            "Ceritakan apa yang terjadi",
                          )
                      : aiAvailable
                        ? label(
                            "Tick both boxes above to start",
                            "Centang kedua kotak di atas untuk memulai",
                          )
                        : ""
                  }
                />
                <div className="intake-composer-bar">
                  <span className="lx-help">
                    {active
                      ? label(
                          "Unknown details can stay unknown. Answer “I don’t know” and move on.",
                          "Detail yang tidak diketahui boleh dikosongkan. Jawab “Saya tidak tahu” lalu lanjutkan.",
                        )
                      : label(
                          "Your first message creates a private, encrypted draft.",
                          "Pesan pertama Anda membuat draf pribadi yang terenkripsi.",
                        )}
                  </span>
                  <span className="lx-row">
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
                    <button disabled={!canSend}>
                      <Send size={16} aria-hidden="true" />
                      {a.busy && sending
                        ? label("Please wait…", "Mohon tunggu…")
                        : label("Send", "Kirim")}
                    </button>
                  </span>
                </div>
                <p id="intake-message-shortcuts" className="lx-help">
                  {label(
                    "Enter to send · Shift+Enter for a new line.",
                    "Enter untuk mengirim · Shift+Enter untuk baris baru.",
                  )}
                </p>
              </form>
            </div>
          )}
        </div>

        <div className="intake-aside">
          <Evidence
            t={(key) =>
              ({
                files: label("Evidence", "Bukti"),
                upload: label("Attach evidence", "Lampirkan bukti"),
                preview: label("Preview", "Pratinjau"),
                delete: label("Remove", "Hapus"),
                redact: label("Apply redaction", "Terapkan penyamaran"),
                review: label(
                  "I reviewed every page and removed identifying details.",
                  "Saya meninjau setiap halaman dan menghapus detail identitas.",
                ),
                approve: label("Approve evidence", "Setujui bukti"),
                quarantined: label("Processing", "Diproses"),
                approved: label("Approved", "Disetujui"),
                rejected: label("Processing failed", "Pemrosesan gagal"),
                page: label("Page", "Halaman"),
              })[key] ?? key
            }
            lang={lang}
            closed={expired}
            intake={active}
            beforeUpload={ensureActive}
            uploadDisabled={!policy || a.busy || expired}
          />
          {!active && !reviewing && (
            <>
              <section
                className="lx-panel lx-stack"
                aria-labelledby="how-it-works"
              >
                <h2 id="how-it-works">
                  {label("How it works", "Cara kerjanya")}
                </h2>
                <ol className="intake-steps">
                  {[
                    [
                      label(
                        "Describe what happened.",
                        "Ceritakan apa yang terjadi.",
                      ),
                      label(
                        "The assistant asks one question at a time.",
                        "Asisten bertanya satu per satu.",
                      ),
                    ],
                    [
                      label(
                        "Save your continuation code.",
                        "Simpan kode untuk melanjutkan.",
                      ),
                      label(
                        "Pick up on any device for 24 hours.",
                        "Lanjutkan dari perangkat mana pun selama 24 jam.",
                      ),
                    ],
                    [
                      label("Review the report.", "Tinjau laporan."),
                      label(
                        "Edit the draft and check it for anything that identifies you.",
                        "Ubah draf dan periksa hal yang dapat mengidentifikasi Anda.",
                      ),
                    ],
                    [
                      label(
                        "Submit and save your credentials.",
                        "Kirim dan simpan kredensial.",
                      ),
                      label(
                        "You’ll use them to follow up.",
                        "Anda memerlukannya untuk menindaklanjuti.",
                      ),
                    ],
                  ].map(([title, text], i) => (
                    <li key={i}>
                      <span>{i + 1}</span>
                      <span>
                        <strong>{title}</strong> {text}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
              <section
                id="continue"
                className="lx-panel lx-stack intake-resume"
                aria-labelledby="continue-heading"
              >
                <div>
                  <h2 id="continue-heading">
                    {label("Continue a conversation", "Lanjutkan percakapan")}
                  </h2>
                  <p className="lx-help">
                    {label(
                      "Enter the continuation code you saved. Codes work for 24 hours from the start and are never extended. Submitted reports use the case portal.",
                      "Masukkan kode yang Anda simpan. Kode berlaku 24 jam sejak dimulai dan tidak diperpanjang. Laporan yang sudah dikirim menggunakan portal laporan.",
                    )}
                  </p>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void r.run(async () => {
                      const parsed = continuationCodeSchema.safeParse(resume);
                      if (!parsed.success)
                        throw new ApiError(
                          401,
                          "invalid_intake",
                          "Invalid continuation code",
                        );
                      const code = parsed.data;
                      const next = await api<PrivateIntakeView>(
                        "/privacy/intake/resume",
                        {
                          method: "POST",
                          headers: { "x-intake-code": code },
                          body: {},
                        },
                      );
                      setCodeSaved(true);
                      adopt({ id: next.id, code }, next);
                      setResume("");
                    });
                  }}
                >
                  <Field
                    label={label("Continuation code", "Kode untuk melanjutkan")}
                    value={resume}
                    placeholder="ABCD-EFGH"
                    onChange={(e) => setResume(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <ErrorBox error={r.error} />
                  <button className="secondary" disabled={r.busy}>
                    {label("Continue conversation", "Lanjutkan percakapan")}
                  </button>
                </form>
              </section>
            </>
          )}
          {active && (
            <section
              className="lx-panel lx-stack"
              aria-labelledby="keep-private"
            >
              <h2 id="keep-private">
                {label("Keep it private", "Jaga kerahasiaan")}
              </h2>
              <ul>
                <li>
                  {label(
                    "Leave out your own name, role and contact details.",
                    "Jangan sertakan nama, jabatan, dan kontak Anda sendiri.",
                  )}
                </li>
                <li>
                  {label(
                    "Nothing here alerts staff. Only a submitted report creates a case.",
                    "Tidak ada yang memberi tahu staf. Hanya laporan terkirim yang membuat kasus.",
                  )}
                </li>
                <li>
                  {label(
                    "Switching language changes the next replies. Earlier messages stay as written.",
                    "Mengganti bahasa mengubah balasan berikutnya. Pesan sebelumnya tetap seperti semula.",
                  )}
                </li>
              </ul>
              {discarding ? (
                <div className="lx-well lx-stack">
                  <p>
                    {label(
                      "Delete this conversation, its draft and attached evidence? This can’t be undone.",
                      "Hapus percakapan ini, drafnya, dan bukti terlampir? Tindakan ini tidak dapat dibatalkan.",
                    )}
                  </p>
                  <div className="lx-row">
                    <button
                      type="button"
                      className="ds-button ds-button-danger"
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          if (!expired) await call(active, "", "DELETE");
                          setActive(undefined);
                          setState(undefined);
                          setBody("");
                          setExpired(false);
                          setDiscarding(false);
                          creation.current = null;
                          request.current = null;
                          onIntake(null);
                          onConsent(false);
                          onPolicy(false);
                        })
                      }
                    >
                      {label("Yes, discard", "Ya, hapus")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setDiscarding(false)}
                    >
                      {label("Keep conversation", "Simpan percakapan")}
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <button
                    type="button"
                    className="ds-button ds-button-danger-outline ds-button-sm"
                    disabled={a.busy}
                    onClick={() => setDiscarding(true)}
                  >
                    {label("Discard conversation", "Hapus percakapan")}
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
