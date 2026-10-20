"use client";
import Link from "next/link";
import { ArrowRight, FileText, LockKeyhole, ShieldCheck } from "lucide-react";
import { Shell, useLanguage } from "@/components/suite/common";
export default function Home() {
  const l = useLanguage();
  return (
    <Shell language={l}>
      <section className="home-hero">
        <p className="eyebrow">{l.t("noAccount")}</p>
        <h1>{l.t("home")}</h1>
        <p>{l.t("privacy")}</p>
        <div className="home-actions">
          <Link className="button" href="/report">
            {l.t("report")}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
          <Link className="button button-secondary" href="/report#continue">
            {l.lang === "id"
              ? "Lanjutkan percakapan"
              : "Continue a conversation"}
          </Link>
          <Link className="button button-secondary" href="/case">
            {l.t("portal")}
          </Link>
        </div>
      </section>
      <div className="grid">
        <section className="home-card">
          <FileText size={24} aria-hidden="true" />
          <h2>{l.t("report")}</h2>
          <p>{l.t("reportIntro")}</p>
        </section>
        <section className="home-card">
          <LockKeyhole size={24} aria-hidden="true" />
          <h2>{l.t("portal")}</h2>
          <p>{l.t("caseIntro")}</p>
        </section>
      </div>
      <div className="privacy-note">
        <ShieldCheck size={18} aria-hidden="true" />
        <p>
          {l.t("noAccount")} · {l.t("confidential")}
        </p>
      </div>
    </Shell>
  );
}
