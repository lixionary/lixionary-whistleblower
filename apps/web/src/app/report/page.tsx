"use client";
import { useEffect, useState, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import {
  Shell,
  useLanguage,
  useAction,
  Field,
  Text,
  Check,
  Select,
  ErrorBox,
  Receipt,
} from "@/components/suite/common";
import {
  reporterRelationships,
  type CompanySettings,
  type ReporterRelationship,
  type IntakeReview,
} from "@whistle/shared";

import { IntakeChat, type ActiveIntake } from "@/components/suite/intake-chat";

type Company = Pick<
  CompanySettings,
  | "companyName"
  | "policy"
  | "privacyNotice"
  | "categories"
  | "businessUnits"
  | "aiEnabled"
> & { version: number };

export default function Report() {
  const l = useLanguage(),
    { t, lang } = l,
    a = useAction(lang);
  const [company, setCompany] = useState<Company>(),
    [receipt, setReceipt] = useState<{
      caseCode: string;
      pin: string;
      recoveryCode: string;
      capability?: string;
      challengeId?: string;
      reporterEmail?: string;
    }>();
  const submission = useRef<{
    pin: string;
    recoveryCode: string;
    submissionToken: string;
  } | null>(null);

  const newSecret = () =>
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");

  const crockford = (groups: number = 2) => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const bytes = crypto.getRandomValues(new Uint8Array(groups * 4));
    const parts: string[] = [];
    for (let g = 0; g < groups; g++) {
      let part = "";
      for (let i = 0; i < 4; i++) {
        part += alphabet[bytes[g * 4 + i]! % alphabet.length];
      }
      parts.push(part);
    }
    return parts.join("-");
  };

  const [details, setDetails] = useState<Record<string, string>>({});
  const [title, setTitle] = useState(""),
    [summary, setSummary] = useState(""),
    [category, setCategory] = useState("other"),
    [unit, setUnit] = useState(""),
    [relationship, setRelationship] =
      useState<ReporterRelationship>("employee"),
    [sensitive, setSensitive] = useState(false),
    [reporterEmail, setReporterEmail] = useState(""),
    [hp, setHp] = useState(""),
    [review, setReview] = useState(false),
    [policy, setPolicy] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [mode, setMode] = useState<"chat" | "review">("chat");
  const [intake, setIntake] = useState<ActiveIntake | null>(null);
  const [draftStatus, setDraftStatus] = useState("");
  const saveGeneration = useRef(0);
  const reviewDraft = (): IntakeReview => ({
    title,
    summary,
    category,
    businessUnit: unit,
    relationship,
    sensitive,
    reporterEmail: reporterEmail.trim() || undefined,
    details,
    locale: lang,
  });
  async function saveDraft() {
    if (!intake) return;
    await api(`/privacy/intake/${intake.id}`, {
      method: "PATCH",
      headers: { "x-intake-code": intake.code },
      body: { locale: lang, draft: reviewDraft() },
    });
  }
  useEffect(() => {
    if (!intake || mode !== "review") return;
    const generation = ++saveGeneration.current;
    setDraftStatus(lang === "id" ? "Menyimpan draf…" : "Saving draft…");
    const timer = setTimeout(() => {
      void saveDraft()
        .then(() => {
          if (saveGeneration.current === generation)
            setDraftStatus(lang === "id" ? "Draf tersimpan" : "Draft saved");
        })
        .catch(() => {
          if (saveGeneration.current === generation)
            setDraftStatus(
              lang === "id"
                ? "Draf belum tersimpan. Gunakan Simpan draf untuk mencoba lagi."
                : "Draft not saved. Use Save draft to retry.",
            );
        });
    }, 600);
    return () => {
      clearTimeout(timer);
      ++saveGeneration.current;
    };
  }, [
    intake?.id,
    mode,
    title,
    summary,
    category,
    unit,
    relationship,
    sensitive,
    reporterEmail,
    details,
    lang,
  ]);
  async function refreshPolicy() {
    const current = await api<Company>("/api/reporter/company");
    setCompany(current);
    setPolicy(false);
    setReview(false);
    if (!current.categories.some((c) => c.key === category))
      setCategory(current.categories[0]!.key);
    if (unit && !current.businessUnits.includes(unit)) setUnit("");
  }
  function openReview(draft: IntakeReview) {
    setTitle(draft.title);
    setSummary(draft.summary);
    setDetails(draft.details);
    setCategory(
      company?.categories.some((c) => c.key === draft.category)
        ? draft.category
        : company!.categories[0]!.key,
    );
    setUnit(
      company?.businessUnits.includes(draft.businessUnit)
        ? draft.businessUnit
        : "",
    );
    setRelationship(draft.relationship);
    setSensitive(draft.sensitive);
    setReporterEmail(draft.reporterEmail ?? "");
    setReview(false);
    setMode("review");
  }

  useEffect(() => {
    void api<Company>("/api/reporter/company")
      .then((c) => {
        setCompany(c);
        setCategory(c.categories[0]!.key);
      })
      .catch((e) => a.setError(String(e)));
  }, []);

  const detail = (key: string) => ({
    value: details[key] ?? "",
    maxLength: 5000,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDetails({ ...details, [key]: e.target.value }),
  });
  const label = (en: string, id: string) => (lang === "id" ? id : en);
  const intro = (id: string, title: string, text: string) => (
    <div className="review-intro">
      <h2 id={id}>{title}</h2>
      <p>{text}</p>
    </div>
  );

  return (
    <Shell language={l} wide={!receipt}>
      {mode !== "review" && <ErrorBox error={a.error} />}
      {receipt ? (
        <Receipt
          submitted
          receipt={{ ...receipt, recoverySecret: receipt.recoveryCode }}
          t={t}
          onDone={() => {
            setReceipt(undefined);
            window.location.href = "/case";
          }}
        />
      ) : company ? (
        <IntakeChat
          lang={lang}
          company={company}
          policy={policy}
          consent={aiConsent}
          onPolicy={setPolicy}
          onConsent={setAiConsent}
          onReview={openReview}
          onFallback={() => {
            setReview(false);
            setMode("review");
          }}
          onIntake={setIntake}
          onPolicyChanged={refreshPolicy}
          reviewing={mode === "review"}
        >
          <form
            className="review-form"
            aria-label={label("Review report", "Tinjau laporan")}
            onChange={(e) => {
              if (!(
                e.target instanceof HTMLInputElement &&
                ["privacy-review", "policy", "ai-consent"].includes(
                  e.target.name,
                )
              ))
                setReview(false);
            }}
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                submission.current ??= {
                  pin: crockford(2),
                  recoveryCode: crockford(4),
                  submissionToken: newSecret(),
                };
                const r = await api<{
                  caseCode: string;
                  pin: string;
                  recoveryCode: string;
                  capability?: string;
                  challengeId?: string;
                  reporterEmail?: string;
                }>("/api/reporter/reports", {
                  method: "POST",
                  body: {
                    submission: submission.current,
                    title,
                    summary,
                    category,
                    businessUnit: unit,
                    relationship,
                    sensitive,
                    reporterEmail: reporterEmail.trim() || undefined,
                    hp: hp || undefined,
                    details,
                    locale: lang,
                    privacyReviewed: true,
                    policyVersion: company.version,
                    aiConsent,
                    ...(intake
                      ? { intakeId: intake.id, intakeToken: intake.code }
                      : {}),
                  },
                }).catch(async (e) => {
                  if (e instanceof ApiError && e.code === "policy_changed") {
                    const current = await api<Company>("/api/reporter/company");
                    setCompany(current);
                    if (!current.categories.some((c) => c.key === category))
                      setCategory(current.categories[0]!.key);
                    if (unit && !current.businessUnits.includes(unit))
                      setUnit("");
                    setPolicy(false);
                    setReview(false);
                  }
                  throw e;
                });
                setIntake(null);
                setReceipt(r);
                submission.current = null;
                setTitle("");
                setSummary("");
                setReporterEmail("");
                setHp("");
                setDetails({});
                setReview(false);
                setPolicy(false);
                setAiConsent(false);
              });
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "-9999px",
                opacity: 0,
                pointerEvents: "none",
              }}
              aria-hidden="true"
            >
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                value={hp}
                onChange={(e) => setHp(e.target.value)}
              />
            </div>
            <section className="review-section" aria-labelledby="review-report">
              {intro(
                "review-report",
                label("Report", "Laporan"),
                label(
                  "Investigators read these first.",
                  "Penyelidik membaca bagian ini lebih dulu.",
                ),
              )}
              <div className="review-fields">
                <Field
                  label={t("title")}
                  required
                  minLength={5}
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Text
                  label={t("summary")}
                  required
                  rows={6}
                  minLength={20}
                  maxLength={10000}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                />
              </div>
            </section>
            <section
              className="review-section"
              aria-labelledby="review-details"
            >
              {intro(
                "review-details",
                label("Details", "Detail"),
                label(
                  "Optional. Leave anything you don’t know blank.",
                  "Opsional. Kosongkan yang tidak Anda ketahui.",
                ),
              )}
              <div className="review-fields">
                <Text label={t("what")} rows={3} {...detail("what")} />
                <Field label={t("who")} {...detail("who")} />
                <div className="review-pair">
                  <Field label={t("when")} {...detail("when")} />
                  <Field label={t("where")} {...detail("where")} />
                </div>
                <Text label={t("how")} rows={2} {...detail("how")} />
                <Text label={t("why")} rows={2} {...detail("why")} />
                <Text label={t("howKnown")} rows={2} {...detail("howKnown")} />
                <Field label={t("evidence")} {...detail("evidence")} />
                <Text label={t("impact")} rows={2} {...detail("impact")} />
                <fieldset>
                  <legend>{t("ongoing")}</legend>
                  <div className="lx-segmented">
                    {(
                      [
                        ["yes", label("Yes", "Ya")],
                        ["no", label("No", "Tidak")],
                        ["unknown", label("Not sure", "Tidak yakin")],
                      ] as const
                    ).map(([value, text]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="ongoing"
                          value={value}
                          checked={details.ongoing === value}
                          onChange={() =>
                            setDetails({ ...details, ongoing: value })
                          }
                        />
                        {text}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </section>
            <section
              className="review-section"
              aria-labelledby="review-classification"
            >
              {intro(
                "review-classification",
                label("Classification", "Klasifikasi"),
                label(
                  "Helps the case manager route and prioritise.",
                  "Membantu manajer kasus menentukan tujuan dan prioritas.",
                ),
              )}
              <div className="review-fields">
                <div className="review-pair">
                  <Select
                    label={t("category")}
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  >
                    {company.categories.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c[lang]}
                      </option>
                    ))}
                  </Select>
                  {company.businessUnits.length > 0 && (
                    <Select
                      label={t("businessUnit")}
                      value={unit}
                      onChange={(e) => setUnit(e.target.value)}
                    >
                      <option value="">
                        {label("Not sure", "Tidak yakin")}
                      </option>
                      {company.businessUnits.map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </Select>
                  )}
                </div>
                <fieldset>
                  <legend>{t("relationship")}</legend>
                  <div className="lx-choices">
                    {reporterRelationships.map((r) => (
                      <label key={r} className="lx-choice">
                        <input
                          type="radio"
                          name="relationship"
                          value={r}
                          checked={relationship === r}
                          onChange={() => setRelationship(r)}
                        />
                        {t(`rel_${r}`)}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </section>
            <section
              className="review-section"
              aria-labelledby="review-routing"
            >
              {intro(
                "review-routing",
                label("Sensitive routing", "Penanganan sensitif"),
                label(
                  "Your choice, separate from the category.",
                  "Pilihan Anda, terpisah dari kategori.",
                ),
              )}
              <div className="review-fields">
                <div className="lx-card lx-toggle">
                  <button
                    type="button"
                    role="switch"
                    className="ds-button lx-switch"
                    aria-checked={sensitive}
                    aria-labelledby="sensitive-label"
                    aria-describedby="sensitive-help"
                    onClick={() => setSensitive(!sensitive)}
                  />
                  <span className="lx-toggle-text">
                    <strong id="sensitive-label">
                      {label(
                        "Send to the independent review team",
                        "Kirim ke tim peninjau independen",
                      )}
                    </strong>
                    <span id="sensitive-help">{t("sensitive")}</span>
                  </span>
                </div>
              </div>
            </section>
            <section
              className="review-section"
              aria-labelledby="review-notifications"
            >
              {intro(
                "review-notifications",
                label("Notifications", "Notifikasi"),
                label(
                  "Optional. Never sent to the assistant or shown to investigators.",
                  "Opsional. Tidak pernah dikirim ke asisten atau ditampilkan kepada penyelidik.",
                ),
              )}
              <div className="review-fields">
                <Field
                  label={t("reporterEmail")}
                  type="email"
                  placeholder="you@example.com"
                  maxLength={254}
                  value={reporterEmail}
                  onChange={(e) => setReporterEmail(e.target.value)}
                />
                <p className="lx-help">{t("reporterEmailHint")}</p>
              </div>
            </section>
            <section className="review-section" aria-labelledby="review-submit">
              {intro(
                "review-submit",
                label("Before you submit", "Sebelum mengirim"),
                t("privacy"),
              )}
              <div className="review-fields">
                <div className="lx-card review-checks">
                  <details>
                    <summary>
                      {t("policy")} · {t("notice")}
                    </summary>
                    <h3>{company.companyName}</h3>
                    <p>{company.policy[lang]}</p>
                    <p>{company.privacyNotice[lang]}</p>
                  </details>
                  <Check
                    label={label(
                      "I have read the policy and privacy notice.",
                      "Saya telah membaca kebijakan dan pemberitahuan privasi.",
                    )}
                    name="policy"
                    checked={policy}
                    onChange={(e) => setPolicy(e.target.checked)}
                  />
                  {company.aiEnabled && (
                    <Check
                      label={t("aiConsent")}
                      name="ai-consent"
                      checked={aiConsent}
                      onChange={(e) => setAiConsent(e.target.checked)}
                    />
                  )}
                  <Check
                    label={t("review")}
                    name="privacy-review"
                    required
                    checked={review}
                    onChange={(e) => setReview(e.target.checked)}
                  />
                </div>
              </div>
            </section>
            <ErrorBox error={a.error} />
            <div className="review-footer">
              <button
                type="button"
                className="ds-button ds-button-ghost"
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await saveDraft();
                    setMode("chat");
                  })
                }
              >
                <ArrowLeft size={16} aria-hidden="true" />
                {label("Back to conversation", "Kembali ke percakapan")}
              </button>
              <div className="lx-row">
                {intake && (
                  <>
                    <p role="status">{draftStatus}</p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          await saveDraft();
                          setDraftStatus(
                            label("Draft saved", "Draf tersimpan"),
                          );
                        })
                      }
                    >
                      {label("Save draft", "Simpan draf")}
                    </button>
                  </>
                )}
                <button disabled={a.busy || !review || !policy}>
                  {t("submit")}
                </button>
              </div>
            </div>
          </form>
        </IntakeChat>
      ) : (
        <p>{t("loading")}</p>
      )}
    </Shell>
  );
}
