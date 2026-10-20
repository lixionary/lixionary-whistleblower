import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

const root = fileURLToPath(new URL("..", import.meta.url));
const host = "lixsu@lixionary.com";
const remoteRoot = "/app/lixionary-whistleblower";
const publicUrl = "https://whistle-blower.lixionary.com";
const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ConnectTimeout=15",
];
const magic = Buffer.from("WBDEPLOY1\n");
const maxSnapshotBytes = 60 * 1024 ** 3;

export async function verifyBackup(archive, keyFile) {
  const file = await open(archive, "r");
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(magic.length + 12);
    const tag = Buffer.alloc(16);
    if (size < header.length + tag.length) throw new Error("Truncated backup");
    if (size - header.length - tag.length > maxSnapshotBytes)
      throw new Error("Snapshot exceeds the 60 GiB deployment backup limit");
    await file.read(header, 0, header.length, 0);
    await file.read(tag, 0, tag.length, size - tag.length);
    if (!header.subarray(0, magic.length).equals(magic))
      throw new Error("Invalid backup format");
    const key = await readFile(keyFile);
    if (key.length !== 32) throw new Error("Invalid backup key");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(magic.length),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    await pipeline(
      createReadStream(archive, {
        start: header.length,
        end: size - tag.length - 1,
      }),
      decipher,
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
  } finally {
    await file.close();
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `${command} failed; check command availability and authentication.`,
    );
  return result.stdout.trim();
}

function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

async function archiveImages(tags, output) {
  const save = spawn("docker", ["save", ...tags], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const gzip = spawn("gzip", ["-1"], { stdio: ["pipe", "pipe", "inherit"] });
  const completion = (child) =>
    new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? accept()
          : reject(new Error(`Image archive command exited ${code}`)),
      );
    });
  try {
    await Promise.all([
      completion(save),
      completion(gzip),
      pipeline(save.stdout, gzip.stdin),
      pipeline(
        gzip.stdout,
        createWriteStream(output, { flags: "wx", mode: 0o600 }),
      ),
    ]);
  } catch (error) {
    save.kill();
    gzip.kill();
    throw error;
  }
}

export async function extractSourceArchive(archive, source) {
  // Git's tracked modes must survive the protected umask. The outer directory
  // remains owner-only; image application files must be readable by UID 1000.
  await run("tar", ["-xpf", archive, "-C", source]);
}

async function buildRelease(revision, id) {
  const folder = resolve(root, ".suite-dev/deployments", id);
  const source = resolve(folder, "source");
  await mkdir(source, { recursive: true, mode: 0o700 });
  const sourceTar = resolve(folder, "source.tar");
  await run("git", [
    "archive",
    "--format=tar",
    `--output=${sourceTar}`,
    revision,
  ]);
  await extractSourceArchive(sourceTar, source);
  const images = {},
    tags = [];
  for (const [kind, app] of [
    ["case", "server"],
    ["private", "privacy"],
    ["web", "web"],
  ]) {
    const tag = `whistle-suite-${kind}:deploy-${id}`;
    console.log(`Building ${kind} for linux/amd64 on this machine...`);
    await run("docker", [
      "buildx",
      "build",
      "--platform",
      "linux/amd64",
      "--load",
      "--label",
      `org.opencontainers.image.revision=${revision}`,
      ...(kind === "web" ? ["--build-arg", `APP_REVISION=${revision}`] : []),
      "--tag",
      tag,
      "--file",
      resolve(source, `apps/${app}/Dockerfile`),
      source,
    ]);
    const image = JSON.parse(capture("docker", ["image", "inspect", tag]))[0];
    if (image.Architecture !== "amd64" || image.Os !== "linux")
      throw new Error("Build produced an unexpected platform");
    console.log(`Checking ${kind} runtime code as UID 1000...`);
    await run("docker", [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      "1000:1000",
      "--workdir",
      kind === "web" ? "/app/apps/web" : "/app",
      "--entrypoint",
      "node",
      tag,
      "-e",
      kind === "web"
        ? 'const req=require("module").createRequire(require.resolve("next/package.json"));req("sharp");console.log("Frontend runtime dependencies readable");'
        : 'import("./dist/jobs.js").then(()=>console.log("Application runtime dependencies readable")).catch(()=>process.exit(1));',
    ]);
    images[kind] = image.Id;
    tags.push(tag);
  }
  await writeFile(
    resolve(folder, "images.json"),
    JSON.stringify({ revision, images }, null, 2),
    { mode: 0o600 },
  );
  console.log("Packing application images for SSH transfer...");
  await archiveImages(tags, resolve(folder, "images.tar.gz"));
  return folder;
}

