import { readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
function run(args, quiet = true) {
  const r = spawnSync(args[0], args.slice(1), {
    stdio: quiet ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (r.status !== 0)
    throw new Error("Storage integration fixture command failed");
  return r.stdout;
}
run(["node", "scripts/setup-suite.mjs"]);
const directory = resolve(".suite-dev"),
  configuration = resolve(directory, "evidence-test-garage.toml");
await writeFile(
  configuration,
  (await readFile(resolve(directory, "secrets/garage_config"), "utf8")).replace(
    "garage:3901",
    "127.0.0.1:3901",
  ),
  { mode: 0o600 },
);
await chmod(configuration, 0o600);
const name = "whistle-evidence-storage-test";
if (spawnSync("docker", ["inspect", name], { stdio: "ignore" }).status !== 0)
  run([
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1:6414:3900",
    "-v",
    `${configuration}:/etc/garage.toml:ro`,
    "-v",
    "whistle-evidence-test-data:/data",
    "-v",
    "whistle-evidence-test-meta:/meta",
    "dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020",
    "/garage",
    "server",
    "--single-node",
  ]);
else run(["docker", "start", name]);
for (let n = 0; n < 30; n++) {
  if (
    spawnSync("docker", ["exec", name, "/garage", "status"], {
      stdio: "ignore",
    }).status === 0
  )
    break;
  await new Promise((r) => setTimeout(r, 500));
}
const key = (
    await readFile(resolve(directory, "secrets/storage_access_key"), "utf8")
  ).trim(),
  secret = (
    await readFile(resolve(directory, "secrets/storage_secret_key"), "utf8")
  ).trim();
const command = ["docker", "exec", name, "/garage"];
if (
  spawnSync(
    command[0],
    [...command.slice(1), "bucket", "info", "whistle-evidence"],
    { stdio: "ignore" },
  ).status !== 0
)
  run([...command, "bucket", "create", "whistle-evidence"]);
if (
  spawnSync(command[0], [...command.slice(1), "key", "info", key], {
    stdio: "ignore",
  }).status !== 0
)
  run([
    ...command,
    "key",
    "import",
    "--yes",
    "-n",
    "whistle-evidence",
    key,
    secret,
  ]);
run([
  ...command,
  "bucket",
  "allow",
  "--read",
  "--write",
  "whistle-evidence",
  "--key",
  key,
]);
const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@whistle/privacy",
    "exec",
    "vitest",
    "run",
    "test/storage.integration.test.ts",
  ],
  { stdio: "inherit", env: { ...process.env, STORAGE_INTEGRATION: "1" } },
);
process.exitCode = result.status ?? 1;
