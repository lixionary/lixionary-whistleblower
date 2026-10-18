"use client";
import Link from "next/link";
import { useDraftState, useStaff, DiscardDraft } from "./staff-workspace";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import {
  defaultSettings,
  type CompanySettings,
  type StaffIdentity,
} from "@whistle/shared";
import { Check, ErrorBox, Field, Select, Text, useAction } from "./common";
type Staff = StaffIdentity & { active: boolean; mfa_enrolled: boolean };
type Team = {
  id: string;
  name: string;
  restricted: boolean;
  members: { id: string; name: string; role: string }[];
};
export type AdminSection =
  "teams" | "settings" | "history" | "operations" | "audit";
export function Admin({ section }: { section: AdminSection }) {
  const {
    language: { t, lang },
    clearDrafts,
  } = useStaff();
  const a = useAction(lang),
    [baseSettings, setBaseSettings] =
      useState<CompanySettings>(defaultSettings),
    [settings, setSettings] = useDraftState<CompanySettings>(
      "admin.settings.body",
      baseSettings,
    ),
    [ready, setReady] = useState(false),
    [saved, setSaved] = useState(false),
    [staff, setStaff] = useState<Staff[]>([]),
    [teams, setTeams] = useState<Team[]>([]),
    [teamName, setTeamName] = useDraftState("admin.teams.teamName", ""),
    [restricted, setRestricted] = useDraftState(
      "admin.teams.restricted",
      false,
    ),
    [auditUntil, setAuditUntil] = useState(0),
    [history, setHistory] = useState<
      { version: number; actor_id: string; created_at: string }[]
    >([]),
    [audit, setAudit] = useState<Record<string, unknown>[]>([]),
    [ops, setOps] = useState<{
      privacy: {
        unavailable?: boolean;
        providers?: { email: boolean; phone: boolean; ai: boolean };
        jobs?: { kind: string; pending: number; attempts: number }[];
        files?: { status: string; count: number }[];
      };
      jobs: { kind: string; pending: number; attempts: number }[];
      deletions: { pending: number }[];
    }>();
  const load = useCallback(async () => {
    if (section === "settings") {
      const [s, q] = await Promise.all([
        api<{ body: CompanySettings }>("/api/admin/settings"),
        api<{ teams: Team[] }>("/api/admin/teams"),
      ]);
      setBaseSettings(s.body);
      setTeams(q.teams);
    } else if (section === "teams") {
      const p = await api<{ staff: Staff[] }>("/api/admin/staff");
      setStaff(p.staff);
      setTeams((await api<{ teams: Team[] }>("/api/admin/teams")).teams);
    } else if (section === "history") {
      setHistory(
        (await api<{ history: typeof history }>("/api/admin/settings/history"))
          .history,
      );
    } else if (section === "operations")
      setOps(await api("/api/admin/operations"));
    else await auditPage();
    setReady(true);
  }, [section]);
  useEffect(() => {
    void a.run(load);
  }, [load]);
  useEffect(() => {
    if (a.error && section === "settings")
      document
        .querySelectorAll<HTMLDetailsElement>("[data-settings-group]")
        .forEach((group) => {
          group.open = true;
        });
  }, [a.error, section]);
  type AuditPage = { events: Record<string, unknown>[]; until: number };
  async function auditPage(after = 0, until?: number) {
    const r = await api<AuditPage>(
      `/api/admin/audit?after=${after}${until === undefined ? "" : `&until=${until}`}`,
    );
    setAuditUntil(r.until);
    setAudit(r.events);
    return r;
  }
  async function exportAudit() {
    let r = await api<AuditPage>("/api/admin/audit"),
      events = [...r.events];
    const until = r.until;
    while (r.events.length === 1000 && Number(r.events.at(-1)!.seq) < until) {
      r = await api<AuditPage>(
        `/api/admin/audit?after=${r.events.at(-1)!.seq}&until=${until}`,
      );
      events.push(...r.events);
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ until, events }, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "whistleblower-audit.json";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <ErrorBox error={a.error} />
      {!ready && (
        <>
          <p>{t("loading")}</p>
          <button disabled={a.busy} onClick={() => void a.run(load)}>
            {t("refresh")}
          </button>
        </>
      )}
      {saved && <p role="status">{t("savedChanges")}</p>}
      {section === "teams" && (
        <section>
          <h1>{t("teams")}</h1>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await api("/api/admin/teams", {
                  method: "POST",
                  body: { name: teamName, restricted },
                });
                setTeamName("");
                clearDrafts("admin.teams.");
                await load();
              });
            }}
          >
            <Field
              label={t("name")}
              required
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
            />
            <Check
              label={t("restricted")}
              checked={restricted}
              onChange={(e) => setRestricted(e.target.checked)}
            />
            <button disabled={a.busy}>{t("add")}</button>
            <DiscardDraft prefix="admin.teams." />
          </form>
          {teams.map((team) => (
            <article key={team.id}>
              <h3>{team.name}</h3>
              {team.restricted && (
                <span className="badge">{t("restricted")}</span>
              )}
              <p>
                {lang === "id"
                  ? "Minimal dua manajer aktif diperlukan untuk peninjauan independen."
                  : "At least two active managers are required for independent review."}
              </p>
              {staff
                .filter((s) => s.active && s.role !== "admin")
                .map((s) => (
                  <Check
                    key={s.id}
                    label={`${s.name} · ${t(s.role)}`}
                    disabled={a.busy}
                    checked={team.members.some((m) => m.id === s.id)}
                    onChange={(e) =>
                      void a.run(async () => {
                        const staffIds = e.target.checked
                          ? [...team.members.map((m) => m.id), s.id]
                          : team.members
                              .filter((m) => m.id !== s.id)
                              .map((m) => m.id);
                        await api(`/api/admin/teams/${team.id}/members`, {
                          method: "PUT",
                          body: { staffIds },
                        });
                        await load();
                      })
                    }
                  />
                ))}
            </article>
          ))}
        </section>
      )}
      {section === "settings" && ready && (
        <section>
          <h1>{t("settings")}</h1>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                const result = await api<{ body: CompanySettings }>(
                  "/api/admin/settings",
                  {
                    method: "PUT",
                    body: {
                      ...settings,
                      businessUnits: settings.businessUnits
                        .map((x) => x.trim())
                        .filter(Boolean),
                    },
                  },
                );
                setBaseSettings(result.body);
                clearDrafts("admin.settings.");
                setSaved(true);
              });
            }}
            onChange={() => setSaved(false)}
            onInvalidCapture={(e) => {
              let parent = (e.target as HTMLElement).parentElement;
              while (parent) {
                if (parent instanceof HTMLDetailsElement) parent.open = true;
                parent = parent.parentElement;
              }
            }}
          >
            <details open>
              <summary>{t("company")}</summary>
              <Field
                label={t("companyName")}
                required
                value={settings.companyName}
                onChange={(e) =>
                  setSettings({ ...settings, companyName: e.target.value })
                }
              />
            </details>
            <details data-settings-group="policies">
              <summary>{t("policies")}</summary>
              <div className="grid">
                {(["en", "id"] as const).map((locale) => (
                  <div key={locale}>
                    <h3>{locale === "en" ? "English" : "Bahasa Indonesia"}</h3>
                    <Text
                      label={t("policy")}
                      minLength={20}
                      required
                      value={settings.policy[locale]}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          policy: {
                            ...settings.policy,
                            [locale]: e.target.value,
                          },
                        })
                      }
                    />
                    <Text
                      label={t("notice")}
                      minLength={20}
                      required
                      value={settings.privacyNotice[locale]}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          privacyNotice: {
                            ...settings.privacyNotice,
                            [locale]: e.target.value,
                          },
                        })
                      }
                    />
                    <Text
                      label={t("notificationTemplates")}
                      minLength={10}
                      maxLength={300}
                      required
                      value={settings.notificationTemplates[locale]}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          notificationTemplates: {
                            ...settings.notificationTemplates,
                            [locale]: e.target.value,
                          },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </details>
            <details data-settings-group="categories">
              <summary>{t("categoriesUnits")}</summary>
              <h3>{t("category")}</h3>
              {settings.categories.map((c, i) => (
                <div className="grid" key={i}>
                  <Field
                    label={lang === "id" ? "Kode kategori" : "Category code"}
                    required
                    pattern="[a-z0-9_]+"
                    value={c.key}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        categories: settings.categories.map((x, j) =>
                          j === i ? { ...x, key: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  {(["en", "id"] as const).map((locale) => (
                    <Field
                      key={locale}
                      label={locale === "en" ? "English" : "Bahasa Indonesia"}
                      required
                      value={c[locale]}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          categories: settings.categories.map((x, j) =>
                            j === i ? { ...x, [locale]: e.target.value } : x,
                          ),
                        })
                      }
                    />
                  ))}
                  <button
                    type="button"
                    disabled={settings.categories.length < 2}
                    onClick={() =>
                      setSettings({
                        ...settings,
                        categories: settings.categories.filter(
                          (_, j) => j !== i,
                        ),
                      })
                    }
                  >
                    {t("delete")}
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setSettings({
                    ...settings,
                    categories: [
                      ...settings.categories,
                      { key: "", en: "", id: "" },
                    ],
                  })
                }
              >
                {t("add")}
              </button>
              <Text
                label={`${t("businessUnits")} (${lang === "id" ? "satu per baris" : "one per line"})`}
                value={settings.businessUnits.join("\n")}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    businessUnits: e.target.value.split("\n"),
                  })
                }
              />
            </details>
            <details data-settings-group="routing">
              <summary>{t("routingDeadlines")}</summary>
              <div className="grid">
                {(["defaultTeamId", "restrictedTeamId"] as const).map((k) => (
                  <Select
                    key={k}
                    label={t(k)}
                    required
                    value={settings[k] ?? ""}
                    onChange={(e) =>
                      setSettings({ ...settings, [k]: e.target.value || null })
                    }
                  >
                    <option value="">—</option>
                    {teams
                      .filter(
                        (team) =>
                          team.restricted === (k === "restrictedTeamId"),
                      )
                      .map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                  </Select>
                ))}
                {(["acknowledgmentDays", "followupDays"] as const).map((k) => (
                  <Field
                    key={k}
                    label={t(k)}
                    type="number"
                    min={1}
                    max={365}
                    required
                    value={settings[k]}
                    onChange={(e) =>
                      setSettings({ ...settings, [k]: Number(e.target.value) })
                    }
                  />
                ))}
              </div>
            </details>
            <details data-settings-group="retention">
              <summary>{t("retention")}</summary>
              <div className="grid">
                {(
                  [
                    "cases",
                    "contacts",
                    "evidence",
                    "transcripts",
                    "audit",
                    "backups",
                  ] as const
                ).map((k) => (
                  <Field
                    key={k}
                    label={t(k)}
                    type="number"
                    min={1}
                    max={36500}
                    required
                    value={settings.retention?.[k] ?? ""}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        retention: {
                          ...(settings.retention ?? {
                            cases: 0,
                            contacts: 0,
                            evidence: 0,
                            transcripts: 0,
                            audit: 0,
                            backups: 0,
                          }),
                          [k]: Number(e.target.value),
                        },
                      })
                    }
                  />
                ))}
              </div>
            </details>
            <details data-settings-group="ai">
              <summary>{t("assistedIntake")}</summary>
              <Check
                label={t("aiEnabled")}
                checked={settings.aiEnabled}
                onChange={(e) =>
                  setSettings({ ...settings, aiEnabled: e.target.checked })
                }
              />
            </details>
            <button disabled={a.busy}>{t("save")}</button>
            <DiscardDraft prefix="admin.settings." />
          </form>
          <Link href="/staff/admin/settings/history">{t("policyHistory")}</Link>
        </section>
      )}
      {section === "history" && (
        <section>
          <h1>{t("policyHistory")}</h1>
          <button
            onClick={() =>
              void a.run(async () =>
                setHistory(
                  (
                    await api<{ history: typeof history }>(
                      "/api/admin/settings/history",
                    )
                  ).history,
                ),
              )
            }
          >
            {t("refresh")}
          </button>
          {history.map((h) => (
            <p key={h.version}>
              v{h.version} · {new Date(h.created_at).toLocaleString(lang)} ·{" "}
              {h.actor_id}
            </p>
          ))}
        </section>
      )}
      {section === "operations" && (
        <section>
          <h1>{t("operations")}</h1>
          <button
            onClick={() =>
              void a.run(async () => setOps(await api("/api/admin/operations")))
            }
          >
            {t("refresh")}
          </button>
          {ops && (
            <>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>
                        {lang === "id" ? "Jenis pengiriman" : "Delivery type"}
                      </th>
                      <th>{t("pending")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ops.jobs.map((j) => (
                      <tr key={j.kind}>
                        <td>{j.kind.replaceAll("_", " ")}</td>
                        <td>{j.pending}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>
                {lang === "id"
                  ? "Layanan kontak privat"
                  : "Private contact service"}
              </h3>
              <p>
                {ops.privacy.unavailable
                  ? lang === "id"
                    ? "Tidak tersedia"
                    : "Unavailable"
                  : lang === "id"
                    ? "Tersedia"
                    : "Available"}
              </p>
              {ops.privacy.providers && (
                <p>
                  Email: {ops.privacy.providers.email ? "✓" : "—"} · SMS:{" "}
                  {ops.privacy.providers.phone ? "✓" : "—"} · AI:{" "}
                  {ops.privacy.providers.ai ? "✓" : "—"}
                </p>
              )}
              {ops.privacy.jobs?.map((j) => (
                <p key={j.kind}>
                  {j.kind.replaceAll("_", " ")}: {j.pending} {t("pending")} ·{" "}
                  {lang === "id" ? "Percobaan" : "Attempts"}: {j.attempts}
                </p>
              ))}
              {ops.privacy.files?.map((f) => (
                <p key={f.status}>
                  {t(f.status)}: {f.count}
                </p>
              ))}
              <p>
                {t("delete")}: {ops.deletions[0]?.pending ?? 0} {t("pending")}
              </p>
            </>
          )}
        </section>
      )}
      {section === "audit" && (
        <section>
          <h1>{t("audit")}</h1>
          <button
            onClick={() =>
              void a.run(async () => {
                await auditPage();
              })
            }
          >
            {t("refresh")}
          </button>
          <button
            disabled={
              a.busy || !audit.length || Number(audit.at(-1)!.seq) >= auditUntil
            }
            onClick={() =>
              void a.run(async () => {
                await auditPage(Number(audit.at(-1)!.seq), auditUntil);
              })
            }
          >
            {lang === "id" ? "Halaman berikutnya" : "Next page"}
          </button>
          <button disabled={a.busy} onClick={() => void a.run(exportAudit)}>
            {lang === "id" ? "Unduh riwayat" : "Download history"}
          </button>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("state")}</th>
                  <th>{t("staff")}</th>
                  <th>{lang === "id" ? "Waktu" : "Time"}</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={String(row.id)}>
                    <td>{String(row.action).replaceAll("_", " ")}</td>
                    <td>{String(row.actor_id)}</td>
                    <td>
                      {new Date(String(row.created_at)).toLocaleString(lang)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