async function remoteDeploy(revision, id, folder) {
  // The revision and generated identifier contain only validated safe characters.
  const remote = `${remoteRoot}/.suite-config/releases/${id}`;
  await run("ssh", [...sshOptions, host, `umask 077; mkdir -p ${remote}`]);
  await run("scp", [
    ...sshOptions,
    "-p",
    resolve(folder, "images.tar.gz"),
    resolve(folder, "images.json"),
    resolve(root, "scripts/deploy-vps-remote.sh"),
    resolve(root, "scripts/deployment-backup.py"),
    resolve(root, "scripts/deployment-topology.py"),
    resolve(root, "scripts/setup-storage-config.py"),
    `${host}:${remote}/`,
  ]);
  const command = `exec bash ${remote}/deploy-vps-remote.sh deploy ${revision} ${id}`;
  await new Promise((accept, reject) => {
    const child = spawn("ssh", [...sshOptions, host, command], {
      cwd: root,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buffer = "",
      backupSeen = false,
      activated = false,
      failure;
    const fail = (error) => {
      failure = error;
      child.stdin.end("BACKUP_FAILED\n");
    };
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("__WB_BACKUP_READY__ ")) {
          const returnedId = line.slice("__WB_BACKUP_READY__ ".length);
          if (backupSeen || returnedId !== id) {
            fail(new Error("Unexpected backup handshake"));
            continue;
          }
          backupSeen = true;
          void (async () => {
            const archive = resolve(folder, "snapshot.wbenc"),
              key = resolve(folder, "recovery.key");
            const remote = `${host}:${remoteRoot}/.suite-config/releases/${id}`;
            await run("scp", [
              ...sshOptions,
              "-p",
              `${remote}/snapshot.wbenc`,
              archive,
            ]);
            await run("scp", [
              ...sshOptions,
              "-p",
              `${remote}/recovery.key`,
              key,
            ]);
            await chmod(archive, 0o600);
            await chmod(key, 0o600);
            await verifyBackup(archive, key);
            console.log(`Encrypted backup copied and authenticated: ${folder}`);
            child.stdin.end(`BACKUP_VERIFIED ${id}\n`);
          })().catch(fail);
        } else if (line === `__WB_DEPLOY_OK__ ${revision}`) {
          activated = true;
        } else {
          console.log(line);
        }
      }
    });
    child.once("close", (code) => {
      if (failure) reject(failure);
      else if (code !== 0 || !backupSeen || !activated)
        reject(
          new Error(
            `VPS deployment failed (exit ${code}); inspect the protected release logs on the VPS.`,
          ),
        );
      else accept();
    });
  });
}

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  args = args.filter((arg) => arg !== "--");
  if (args.includes("--help")) {
    console.log(
      "Usage: pnpm deploy:vps [--check] [--push]\nValidate and build linux/amd64 images locally, then deploy a committed main revision to lixsu@lixionary.com.\n--check: inspect prerequisites without deploying; allows uncommitted local work.\n--push: push validated main before deployment.",
    );
    return;
  }
  if (
    args.some((arg) => !["--check", "--push"].includes(arg)) ||
    (args.includes("--check") && args.includes("--push"))
  )
    throw new Error("Use --check or --push; see --help.");
  const check = args.includes("--check");
  if (capture("git", ["branch", "--show-current"]) !== "main")
    throw new Error("Switch to main and commit the intended changes first.");
  const revision = capture("git", ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid Git revision");
  const dirty = Boolean(capture("git", ["status", "--porcelain"]));
  if (dirty && !check)
    throw new Error(
      "Working tree is dirty. Commit or remove unrelated changes before deployment.",
    );
  capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  capture("docker", ["buildx", "version"]);
  {
    console.log(
      `Checking VPS prerequisites${dirty ? " (local changes will not be deployed)" : ""}...`,
    );
    const script = await readFile(
      new URL("./deploy-vps-remote.sh", import.meta.url),
    );
    await new Promise((accept, reject) => {
      const child = spawn(
        "ssh",
        [...sshOptions, host, `bash -s -- check ${revision}`],
        { cwd: root, stdio: ["pipe", "inherit", "inherit"] },
      );
      child.stdin.on("error", () => {});
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? accept()
          : reject(new Error(`VPS preflight exited ${code}`)),
      );
      child.stdin.end(script);
    });
  }
  if (check) return;
  for (const task of ["typecheck", "test", "test:deploy", "build"])
    await run("pnpm", [task]);
  await run("pnpm", ["audit", "--prod", "--audit-level", "high"]);
  // Refuse an edit or branch change made while validation was running.
  if (
    capture("git", ["rev-parse", "HEAD"]) !== revision ||
    capture("git", ["status", "--porcelain"])
  )
    throw new Error("Local checkout changed during validation.");
  if (args.includes("--push")) await run("git", ["push", "origin", "main"]);
  const upstream = capture("git", [
    "ls-remote",
    "origin",
    "refs/heads/main",
  ]).split(/\s+/)[0];
  if (upstream !== revision)
    throw new Error(
      "origin/main must match this revision. Push it first or use --push.",
    );
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.[0-9]+Z$/, "Z");
  const id = `${revision}-${stamp}-${process.pid}`;
  const folder = await buildRelease(revision, id);
  if (
    capture("git", ["rev-parse", "HEAD"]) !== revision ||
    capture("git", ["status", "--porcelain"])
  )
    throw new Error("Local checkout changed during the image build.");
  console.log(`Deploying ${revision} to ${host}:${remoteRoot}`);
  await remoteDeploy(revision, id, folder);
  for (const path of ["/", "/staff/login", "/api/health", "/privacy/health"]) {
    const response = await fetch(publicUrl + path, {
      signal: AbortSignal.timeout(20000),
    });
    if (response.status !== 200)
      throw new Error(`Public HTTPS verification failed on ${path}`);
    if (path.endsWith("/health") && (await response.json()).ok !== true)
      throw new Error("API health failed");
    await response.body?.cancel().catch(() => {});
  }
  console.log(
    `Deployed ${revision}; public HTTPS and both APIs verified at ${publicUrl}`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
