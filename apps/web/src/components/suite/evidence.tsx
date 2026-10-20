"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Lock,
  Presentation,
  Upload,
  X,
} from "lucide-react";
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
  size?: number;
  pages: number;
  sha256: string;
  error_code: string | null;
};
type Rect = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
const MAX_FILES = 20;
const kinds: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PPTX",
};
const tones: Record<string, string> = {
  quarantined: "info",
  review: "warn",
  approved: "ok",
  published: "ok",
  rejected: "danger",
};
function FileIcon({ mime }: { mime: string }) {
  const Icon = mime.startsWith("image/")
    ? ImageIcon
    : mime.includes("spreadsheet")
      ? FileSpreadsheet
      : mime.includes("presentation")
        ? Presentation
        : FileText;
  return <Icon size={20} aria-hidden="true" />;
}
const size = (bytes?: number) =>
  bytes === undefined
    ? ""
    : bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const clamp = (n: number) => Math.min(1, Math.max(0, n));
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
    label = (en: string, id: string) => (lang === "id" ? id : en),
    [files, setFiles] = useState<File[]>([]),
    [selected, setSelected] = useState<File>(),
    [url, setUrl] = useState(""),
    [review, setReview] = useState(false),
    [over, setOver] = useState(false),
    [rect, setRect] = useState<Rect>({
      page: 1,
      x: 0,
      y: 0,
      width: 0.1,
      height: 0.1,
    });
  const dialog = useRef<HTMLDialogElement>(null),
    drag = useRef<{ x: number; y: number } | null>(null);
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
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (selected && url && !d.open) d.showModal();
    if (!(selected && url) && d.open) d.close();
  }, [selected, url]);
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
  function upload(file: globalThis.File) {
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
            await api<{ files: File[] }>(`/privacy/intake/${target.id}/files`, {
              headers: { "x-intake-code": target.code },
            })
          ).files,
        );
      } else {
        await request("/files", { method: "POST", body: data });
        await load();
      }
    });
  }
  const point = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return {
      x: clamp((e.clientX - box.left) / box.width),
      y: clamp((e.clientY - box.top) / box.height),
    };
  };
  const statusLabel = (status: string) =>
    status === "review" ? label("Ready to review", "Siap ditinjau") : t(status);
  const disabled = a.busy || uploadDisabled;
  const editable = selected?.status === "review" && !closed;
  const image = selected?.mime.startsWith("image/");
  const remove = (f: File) =>
    void a.run(async () => {
      await request(`/files/${f.id}`, { method: "DELETE" });
      await load();
      if (selected?.id === f.id) {
        setSelected(undefined);
        setUrl("");
      }
    });
  return (
    <section
      className="lx-card lx-evidence lx-stack"
      aria-labelledby="evidence-heading"
    >
      <div className="lx-row" style={{ justifyContent: "space-between" }}>
        <h2 id="evidence-heading">{t("files")}</h2>
        <span className="lx-help">
          <span className="mono">{files.length}</span>
          {label(` of ${MAX_FILES} files`, ` dari ${MAX_FILES} file`)}
        </span>
      </div>
      {!selected && <ErrorBox error={a.error} />}
      {files.length > 0 && (
        <ul className="lx-files">
          {files.map((f, i) => (
            <li key={f.id} className="lx-file">
              <div className="lx-file-head">
                <FileIcon mime={f.mime} />
                <span>
                  {t("files")} {i + 1}
                </span>
                <span
                  className={`badge badge-dot badge-${tones[f.status] ?? "neutral"}`}
                >
                  {statusLabel(f.status)}
                </span>
              </div>
              <div className="lx-file-foot">
                <span>
                  {[
                    kinds[f.mime] ?? f.mime,
                    f.pages > 1
                      ? `${f.pages} ${label("pages", "halaman")}`
                      : "",
                    size(f.size),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <span className="lx-row">
                  {["review", "approved", "published"].includes(f.status) && (
                    <button
                      type="button"
                      className="ds-button ds-button-ghost ds-button-sm"
                      onClick={() => void a.run(() => preview(f))}
                    >
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
                      type="button"
                      className="ds-button ds-button-ghost ds-button-sm"
                      onClick={() => remove(f)}
                    >
                      {t("delete")}
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!closed && (
        <label
          className={`lx-dropzone${over ? " is-over" : ""}${disabled ? " is-disabled" : ""}`}
          onDragOver={(e) => {
            if (disabled) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const file = e.dataTransfer.files[0];
            if (file && !disabled) upload(file);
          }}
        >
          <Upload size={24} aria-hidden="true" />
          <span>
            <strong>{t("upload")}</strong>
            {disabled
              ? ""
              : label(" or drop a file here", " atau letakkan file di sini")}
          </span>
          <span className="lx-help">
            {label(
              "PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX · up to 20 MB each · 20 files, 200 MB total",
              "PNG, JPEG, WebP, PDF, DOCX, XLSX, PPTX · maks. 20 MB per file · 20 file, total 200 MB",
            )}
          </span>
          <input
            type="file"
            className="sr-only"
            data-evidence-upload
            accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.pptx"
            disabled={disabled}
            onChange={(e) => {
              const input = e.currentTarget;
              const file = input.files?.[0];
              if (file) upload(file);
              input.value = "";
            }}
          />
        </label>
      )}
      {uploadDisabled && !closed && (
        <p className="lx-help">
          {label(
            "Read and acknowledge the policy and privacy notice to attach evidence.",
            "Baca dan setujui kebijakan serta pemberitahuan privasi untuk melampirkan bukti.",
          )}
        </p>
      )}
      <p className="lx-note">
        <Lock size={14} aria-hidden="true" />
        <span>
          {draftMode
            ? label(
                "Files and filenames are never sent to the assistant. Originals are sealed; staff only see versions you approve, and only after you submit.",
                "File dan nama file tidak pernah dikirim ke asisten. File asli disegel; staf hanya melihat versi yang Anda setujui, dan hanya setelah laporan dikirim.",
              )
            : label(
                "Originals are sealed. Staff receive only the sanitized version you approve. Review every page.",
                "File asli disegel. Hanya versi yang disanitasi dan Anda setujui dibagikan kepada staf. Periksa semua halaman.",
              )}
        </span>
      </p>
      <dialog
        ref={dialog}
        className="lx-dialog"
        aria-labelledby="evidence-review-heading"
        onClose={() => {
          setSelected(undefined);
          setUrl("");
        }}
      >
        {selected && url && (
          <>
            <div className="lx-dialog-head">
              <h2 id="evidence-review-heading">
                {editable
                  ? label("Review evidence", "Tinjau bukti")
                  : t("preview")}
              </h2>
              <button
                type="button"
                className="ds-button ds-icon-button"
                aria-label={label("Close", "Tutup")}
                onClick={() => dialog.current?.close()}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="lx-dialog-body">
              <div className="lx-viewer">
                <div className="lx-viewer-bar">
                  <span>
                    {editable && image
                      ? label(
                          "Drag across anything that could identify you",
                          "Seret di atas bagian yang dapat mengidentifikasi Anda",
                        )
                      : `${kinds[selected.mime] ?? selected.mime} · ${selected.pages} ${label(selected.pages === 1 ? "page" : "pages", "halaman")}`}
                  </span>
                </div>
                <div className="lx-viewer-stage">
                  {image ? (
                    <div
                      className="lx-draw"
                      onPointerDown={(e) => {
                        if (!editable) return;
                        e.currentTarget.setPointerCapture(e.pointerId);
                        drag.current = point(e);
                        setRect({
                          ...rect,
                          page: 1,
                          ...drag.current,
                          width: 0,
                          height: 0,
                        });
                      }}
                      onPointerMove={(e) => {
                        if (!drag.current) return;
                        const p = point(e),
                          start = drag.current;
                        setRect({
                          page: 1,
                          x: Math.min(start.x, p.x),
                          y: Math.min(start.y, p.y),
                          width: Math.abs(p.x - start.x),
                          height: Math.abs(p.y - start.y),
                        });
                      }}
                      onPointerUp={() => {
                        drag.current = null;
                      }}
                    >
                      <img src={url} alt={t("preview")} />
                      {editable && rect.width > 0 && rect.height > 0 && (
                        <span
                          className="lx-draw-rect"
                          aria-hidden="true"
                          style={{
                            left: `${rect.x * 100}%`,
                            top: `${rect.y * 100}%`,
                            width: `${rect.width * 100}%`,
                            height: `${rect.height * 100}%`,
                          }}
                        />
                      )}
                    </div>
                  ) : (
                    <iframe title={t("preview")} src={url} />
                  )}
                </div>
              </div>
              <div className="lx-dialog-side">
                <div
                  className="lx-row"
                  style={{ justifyContent: "space-between" }}
                >
                  <strong>
                    {t("files")}{" "}
                    {files.findIndex((f) => f.id === selected.id) + 1}
                  </strong>
                  <span
                    className={`badge badge-dot badge-${tones[selected.status] ?? "neutral"}`}
                  >
                    {statusLabel(selected.status)}
                  </span>
                </div>
                <ErrorBox error={a.error} />
                {editable ? (
                  <>
                    <div className="lx-well lx-stack">
                      <p className="lx-help">
                        {image
                          ? label(
                              "The highlighted area is blacked out when you apply it. Redactions are permanent in the shared version; the sealed original stays private.",
                              "Area yang disorot akan ditutup saat diterapkan. Penyamaran bersifat permanen pada versi yang dibagikan; file asli tetap tersegel.",
                            )
                          : label(
                              "Cover sensitive details with a rectangle. Position and size use fractions of the page (0–1), starting at its top left.",
                              "Samarkan bagian yang sensitif dengan persegi panjang. Posisi dan ukuran memakai pecahan halaman (0–1); titik awal di kiri atas.",
                            )}
                      </p>
                      <details open={!image}>
                        <summary>
                          {label("Position and size", "Posisi dan ukuran")}
                        </summary>
                        <div className="grid">
                          {(["page", "x", "y", "width", "height"] as const).map(
                            (k) => (
                              <Field
                                key={k}
                                label={
                                  k === "page"
                                    ? t("page")
                                    : {
                                        x: label(
                                          "Horizontal position",
                                          "Posisi horizontal",
                                        ),
                                        y: label(
                                          "Vertical position",
                                          "Posisi vertikal",
                                        ),
                                        width: label("Width", "Lebar"),
                                        height: label("Height", "Tinggi"),
                                      }[k]
                                }
                                type="number"
                                min={k === "page" ? 1 : 0}
                                max={k === "page" ? selected.pages : 1}
                                step={k === "page" ? 1 : 0.01}
                                value={
                                  k === "page"
                                    ? rect[k]
                                    : Number(rect[k].toFixed(3))
                                }
                                onChange={(e) =>
                                  setRect({
                                    ...rect,
                                    [k]: Number(e.target.value),
                                  })
                                }
                              />
                            ),
                          )}
                        </div>
                      </details>
                      <button
                        type="button"
                        className="secondary"
                        disabled={a.busy || !rect.width || !rect.height}
                        onClick={() =>
                          void a.run(async () => {
                            await request(`/files/${selected.id}/redact`, {
                              method: "POST",
                              body: { rectangles: [rect] },
                            });
                            const latest = await request<{ files: File[] }>(
                              "/files",
                            );
                            await preview(
                              latest.files.find((f) => f.id === selected.id)!,
                            );
                          })
                        }
                      >
                        {t("redact")}
                      </button>
                    </div>
                    <Check
                      label={t("review")}
                      checked={review}
                      onChange={(e) => setReview(e.target.checked)}
                    />
                    <button
                      type="button"
                      disabled={!review || a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          await request(`/files/${selected.id}/approve`, {
                            method: "POST",
                            body: {
                              privacyReviewed: true,
                              sha256: selected.sha256,
                            },
                          });
                          setSelected(undefined);
                          setUrl("");
                          await load();
                        })
                      }
                    >
                      {t("approve")}
                    </button>
                    <p className="lx-help">
                      {label(
                        "Investigators only see the version you approve. Unapproved files stay private.",
                        "Penyelidik hanya melihat versi yang Anda setujui. File yang belum disetujui tetap pribadi.",
                      )}
                    </p>
                    <button
                      type="button"
                      className="ds-button ds-button-danger-outline ds-button-sm"
                      disabled={a.busy}
                      onClick={() => remove(selected)}
                    >
                      {t("delete")}
                    </button>
                  </>
                ) : (
                  <p className="lx-help">
                    {label(
                      "This is the sanitized version investigators can see once it is shared.",
                      "Ini adalah versi tersanitasi yang dapat dilihat penyelidik setelah dibagikan.",
                    )}
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
