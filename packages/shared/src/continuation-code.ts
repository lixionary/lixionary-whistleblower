import { z } from "zod";

// 32 characters, without easily confused 0/O and 1/I pairs (40 random bits).
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const shortCode = /^[2-9A-HJ-NP-Z]{8}$/;
const legacyCode = /^[A-Za-z0-9_-]{43}$/;

export const continuationCodeSchema = z
  .string()
  .trim()
  .max(64)
  .transform((value) => {
    // Legacy base64url credentials are case-sensitive and must stay unchanged.
    if (legacyCode.test(value)) return value;
    const compact = value.replace(/[\s-]/g, "").toUpperCase();
    return shortCode.test(compact)
      ? `${compact.slice(0, 4)}-${compact.slice(4)}`
      : value;
  })
  .refine(
    (value) =>
      legacyCode.test(value) ||
      /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(value),
  );

export function createContinuationCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const value = Array.from(bytes, (byte) => alphabet[byte & 31]).join("");
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}
