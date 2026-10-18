"use client";
import { useEffect, useState, useRef } from "react";
import { ReportGate } from "@/components/suite/report-gate";
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
} from "@whistle/shared";
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
    }>();
  const [reportToken, setReportToken] = useState(""),
    [gateOpen, setGateOpen] = useState(true);
  const reportApi = async <T,>(
    path: string,
    options: Parameters<typeof api>[1] = {},
  ) => {
    try {
      return await api<T>(path, {
        ...options,
        headers: { ...options.headers, "x-report-access": reportToken },
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "report_access_required")
        setGateOpen(true);
      throw e;
    }
  };
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
    [review, setReview] = useState(false),
    [policy, setPolicy] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
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
      {gateOpen && !receipt && (
        <ReportGate
          lang={lang}
          resumeToken={reportToken || undefined}
          onVerified={(raw) => {
            setReportToken(raw);
            setGateOpen(false);
            a.setError("");
          }}
          onCancel={() => setGateOpen(false)}
        />
      )}
      {!reportToken && !receipt && (
        <section>
          <h1>{t("report")}</h1>
          <p>
            {lang === "id"
              ? "Verifikasi email karyawan Anda untuk memulai."
              : "Verify your employee email to begin."}
          </p>
          <button onClick={() => setGateOpen(true)}>
            {lang === "id" ? "Verifikasi email" : "Verify email"}
          </button>
        </section>
      )}
      {receipt ? (
        <Receipt
          receipt={{ ...receipt, recoverySecret: receipt.recoveryCode }}
          t={t}
          onDone={() => {
            setReceipt(undefined);
            window.location.href = "/case";
          }}
        />
      ) : company && reportToken ? (
        <>
          <h1>{t("report")}</h1>
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
              onSubmit={(e) => {
                e.preventDefault();
                void a.run(async () => {
                  submission.current ??= {
                    pin: crockford(2),
                    recoveryCode: crockford(4),
                    submissionToken: newSecret(),
                  };
                  const r = await reportApi<{
                    caseCode: string;
                    pin: string;
                    recoveryCode: string;
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
                      details,
                      locale: lang,
                      privacyReviewed: true,
                      policyVersion: company.version,
                      aiConsent,
                    },
                  }).catch(async (e) => {
                    if (e instanceof ApiError && e.code === "policy_changed") {
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
                  setReceipt(r);
                  setReportToken("");
                  setGateOpen(false);
                  submission.current = null;
                  setTitle("");
                  setSummary("");
                  setDetails({});
                  setReview(false);
                  setPolicy(false);
                  setAiConsent(false);
                });
              }}
            >
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
                required
                checked={review}
                onChange={(e) => setReview(e.target.checked)}
              />
              <button disabled={a.busy || !review || !policy}>
                {t("submit")}
              </button>
            </form>
          </section>
        </>
      ) : !company ? (
        <p>{t("loading")}</p>
      ) : null}
    </Shell>
  );
}
