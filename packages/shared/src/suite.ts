import { z } from "zod";
export const locales = ["en", "id"] as const;
export type Locale = (typeof locales)[number];
export const staffRoles = ["admin", "manager", "analyst"] as const;
export type StaffRole = (typeof staffRoles)[number];
export const states = [
  "received",
  "triage",
  "investigating",
  "waiting_reporter",
  "closure_review",
  "closed",
] as const;
export type CaseState = (typeof states)[number];
export const outcomes = [
  "substantiated",
  "partially_substantiated",
  "unsubstantiated",
  "out_of_scope",
  "duplicate",
  "withdrawn",
] as const;

export const reporterRelationships = [
  "employee",
  "former_employee",
  "contractor_supplier",
  "external",
] as const;
export type ReporterRelationship = (typeof reporterRelationships)[number];
export const detrimentRisks = [
  "unassessed",
  "low",
  "elevated",
  "critical",
] as const;
export type DetrimentRisk = (typeof detrimentRisks)[number];
export const rootCauses = [
  "control_gap",
  "policy_gap",
  "training_gap",
  "culture_leadership",
  "individual_misconduct",
  "third_party",
  "not_applicable",
] as const;
export type RootCause = (typeof rootCauses)[number];
export const subjectResponseStatuses = [
  "not_applicable",
  "heard",
  "deferred_legal_or_safety",
] as const;
export type SubjectResponseStatus = (typeof subjectResponseStatuses)[number];
export const reporterFeedbackSchema = z.object({
  trust: z.number().int().min(1).max(5),
  communication: z.number().int().min(1).max(5),
  protection: z.number().int().min(1).max(5),
});
export type ReporterFeedback = z.infer<typeof reporterFeedbackSchema>;
export const suiteReportSchema = z.object({
  title: z.string().trim().min(5).max(200),
  summary: z.string().trim().min(20).max(10000),
  category: z.string().trim().min(1).max(80),
  businessUnit: z.string().max(100).default(""),
  relationship: z.enum(reporterRelationships).default("employee"),
  details: z.record(z.string().max(50), z.string().max(5000)).default({}),
  locale: z.enum(locales).default("en"),
  sensitive: z.boolean().default(false),
  privacyReviewed: z.literal(true),
  policyVersion: z.number().int().positive(),
  aiConsent: z.boolean().default(false),
  reporterEmail: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254))
    .optional()
    .or(z.literal("").transform(() => undefined)),
  hp: z.string().max(100).optional(),
  intakeId: z.uuid().optional(),
  intakeToken: z.string().min(20).max(200).optional(),
});
export type SuiteReport = z.infer<typeof suiteReportSchema>;
export const bodySchema = z.object({
  body: z.string().trim().min(1).max(10000),
  privacyReviewed: z.literal(true).optional(),
});
export const retentionSchema = z.object({
  cases: z.number().int().min(1).max(36500),
  contacts: z.number().int().min(1).max(36500),
  evidence: z.number().int().min(1).max(36500),
  transcripts: z.number().int().min(1).max(36500),
  audit: z.number().int().min(1).max(36500),
  backups: z.number().int().min(1).max(36500),
});
export const settingsSchema = z
  .object({
    companyName: z.string().trim().min(1).max(100).default("Speak Up"),
    policy: z.object({
      en: z.string().min(20).max(20000),
      id: z.string().min(20).max(20000),
    }),
    privacyNotice: z.object({
      en: z.string().min(20).max(20000),
      id: z.string().min(20).max(20000),
    }),
    categories: z
      .array(
        z.object({
          key: z
            .string()
            .regex(/^[a-z0-9_]+$/)
            .max(80),
          en: z.string().min(1).max(100),
          id: z.string().min(1).max(100),
        }),
      )
      .min(1)
      .max(50),
    businessUnits: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .default([]),
    aiEnabled: z.boolean().default(false),
    acknowledgmentDays: z.number().int().min(1).max(365),
    followupDays: z.number().int().min(1).max(365),
    retention: retentionSchema.nullable().default(null),
    defaultTeamId: z.uuid().nullable().default(null),
    restrictedTeamId: z.uuid().nullable().default(null),
    notificationTemplates: z.object({
      en: z.string().min(10).max(300),
      id: z.string().min(10).max(300),
    }),
  })
  .superRefine((s, c) => {
    if (new Set(s.categories.map((x) => x.key)).size !== s.categories.length)
      c.addIssue({ code: "custom", message: "Duplicate category" });
    if (s.defaultTeamId && s.defaultTeamId === s.restrictedTeamId)
      c.addIssue({
        code: "custom",
        message: "Restricted team must be independent",
      });
  });
export type CompanySettings = z.infer<typeof settingsSchema>;
export const defaultSettings: CompanySettings = {
  companyName: "Speak Up",
  policy: {
    en: "Report suspected misconduct in good faith. Your report will be reviewed through this platform.",
    id: "Laporkan dugaan pelanggaran dengan itikad baik. Laporan Anda akan ditinjau melalui platform ini.",
  },
  privacyNotice: {
    en: "Your report is submitted securely and confidentially. You may report anonymously without providing contact details, or optionally provide an email to receive case updates. Optional case contacts are hidden from staff. Report content and circumstances may identify you. External delivery providers process destinations; optional AI processes your private intake conversation, submitted report, and private follow-up only with consent. Only the report or updates you review and submit are shared with investigators.",
    id: "Laporan Anda dikirimkan dengan aman dan rahasia. Anda dapat melapor secara anonim tanpa memberikan rincian kontak, atau secara opsional memberikan email untuk menerima pembaruan laporan. Kontak laporan opsional disembunyikan dari staf. Isi dan situasi laporan dapat mengidentifikasi Anda. Penyedia pengiriman eksternal memproses tujuan; AI opsional memproses percakapan awal pribadi, laporan terkirim, dan tindak lanjut pribadi hanya dengan persetujuan. Hanya laporan atau pembaruan yang Anda tinjau dan kirim dibagikan kepada penyelidik.",
  },
  categories: [
    { key: "fraud", en: "Fraud", id: "Penipuan" },
    { key: "corruption", en: "Corruption or bribery", id: "Korupsi atau suap" },
    { key: "harassment", en: "Harassment", id: "Pelecehan" },
    { key: "safety", en: "Health and safety", id: "Kesehatan dan keselamatan" },
    { key: "other", en: "Other misconduct", id: "Pelanggaran lainnya" },
  ],
  businessUnits: [],
  aiEnabled: false,
  acknowledgmentDays: 7,
  followupDays: 30,
  retention: null,
  defaultTeamId: null,
  restrictedTeamId: null,
  notificationTemplates: {
    en: "There is an update in your private reporting portal. Visit the platform to check it.",
    id: "Ada pembaruan di portal laporan pribadi Anda. Kunjungi platform untuk memeriksanya.",
  },
};
export interface StaffIdentity {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  mfaEnrolled: boolean;
}
export interface CaseView {
  id: string;
  caseCode: string;
  state: CaseState;
  category: string;
  sensitive: boolean;
  severity: string;
  detrimentRisk: DetrimentRisk;
  detrimentFlagged: boolean;
  protectionPlan?: string | null;
  ownerId: string | null;
  teamId: string | null;
  content: SuiteReport;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  acknowledgmentDueAt: string | null;
  nextFollowupDueAt: string | null;
  closedAt: string | null;
  hold: boolean;
  closure: Record<string, unknown> | null;
  feedback: Record<string, unknown> | null;
  verification: { state: string; verifiedAt: string | null };
  messages: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  findings: Record<string, unknown>[];
  detrimentReports: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  members: Record<string, unknown>[];
}
