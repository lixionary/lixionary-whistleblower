"use client";
import { useCallback, useEffect, useState } from "react";
import type { DashboardData } from "@whistle/shared";
import { api } from "@/lib/api";
import { useAction, ErrorBox, type Lang } from "./common";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ago = (days: number) => iso(new Date(Date.now() - days * 86400000));
const presets = [7, 30, 90];

function Card({
  label,
  value,
  note,
}: {
  label: string;
  value: number | string;
  note?: string;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: "12px 16px",
        minWidth: 180,
        flex: "1 1 180px",
      }}
    >
      <div style={{ color: "var(--muted)", fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 500 }}>{value}</div>
      {note && (
        <div style={{ color: "var(--muted)", fontSize: 12 }}>{note}</div>
      )}
    </div>
  );
}

function Trend({ data, lang }: { data: DashboardData["trend"]; lang: Lang }) {
  const w = 720,
    h = 220,
    pad = { l: 36, r: 12, t: 12, b: 24 };
  const max = Math.max(1, ...data.map((d) => Math.max(d.created, d.closed)));
  const x = (i: number) =>
    pad.l +
    (data.length < 2 ? 0 : (i / (data.length - 1)) * (w - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const line = (key: "created" | "closed") =>
    data.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d[key])}`).join(" ");
  const labels = [data[0], data[Math.floor(data.length / 2)], data.at(-1)];
  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={
          lang === "id" ? "Tren laporan per hari" : "Reports per day trend"
        }
        style={{ width: "100%", height: "auto" }}
      >
        <title>
          {lang === "id" ? "Tren laporan per hari" : "Reports per day trend"}
        </title>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={pad.l}
              x2={w - pad.r}
              y1={y(max * f)}
              y2={y(max * f)}
              stroke="var(--line)"
            />
            <text
              x={pad.l - 6}
              y={y(max * f) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--muted)"
            >
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        <path
          d={line("created")}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
        />
        <path
          d={line("closed")}
          fill="none"
          stroke="var(--muted)"
          strokeWidth="2"
          strokeDasharray="5 4"
        />
        {labels.map(
          (d, i) =>
            d && (
              <text
                key={i}
                x={x(data.indexOf(d))}
                y={h - 6}
                textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
                fontSize="11"
                fill="var(--muted)"
              >
                {d.day}
              </text>
            ),
        )}
      </svg>
      <figcaption style={{ fontSize: 13, color: "var(--muted)" }}>
        <span style={{ color: "var(--accent)" }}>━</span>{" "}
        {lang === "id" ? "Dibuat" : "Created"} &nbsp;
        <span>╍</span> {lang === "id" ? "Ditutup" : "Closed"}
      </figcaption>
    </figure>
  );
}

export function Dashboard({
  lang,
  t,
}: {
  lang: Lang;
  t: (s: string) => string;
}) {
  const a = useAction(lang),
    [from, setFrom] = useState(ago(29)),
    [to, setTo] = useState(ago(0)),
    [data, setData] = useState<DashboardData>();
  const id = (en: string, idn: string) => (lang === "id" ? idn : en);
  const { run } = a;
  const load = useCallback(
    () =>
      run(async () =>
        setData(await api(`/api/admin/dashboard?from=${from}&to=${to}`)),
      ),
    [run, from, to],
  );
  useEffect(() => {
    if (from <= to) void load();
  }, [load, from, to]);
  return (
    <section>
      <ErrorBox error={a.error} />
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "end",
          marginBottom: 16,
        }}
      >
        {presets.map((d) => (
          <button
            key={d}
            onClick={() => {
              setFrom(ago(d - 1));
              setTo(ago(0));
            }}
          >
            {id(`Last ${d} days`, `${d} hari terakhir`)}
          </button>
        ))}
        <label>
          {id("From", "Dari")}{" "}
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </label>
        <label>
          {id("To", "Sampai")}{" "}
          <input
            type="date"
            value={to}
            min={from}
            max={ago(0)}
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </label>
        <button disabled={a.busy} onClick={() => void load()}>
          {t("refresh")}
        </button>
      </div>
      {data && (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Card label={id("Reports", "Laporan")} value={data.total} />
            <Card
              label={id("Waiting for support", "Menunggu dukungan")}
              value={data.waitingForSupport.count}
              note={id(
                `${data.waitingForSupport.overdue} not acknowledged in time`,
                `${data.waitingForSupport.overdue} belum dikonfirmasi tepat waktu`,
              )}
            />
            <Card
              label={id(
                "With case manager: waiting on staff",
                "Dengan manajer kasus: menunggu staf",
              )}
              value={data.caseManager.waitingOnStaff}
            />
            <Card
              label={id(
                "With case manager: waiting on reporter",
                "Dengan manajer kasus: menunggu pelapor",
              )}
              value={data.caseManager.waitingOnReporter}
            />
            <Card
              label={id(
                "Pending closure review",
                "Menunggu tinjauan penutupan",
              )}
              value={data.pendingClosure}
            />
          </div>
          <h2>{id("AI conversation", "Percakapan AI")}</h2>
          {data.ai ? (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Card
                label={id("Active", "Aktif")}
                value={data.ai.active}
                note={id(
                  "activity in last 7 days",
                  "aktivitas 7 hari terakhir",
                )}
              />
              <Card
                label={id("Idle", "Tidak aktif")}
                value={data.ai.idle}
                note={id("no activity for 7+ days", "tanpa aktivitas 7+ hari")}
              />
              <Card label={id("Failed", "Gagal")} value={data.ai.failed} />
              <Card
                label={id("Not started", "Belum dimulai")}
                value={data.ai.notStarted}
              />
            </div>
          ) : (
            <p>
              {id("AI statistics unavailable.", "Statistik AI tidak tersedia.")}
            </p>
          )}
          <h2>{id("Reports over time", "Laporan dari waktu ke waktu")}</h2>
          <Trend data={data.trend} lang={lang} />
          <h2>{id("By status", "Berdasarkan status")}</h2>
          <div className="scroll">
            <table>
              <tbody>
                {data.states.map((s) => (
                  <tr key={s.state}>
                    <td>{t(s.state)}</td>
                    <td>{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>{id("Closed by outcome", "Ditutup berdasarkan hasil")}</h2>
          {data.outcomes.length ? (
            <div className="scroll">
              <table>
                <tbody>
                  {data.outcomes.map((o) => (
                    <tr key={o.outcome}>
                      <td>{t(o.outcome)}</td>
                      <td>{o.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>
              {id(
                "No closed reports in this period.",
                "Tidak ada laporan ditutup pada periode ini.",
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
