import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
const dir = resolve(process.env.SUITE_CONFIG_DIR ?? ".suite-dev"),
  secrets = resolve(dir, "secrets");
await mkdir(secrets, { recursive: true, mode: 0o700 });
const put = async (name, value) => {
  try {
    await writeFile(resolve(secrets, name), value, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  return (await readFile(resolve(secrets, name), "utf8")).trim();
};
const rnd = () => randomBytes(32).toString("hex");
const casePw = await put("case_pg_password", rnd()),
  privatePw = await put("private_pg_password", rnd()),
  caseRuntime = await put("case_runtime_password", rnd()),
  privateRuntime = await put("private_runtime_password", rnd());
await put(
  "case_database_url",
  `postgres://wb_case:${caseRuntime}@case-db:5432/suite_cases`,
);
await put(
  "privacy_database_url",
  `postgres://wb_private:${privateRuntime}@private-db:5432/suite_privacy`,
);
await put(
  "case_migration_url",
  `postgres://postgres:${casePw}@case-db:5432/suite_cases`,
);
await put(
  "privacy_migration_url",
  `postgres://postgres:${privatePw}@private-db:5432/suite_privacy`,
);
for (const name of ["case_keyring", "vault_keyring"])
  await put(
    name,
    JSON.stringify({
      active: "k1",
      keys: { k1: randomBytes(32).toString("base64") },
    }),
  );
for (const name of [
  "service_event_key",
  "abuse_key",
  "privacy_abuse_key",
  "restic_password",
])
  await put(name, rnd());
try {
  await readFile(resolve(secrets, "capability_private_key"));
} catch {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await put(
    "capability_private_key",
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  );
  await put(
    "capability_public_key",
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
}
for (const name of [
  "staff_smtp_pass",
  "staff_google_client_secret",
  "jira_client_secret",
  "privacy_smtp_pass",
  "zoho_api_key",
  "twilio_sid",
  "twilio_token",
  "minimax_api_key",
  "backup_ssh_key",
  "backup_known_hosts",
])
  await put(name, "");
await put("storage_access_key", "GK" + randomBytes(16).toString("hex"));
await put("storage_secret_key", rnd());
const garageRpc = await put("garage_rpc_secret", rnd());
const garageAdmin = await put("garage_admin_token", rnd());
await put(
  "garage_config",
  `metadata_dir = "/meta"
data_dir = "/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "garage:3901"
rpc_secret = "${garageRpc}"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
[admin]
api_bind_addr = "127.0.0.1:3903"
admin_token = "${garageAdmin}"
`,
);
const domain = process.env.SUITE_DOMAIN ?? "localhost";
const production = process.argv.includes("--production");
if (production && domain === "localhost")
  throw new Error("Set SUITE_DOMAIN to the production hostname");
const env = `SUITE_CONFIG_DIR=${dir}\nSUITE_DOMAIN=${domain}\nPUBLIC_WEB_URL=${production ? "https://" + domain : "http://localhost:9551"}\nSUITE_NODE_ENV=${production ? "production" : "development"}\nJIRA_URL=\nJIRA_PROJECT_KEY=LWB\nJIRA_CLIENT_ID=\nSTAFF_GOOGLE_CLIENT_ID=\nSTAFF_SMTP_HOST=${production ? (process.env.STAFF_SMTP_HOST ?? "") : "mailpit"}\nSTAFF_SMTP_PORT=${production ? (process.env.STAFF_SMTP_PORT ?? "587") : "1025"}\nSTAFF_SMTP_FROM=Speak Up <no-reply@whistle.local>\nPRIVACY_SMTP_HOST=${production ? (process.env.PRIVACY_SMTP_HOST ?? "") : "mailpit"}\nPRIVACY_SMTP_PORT=${production ? (process.env.PRIVACY_SMTP_PORT ?? "587") : "1025"}\nPRIVACY_SMTP_FROM=Speak Up <no-reply@whistle.local>\nSTAFF_EMAIL_PROVIDER=smtp\nSTAFF_EMAIL_FROM=\nPRIVACY_EMAIL_PROVIDER=smtp\nPRIVACY_EMAIL_FROM=\nTWILIO_FROM=\nRESTIC_REPOSITORY=\nBACKUP_RETENTION_DAYS=\n`;
await writeFile(resolve(dir, "suite.env"), env, {
  mode: 0o600,
  flag: "wx",
}).catch((e) => {
  if (e.code !== "EEXIST") throw e;
});
console.log(
  "Suite configuration ready. Secrets are stored in protected files; existing values were preserved.",
);
