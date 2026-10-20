"use client";
import { useCallback, useEffect, useState } from "react";
import type { ActiveIntake } from "./intake-chat";
import { api } from "@/lib/api";
import {
  Check,
  ErrorBox,
  Field,
  privateApi,
  useAction,
  type Lang,
} from "./common";
type File = {
  id: string;
  status: string;
  mime: string;
  pages: number;
  sha256: string;
  error_code: string | null;
};
export function Evidence({
  t,
  lang,
  closed,
  intake,
  beforeUpload,
  uploadDisabled = false,
}: {
  t: (s: string) => string;
  lang: Lang;
  closed: boolean;
  intake?: ActiveIntake;
  beforeUpload?: () => Promise<ActiveIntake>;
  uploadDisabled?: boolean;
}) {
  const a = useAction(lang),
    [files, setFiles] = useState<File[]>([]),
    [selected, setSelected] = useState<File>(),
    [url, setUrl] = useState(""),
    [review, setReview] = useState(false),
    [rect, setRect] = useState({
      page: 1,
      x: 0,
      y: 0,
      width: 0.1,
      height: 0.1,
    });
  const draftMode = !!beforeUpload || !!intake;
  const request = useCallback(
    <T,>(path: string, opts: Parameters<typeof api>[1] = {}): Promise<T> => {
      if (intake)
        return api<T>(`/privacy/intake/${intake.id}${path}`, {
          ...opts,
          headers: { ...opts.headers, "x-intake-code": intake.code },
        });
      if (draftMode)
        return Promise.reject(new Error("conversation_not_started"));
      return privateApi<T>(path, opts);
    },
    [intake?.id, intake?.code, draftMode],
  );
  const load = useCallback(async () => {
    const r = await request<{ files: File[] }>("/files");
    setFiles(r.files);
  }, [request]);
  useEffect(() => {
    setFiles([]);
    setSelected(undefined);
    setUrl("");
    setReview(false);
    void load().catch(() => {});
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  async function preview(f: File) {
    const headers: Record<string, string> = intake
      ? { "x-intake-code": intake.code }
      : {
          Authorization: `Bearer ${(await api<{ capability: string }>("/api/reporter/capability", { method: "POST", body: {} })).capability}`,
        };
    const response = await fetch(
      intake
        ? `/privacy/intake/${intake.id}/files/${f.id}/preview`
        : `/privacy/reporter/files/${f.id}/preview`,
      { headers },
    );
    if (!response.ok) throw new Error("preview_failed");
    const next = URL.createObjectURL(await response.blob());
    setUrl(next);
    setSelected(f);
    setReview(false);
  }
  return (
    <section>
      <h2>{t("files")}</h2>
      <ErrorBox error={a.error} />
      {!closed && (
        <label>
          {t("upload")}
          <input
            type="file"
            data-evidence-upload
            accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.pptx"
            disabled={a.busy || uploadDisabled}
            onChange={(e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              if (file)
                void a.run(async () => {
                  const data = new FormData();
                  data.append("file", file);
                  const target = beforeUpload ? await beforeUpload() : intake;
                  if (target) {
                    await api(`/privacy/intake/${target.id}/files`, {
                      method: "POST",
                      body: data,
                      headers: {
                        "x-intake-code": target.code,
                        "x-evidence-id": crypto.randomUUID(),
                      },
                    });
                    setFiles(
                      (
                        await api<{ files: File[] }>(
                          `/privacy/intake/${target.id}/files`,
                          { headers: { "x-intake-code": target.code } },
                        )
                      ).files,
                    );
                  } else {
                    await request("/files", { method: "POST", body: data });
                    await load();
                  }
                  input.value = "";
                });
            }}
          />
        </label>
      )}
      <p>
        {lang === "id"
          ? "PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX. Maksimal 20 MB per file, 20 file, total 200 MB."
          : "PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX. Up to 20 MB per file, 20 files, 200 MB total."}
      </p>
      <p>
        {lang === "id"
          ? "File asli disegel. Hanya versi yang disanitasi dan Anda setujui dibagikan kepada staf. Periksa semua halaman."
          : "Original files are sealed. Staff receive only the sanitized version you approve. Review every page."}
      </p>
      {draftMode && (
        <p>
          {lang === "id"
            ? "Lampiran tetap pribadi. AI tidak dapat membaca file ini. Versi yang Anda setujui dibagikan kepada staf hanya setelah laporan dikirim."
            : "Attachments stay private. AI cannot read these files. Approved versions are shared with staff only after you submit your report."}
        </p>
      )}
      {uploadDisabled && (
        <p>
          {lang === "id"
            ? "Baca dan setujui kebijakan serta pemberitahuan privasi untuk melampirkan bukti."
            : "Read and acknowledge the policy and privacy notice to attach evidence."}
        </p>
      )}
      {files.map((f) => (
        <article key={f.id}>
          <span>
            {t("files")} {files.indexOf(f) + 1} ·{" "}
            {f.status === "review"
              ? lang === "id"
                ? "Siap ditinjau"
                : "Ready to review"
              : t(f.status)}
          </span>
          {["review", "approved", "published"].includes(f.status) && (
            <button onClick={() => void a.run(() => preview(f))}>
              {t("preview")}
            </button>
          )}
          {[
            "quarantined",
            "review",
            "rejected",
            ...(draftMode ? ["approved"] : []),
          ].includes(f.status) && (
            <button
              onClick={() =>
                void a.run(async () => {
                  await request(`/files/${f.id}`, { method: "DELETE" });
                  await load();
                  if (selected?.id === f.id) {
                    setSelected(undefined);
                    setUrl("");
                  }
                })
              }
            >
              {t("delete")}
            </button>
          )}
        </article>
      ))}
      {selected && url && (
        <article>
          {selected.mime === "application/pdf" ? (
            <iframe title={t("preview")} src={url} />
          ) : (
            <img src={url} alt={t("preview")} />
          )}{" "}
          {selected.status === "review" && !closed && (
            <>
              <p>
                {lang === "id"
                  ? "Samarkan bagian yang sensitif dengan persegi panjang. Posisi dan ukuran memakai pecahan halaman (0–1); titik awal di kiri atas. Pratinjau diperbarui setelah diterapkan."
                  : "Cover sensitive details with a rectangle. Position and size use fractions of the page (0–1), starting at its top left. Review the updated preview after applying."}
              </p>
              <div className="grid">
                {(["page", "x", "y", "width", "height"] as const).map((k) => (
                  <Field
                    key={k}
                    label={
                      k === "page"
                        ? t("page")
                        : {
                            x:
                              lang === "id"
                                ? "Posisi horizontal"
                                : "Horizontal position",
                            y:
                              lang === "id"
                                ? "Posisi vertikal"
                                : "Vertical position",
                            width: lang === "id" ? "Lebar" : "Width",
                            height: lang === "id" ? "Tinggi" : "Height",
                          }[k]
                    }
                    type="number"
                    min={k === "page" ? 1 : 0}
                    max={k === "page" ? selected.pages : 1}
                    step={k === "page" ? 1 : 0.01}
                    value={rect[k]}
                    onChange={(e) =>
                      setRect({ ...rect, [k]: Number(e.target.value) })
                    }
                  />
                ))}
              </div>
              <button
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await request(`/files/${selected.id}/redact`, {
                      method: "POST",
                      body: { rectangles: [rect] },
                    });
                    const latest = await request<{ files: File[] }>("/files");
                    await preview(
                      latest.files.find((f) => f.id === selected.id)!,
                    );
                  })
                }
              >
                {t("redact")}
              </button>
              <Check
                label={t("review")}
                checked={review}
                onChange={(e) => setReview(e.target.checked)}
              />
              <button
                disabled={!review || a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await request(`/files/${selected.id}/approve`, {
                      method: "POST",
                      body: { privacyReviewed: true, sha256: selected.sha256 },
                    });
                    setSelected(undefined);
                    setUrl("");
                    await load();
                  })
                }
              >
                {t("approve")}
              </button>
            </>
          )}
        </article>
      )}
    </section>
  );
}
