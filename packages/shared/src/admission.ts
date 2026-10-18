import { z } from "zod";
export const employeeEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));
export const employeeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: employeeEmailSchema,
  phone: z
    .string()
    .trim()
    .regex(
      /^\+[1-9][0-9]{7,14}$/,
      "Use an international phone number, e.g. +628123456789",
    ),
});
export const employeeUpdateSchema = employeeSchema.extend({
  active: z.boolean(),
});
export const admissionChallengeSchema = z.object({
  email: employeeEmailSchema,
  purpose: z.enum(["report", "request"]).default("report"),
  locale: z.enum(["en", "id"]).default("en"),
});
export const admissionVerifySchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  resumeToken: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
export const employeeQuerySchema = z.object({
  q: z.string().trim().max(100).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  state: z.enum(["pending", "approved", "rejected"]).default("pending"),
});
export const submissionSecretsSchema = z.object({
  pin: z.string().trim().min(6).max(100),
  recoveryCode: z.string().trim().min(8).max(100),
  submissionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type EmployeeInput = z.infer<typeof employeeSchema>;
export type Employee = EmployeeInput & {
  id: string;
  active: boolean;
  createdAt: string;
};
export type EmployeeRequest = EmployeeInput & {
  id: string;
  state: "pending" | "approved" | "rejected";
  locale: "en" | "id";
  createdAt: string;
};
export type AdmissionChallenge =
  | {
      status: "otp";
      challengeId: string;
      expiresIn: number;
      resendAfter: number;
    }
  | { status: "unregistered"; canRequestAccess?: boolean }
  | { status: "disabled" };
export type AdmissionVerification =
  | { reportToken: string; expiresIn: number }
  | { requestToken: string; expiresIn: number };
