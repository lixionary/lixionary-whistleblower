"use client";
import { useEffect, useState, useRef } from "react";
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

  return (
    <Shell language={l}>
      <ErrorBox error={a.error} />
      {receipt ? (
        <Receipt
          receipt={{ ...receipt, recoverySecret: receipt.recoveryCode }}
          t={t}
          onDone={() => {
            setReceipt(undefined);
            window.location.href = "/case";
          }}
        />
      ) : company ? (
        <>
          <h1>{t("report")}</h1>
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
          />
          <div hidden={mode !== "review"}>
            <h2>
              {lang === "id" ? "Tinjau laporan Anda" : "Review your report"}
            </h2>
            <button
              type="button"
              className="secondary"
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  await saveDraft();
                  setMode("chat");
                })
              }
            >
              {lang === "id" ? "Kembali ke percakapan" : "Back to conversation"}
            </button>
            <section>
              <h2>{company.companyName}</h2>
              <details open>
                <summary>{t("policy")}</summary>
                <p>{company.policy[lang]}</p>
              </details>
              <details open>
                <summary>{t("notice")}</summary>
                <p>{company.privacyNotice[lang]}</p>
              </details>
              <Check
                label={
                  lang === "id"
                    ? "Saya telah membaca kebijakan dan pemberitahuan privasi."
                    : "I have read the policy and privacy notice."
                }
                checked={policy}
                onChange={(e) => setPolicy(e.target.checked)}
              />
            </section>
            <section>
              <form
                aria-label={lang === "id" ? "Tinjau laporan" : "Review report"}
                onChange={(e) => {
                  if (!(
                    e.target instanceof HTMLInputElement &&
                    e.target.name === "privacy-review"
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
                      if (
                        e instanceof ApiError &&
                        e.code === "policy_changed"
                      ) {
                        const current = await api<Company>(
                          "/api/reporter/company",
                        );
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
                <Field
                  label={t("title")}
                  required
                  minLength={5}
                  maxLength={200}
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setReview(false);
                  }}
                />
                <Text
                  label={t("summary")}
                  required
                  minLength={20}
                  maxLength={10000}
                  value={summary}
                  onChange={(e) => {
                    setSummary(e.target.value);
                    setReview(false);
                  }}
                />
                <Field
                  label={t("reporterEmail")}
                  type="email"
                  maxLength={254}
                  value={reporterEmail}
                  onChange={(e) => {
                    setReporterEmail(e.target.value);
                    setReview(false);
                  }}
                />
                <p
                  style={{
                    fontSize: "0.875rem",
                    color: "var(--muted, #666)",
                    marginTop: "-0.5rem",
                    marginBottom: "1rem",
                  }}
                >
                  {t("reporterEmailHint")}
                </p>
                <details open={Object.values(details).some(Boolean)}>
                  <summary>
                    {lang === "id"
                      ? "Detail tambahan (opsional)"
                      : "Additional details (optional)"}
                  </summary>
                  {[
                    "what",
                    "who",
                    "when",
                    "where",
                    "why",
                    "how",
                    "howKnown",
                    "evidence",
                    "impact",
                    "ongoing",
                  ].map((key) => (
                    <Text
                      key={key}
                      label={t(key)}
                      maxLength={5000}
                      value={details[key] ?? ""}
                      onChange={(e) => {
                        setDetails({ ...details, [key]: e.target.value });
                        setReview(false);
                      }}
                    />
                  ))}
                </details>
                <Select
                  label={t("relationship")}
                  value={relationship}
                  onChange={(e) =>
                    setRelationship(e.target.value as ReporterRelationship)
                  }
                >
                  {reporterRelationships.map((r) => (
                    <option key={r} value={r}>
                      {t(`rel_${r}`)}
                    </option>
                  ))}
                </Select>
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
                    <option value="">—</option>
                    {company.businessUnits.map((u) => (
                      <option key={u}>{u}</option>
                    ))}
                  </Select>
                )}
                <Check
                  label={t("sensitive")}
                  checked={sensitive}
                  onChange={(e) => setSensitive(e.target.checked)}
                />
                {company.aiEnabled && (
                  <Check
                    label={t("aiConsent")}
                    checked={aiConsent}
                    onChange={(e) => setAiConsent(e.target.checked)}
                  />
                )}
                <p>{t("privacy")}</p>
                <Check
                  label={t("review")}
                  name="privacy-review"
                  required
                  checked={review}
                  onChange={(e) => setReview(e.target.checked)}
                />
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
                            lang === "id" ? "Draf tersimpan" : "Draft saved",
                          );
                        })
                      }
                    >
                      {lang === "id" ? "Simpan draf" : "Save draft"}
                    </button>
                  </>
                )}
                <button disabled={a.busy || !review || !policy}>
                  {t("submit")}
                </button>
              </form>
            </section>
          </div>
        </>
      ) : !company ? (
        <p>{t("loading")}</p>
      ) : null}
    </Shell>
  );
}
