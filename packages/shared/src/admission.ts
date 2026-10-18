import { z } from "zod";

export const submissionSecretsSchema = z.object({
  pin: z.string().trim().min(6).max(100),
  recoveryCode: z.string().trim().min(8).max(100),
  submissionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const admissionVerifySchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  resumeToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
