import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("topology transition rejects unrelated services, database, network and volume changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wb-topology-"));
  try {
    const services = Object.fromEntries(
      [
        "case-api",
        "privacy-api",
        "web",
        "converter",
        "case-db",
        "private-db",
        "case-migrate",
        "private-migrate",
      ].map((n) => [n, {}]),
    );
    const after = {
      services,
      networks: { "case-db": { internal: true } },
      volumes: { "suite-case-db": {} },
      secrets: {},
    };
    const before = structuredClone(after);
    for (const name of [
      "scanner",
      "case-redis",
      "private-redis",
      "privacy-worker",
    ])
      before.services[name] = {};
    before.networks["signature-updates"] = {};
    before.volumes["suite-clamav"] = {};
    await writeFile(join(directory, "before.json"), JSON.stringify(before));
    const validate = async (value) => {
      await writeFile(join(directory, "after.json"), JSON.stringify(value));
      return spawnSync(
        "python3",
        [
          "scripts/deployment-topology.py",
          "validate",
          join(directory, "before.json"),
          join(directory, "after.json"),
        ],
        { encoding: "utf8" },
      );
    };
    assert.equal((await validate(after)).status, 0);
    const withStorage = structuredClone(after);
    withStorage.services.garage = {
      image:
        "dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020",
      networks: { "evidence-storage": {} },
    };
    withStorage.networks["evidence-storage"] = { internal: true };
    withStorage.volumes["garage-data"] = {};
    withStorage.volumes["garage-meta"] = {};
    assert.equal((await validate(withStorage)).status, 0);
    const externalStorage = structuredClone(withStorage);
    externalStorage.networks["evidence-storage"].internal = false;
    assert.notEqual((await validate(externalStorage)).status, 0);
    const exposed = structuredClone(withStorage);
    exposed.services.garage.ports = ["3900:3900"];
    assert.notEqual((await validate(exposed)).status, 0);
    const unpinned = structuredClone(withStorage);
    unpinned.services.garage.image = "dxflrs/garage:latest";
    assert.notEqual((await validate(unpinned)).status, 0);
    for (const mutate of [
      (c) => {
        c.services["case-db"].image = "postgres:99";
      },
      (c) => {
        delete c.services.converter;
      },
      (c) => {
        c.services.unrelated = {};
      },
      (c) => {
        c.services.scanner = {};
      },
      (c) => {
        c.services.web.ports = ["0.0.0.0:443:9551"];
      },
      (c) => {
        c.networks["case-db"].internal = false;
      },
      (c) => {
        delete c.volumes["suite-case-db"];
      },
      (c) => {
        c.volumes.unrelated = {};
      },
      (c) => {
        c.secrets.missing = { file: "/does-not-exist-secret-path" };
      },
    ]) {
      const changed = structuredClone(after);
      mutate(changed);
      const result = await validate(changed);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /transition check failed/);
      assert.doesNotMatch(result.stderr, /secret-path/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
