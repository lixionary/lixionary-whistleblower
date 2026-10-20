import { readFileSync } from "node:fs";
import { parseKeyring, loadEmailConfig } from "@whistle/runtime";
function get(name: string, env: NodeJS.ProcessEnv, required = true) {
  const file = env[`${name}_FILE`],
    value = file ? readFileSync(file, "utf8").trim() : env[name];
  if (required && !value) throw new Error(`${name} required`);
  return value ?? "";
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.NODE_ENV === "production" &&
    !env.PUBLIC_WEB_URL?.startsWith("https://")
  )
    throw new Error("Production requires PUBLIC_WEB_URL with HTTPS");
  const evidenceBackend = env.PRIVACY_EVIDENCE_BACKEND ?? "filesystem";
  if (!["filesystem", "s3"].includes(evidenceBackend))
    throw new Error("Invalid evidence backend");
  const s3 = {
    endpoint: env.PRIVACY_S3_ENDPOINT ?? "http://garage:3900",
    region: env.PRIVACY_S3_REGION ?? "garage",
    bucket: env.PRIVACY_S3_BUCKET ?? "whistle-evidence",
    accessKey: get("PRIVACY_S3_ACCESS_KEY", env, evidenceBackend === "s3"),
    secretKey: get("PRIVACY_S3_SECRET_KEY", env, evidenceBackend === "s3"),
  };
  return {
    env: env.NODE_ENV ?? "development",
    production: env.NODE_ENV === "production",
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 6405),
    webUrl: env.PUBLIC_WEB_URL ?? "http://localhost:9551",
    caseUrl: env.CASE_ORIGIN ?? "http://localhost:9550",
    dbUrl: get("PRIVACY_DATABASE_URL", env),
    keys: parseKeyring(get("VAULT_KEYRING", env)),
    publicKey: get("CAPABILITY_PUBLIC_KEY", env),
    eventKey: get("SERVICE_EVENT_KEY", env),
    abuseKey: get("PRIVACY_ABUSE_KEY", env),
    evidenceBackend: evidenceBackend as "filesystem" | "s3",
    s3,
    storage: env.PRIVACY_STORAGE ?? "./data/privacy",
    trustProxy:
      env.TRUST_PROXY === "1"
        ? (_address: string, hop: number) => hop === 0
        : false,
    email: loadEmailConfig("PRIVACY", env),
    twilio: {
      sid: get("TWILIO_ACCOUNT_SID", env, false),
      token: get("TWILIO_AUTH_TOKEN", env, false),
      from: env.TWILIO_FROM ?? "",
    },
    ai: {
      apiKey: get("MINIMAX_API_KEY", env, false),
      baseUrl: env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1",
      model: env.MINIMAX_MODEL ?? "MiniMax-M3",
      thinking: "disabled" as const,
      timeoutMs: 45000,
    },
  };
}
export type Config = ReturnType<typeof loadConfig>;
