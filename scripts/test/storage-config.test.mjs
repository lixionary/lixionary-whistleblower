import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
test("storage setup preserves secrets, protects files and does not print credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wb-storage-config-"));
  try {
    const setup = () =>
      spawnSync("python3", ["scripts/setup-storage-config.py", directory], {
        encoding: "utf8",
      });
    const initial = setup();
    assert.equal(initial.status, 0);
    const names = [
        "storage_access_key",
        "storage_secret_key",
        "garage_rpc_secret",
        "garage_admin_token",
        "garage_config",
      ],
      values = {};
    for (const name of names) {
      const path = join(directory, "secrets", name);
      values[name] = await readFile(path, "utf8");
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.ok(!initial.stdout.includes(values[name].trim()));
    }
    assert.equal(setup().status, 0);
    for (const name of names)
      assert.equal(
        await readFile(join(directory, "secrets", name), "utf8"),
        values[name],
      );
    assert.match(values.garage_config, /metadata_dir = "\/meta"/);
    assert.match(values.garage_config, /data_dir = "\/data"/);
    assert.match(values.garage_config, /api_bind_addr = "127.0.0.1:3903"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
