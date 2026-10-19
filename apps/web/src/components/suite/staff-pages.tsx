"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useStaff } from "./staff-workspace";
import { Analytics } from "./analytics";
import { Dashboard } from "./dashboard";
import { ErrorBox, StatusBadge, useAction } from "./common";
export function StaffAnalytics() {
  const {
    language: { lang, t },
  } = useStaff();
  return (
    <>
      <h1>{t("statistics")}</h1>
      <Analytics lang={lang} t={t} />
    </>
  );
}
export function StaffDashboard() {
  const {
    language: { lang, t },
  } = useStaff();
  return (
    <>
      <h1>{t("dashboard")}</h1>
      <Dashboard lang={lang} t={t} />
    </>
  );
}
export function StaffAccount() {
  const {
      user,
      language: { lang, t },
    } = useStaff(),
    a = useAction(lang);
  const [sessions, setSessions] = useState<
    { id: string; expires_at: string }[]
  >([]);
  const load = useCallback(async () => {
    setSessions(await api("/api/staff/sessions"));
  }, []);
  useEffect(() => {
    void a.run(load);
  }, [load]);
  return (
    <>
      <h1>{t("account")}</h1>
      <ErrorBox error={a.error} />
      <section>
        <h2>{user.name}</h2>
        <p>{user.email}</p>
        <StatusBadge state={user.role}>{t(user.role)}</StatusBadge>
      </section>
      <section>
        <h2>{t("sessions")}</h2>
        <button disabled={a.busy} onClick={() => void a.run(load)}>
          {t("refresh")}
        </button>
        {sessions.map((s) => (
          <article key={s.id}>
            <p>{new Date(s.expires_at).toLocaleString(lang)}</p>
            <button
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  await api(`/api/staff/sessions/${s.id}`, {
                    method: "DELETE",
                  });
                  await api("/api/staff/me");
                  await load();
                })
              }
            >
              {t("revoke")}
            </button>
          </article>
        ))}
      </section>
    </>
  );
}
