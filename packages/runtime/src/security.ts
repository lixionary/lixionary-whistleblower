import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  sign,
  verify,
} from "node:crypto";
import argon2 from "argon2";

export type Keyring = { active: string; keys: Record<string, string> };
export function parseKeyring(raw: string): Keyring {
  let ring: Keyring;
  try {
    ring = JSON.parse(raw);
    if (!ring || !ring.keys || typeof ring.keys !== "object") throw new Error();
  } catch {
    throw new Error("Invalid encryption keyring");
  }
  if (
    !/^[a-zA-Z0-9_-]{1,40}$/.test(ring.active) ||
    !ring.keys[ring.active] ||
    Object.entries(ring.keys).some(
      ([id, k]) =>
        !/^[a-zA-Z0-9_-]{1,40}$/.test(id) ||
        typeof k !== "string" ||
        Buffer.from(k, "base64").length !== 32,
    )
  )
    throw new Error("Invalid encryption keyring");
  return ring;
}
export function seal(value: unknown, ring: Keyring, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(ring.keys[ring.active]!, "base64"),
    iv,
  );
  cipher.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return [
    "v2",
    ring.active,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url"),
  ].join(":");
}
export function unseal<T>(value: string, ring: Keyring, purpose: string): T {
  const [version, kid, iv, tag, ct] = value.split(":");
  if (version !== "v2" || !kid || !ring.keys[kid] || !iv || !tag || !ct)
    throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(ring.keys[kid]!, "base64"),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(ct, "base64url")),
      decipher.final(),
    ]).toString(),
  ) as T;
}
export const token = () => randomBytes(32).toString("base64url");
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function generateCrockford(
  groups: number = 2,
  groupLength: number = 4,
): string {
  const bytes = randomBytes(groups * groupLength);
  const parts: string[] = [];
  let byteIndex = 0;
  for (let g = 0; g < groups; g++) {
    let part = "";
    for (let i = 0; i < groupLength; i++) {
      part += CROCKFORD_ALPHABET[bytes[byteIndex++]! % CROCKFORD_ALPHABET.length];
    }
    parts.push(part);
  }
  return parts.join("-");
}
export function normalizeSecret(secret: string): string {
  return secret.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const mac = (key: string, value: string) =>
  createHmac("sha256", key).update(value).digest("hex");
export function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const hashSecret = (secret: string) =>
  argon2.hash(secret, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
let dummy: Promise<string> | undefined;
export async function checkSecret(
  hash: string | undefined,
  secret: string,
): Promise<boolean> {
  const candidate = hash ?? (await (dummy ??= hashSecret(token())));
  try {
    const ok = await argon2.verify(candidate, secret);
    return Boolean(hash) && ok;
  } catch {
    return false;
  }
}
export async function checkNormalizedSecret(
  hash: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!hash) return checkSecret(undefined, secret);
  const normalized = normalizeSecret(secret);
  if (await checkSecret(hash, normalized)) return true;
  if (secret !== normalized && (await checkSecret(hash, secret))) return true;
  return false;
}
export type Capability = {
  sub: string;
  sid: string;
  version: number;
  purpose: "reporter" | "intake";
  exp: number;
  jti: string;
};
export function capability(
  value: Omit<Capability, "exp" | "jti">,
  key: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...value,
      exp: Math.floor(Date.now() / 1000) + 60,
      jti: token(),
    }),
  ).toString("base64url");
  return (
    payload + "." + sign(null, Buffer.from(payload), key).toString("base64url")
  );
}
export function verifyCapability(value: string, publicKey: string): Capability {
  const [body, signature, extra] = value.split(".");
  if (
    !body ||
    !signature ||
    extra ||
    !verify(
      null,
      Buffer.from(body),
      publicKey,
      Buffer.from(signature, "base64url"),
    )
  )
    throw new Error("Invalid capability");
  const data = JSON.parse(
    Buffer.from(body, "base64url").toString(),
  ) as Capability;
  if (
    !/^[a-f0-9-]{36}$/i.test(data.sub) ||
    !/^[a-f0-9-]{36}$/i.test(data.sid) ||
    !Number.isInteger(data.version) ||
    data.version < 1 ||
    !Number.isInteger(data.exp) ||
    !/^[a-zA-Z0-9_-]{43}$/.test(data.jti) ||
    !["reporter", "intake"].includes(data.purpose) ||
    data.exp <= Math.floor(Date.now() / 1000) ||
    data.exp > Math.floor(Date.now() / 1000) + 65
  )
    throw new Error("Expired capability");
  return data;
}
export function safeError(err: unknown): { name: string; code?: string } {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  return { name: e?.name ?? "Error", code: e?.cause?.code ?? e?.code };
}
