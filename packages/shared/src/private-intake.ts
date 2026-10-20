import { z } from "zod";
import { suiteReportSchema } from "./suite.js";
import type { ChatMessage } from "./intake.js";

// A continuation credential is separate from all submitted-case credentials.
export const continuationCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const intakeReviewSchema = suiteReportSchema
  .omit({
    privacyReviewed: true,
    policyVersion: true,
    aiConsent: true,
    hp: true,
    intakeId: true,
    intakeToken: true,
  })
  .extend({
    title: z.string().trim().max(200).default(""),
    summary: z.string().trim().max(10000).default(""),
    category: z.string().trim().max(80).default(""),
  });
export type IntakeReview = z.infer<typeof intakeReviewSchema>;
export const intakeStartSchema = z.object({
  id: z.uuid(),
  code: continuationCodeSchema,
  consent: z.literal(true),
  policyVersion: z.number().int().positive(),
  locale: z.enum(["en", "id"]),
});
export const intakeOperationSchema = z.object({
  requestId: z.uuid(),
  retryOf: z.uuid().optional(),
  body: z.string().trim().min(1).max(4000).optional(),
  locale: z.enum(["en", "id"]),
  consent: z.literal(true),
  policyVersion: z.number().int().positive(),
});
export interface PrivateIntakeView {
  id: string;
  locale: "en" | "id";
  expiresAt: string;
  policyVersion: number;
  needsConsent: boolean;
  aiEnabled: boolean;
  messages: ChatMessage[];
  draft: IntakeReview | null;
  pending: {
    id: string;
    kind: "messages" | "draft";
    retryable: boolean;
  } | null;
  usage: { messages: number; drafts: number; resetsAt: string };
}

export function intakeGreeting(locale: "en" | "id") {
  return locale === "id"
    ? "Halo, saya di sini untuk membantu Anda menceritakan kekhawatiran Anda. Percakapan ini tetap pribadi sampai Anda meninjau dan mengirim laporan. Jangan sertakan nama atau informasi kontak Anda sendiri. Apa yang terjadi?"
    : "Hello, I’m here to help you describe your concern. This conversation stays private until you review and submit a report. Please leave out your own name and contact details. What happened?";
}
