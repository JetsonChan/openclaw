import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { beginDoctorMaintenance } from "../commands/doctor-maintenance.js";
import { preserveDoctorOriginalState } from "../commands/doctor-original-capture.js";
import * as declarations from "../plugins/doctor-contract-registry.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { findReusableDoctorCapture } from "./doctor-capture-reuse.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import { resolveManagedUpdateLeaseDatabasePath } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await fs.realpath(dirs.make("doctor-capture-reuse-"));
  const stateDir = path.join(root, "state");
  const temporary = path.join(root, "tmp");
  const plugin = path.join(root, "plugin-data");
  await Promise.all([stateDir, temporary, plugin].map((dir) => fs.mkdir(dir)));
  const config = path.join(stateDir, "openclaw.json");
  await fs.writeFile(config, "{}");
  const file = path.join(plugin, "data.txt");
  await fs.writeFile(file, "before");
  const env = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: config,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_UPDATE_IN_PROGRESS: undefined,
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER: undefined,
  };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  expect(resolveManagedUpdateLeaseDatabasePath().startsWith(`${temporary}${path.sep}`)).toBe(true);
  const resources: Array<{ path: string; kind: "file" | "directory" | "sqlite" }> = [
    { path: plugin, kind: "directory" },
  ];
  // Only the plugin's declaration producer is synthetic. Capture, verification,
  // source comparison, retention, and Doctor's entry point are real.
  vi.spyOn(declarations, "preparePluginDoctorMigrationBackupResources").mockImplementation(
    async () => ({ resources, deferredPluginIds: new Set(), notices: [], assertCurrent() {} }),
  );
  const capture = async (fullIntegrityCheck?: boolean) => {
    const runtime = { log() {}, error() {}, exit() {} };
    let result: Awaited<ReturnType<typeof preserveDoctorOriginalState>> | undefined;
    const maintenance = await beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true },
      root,
      env: { ...process.env },
      runtime,
      beforeStateMutation: async ({ env: selectedEnv, signal }) => {
        result = await preserveDoctorOriginalState({
          fullIntegrityCheck,
          root,
          env: selectedEnv,
          runtime,
          signal,
          assertCurrent: getOpenClawDatabaseMaintenanceScope()!.assertAdmission,
        });
      },
    });
    await maintenance?.release();
    if (!result) {
      throw new Error("Doctor did not enter its admitted original-state capture boundary");
    }
    return result;
  };
  const captures = async () =>
    (await fs.readdir(resolveUpdateCaptureRoot(stateDir))).filter((name) =>
      name.startsWith("doctor-"),
    );
  const reuse = () =>
    findReusableDoctorCapture({
      stateDir,
      installRoot: root,
      env: { ...process.env },
      assertCurrent() {},
    });
  return { root, stateDir, plugin, file, config, resources, capture, captures, reuse };
}

it("reuses a sealed standalone baseline only while the complete source is unchanged", async () => {
  const f = await fixture();
  expect((await f.capture()).warnings).toEqual([]);
  const first = await f.captures();
  expect(first).toHaveLength(1);
  expect((await f.capture()).warnings).toEqual([]);
  expect(await f.captures()).toEqual(first);
  // Same-size writes with restored mtime are not evidence of equality.
  const stat = await fs.stat(f.file);
  await fs.writeFile(f.file, "after!");
  await fs.utimes(f.file, stat.atime, stat.mtime);
  expect((await f.capture()).warnings).toEqual([]);
  expect(await f.captures()).toHaveLength(2);
  expect((await f.capture(true)).warnings).toEqual([]);
  expect(await f.captures(), "explicit full integrity verification does not reuse").toHaveLength(3);
});

it("rediscovers files, declared paths, config includes, links, permissions, and new agent databases", async () => {
  const f = await fixture();
  const missing = path.join(f.root, "not-created");
  f.resources.push({ path: missing, kind: "file" });
  const link = path.join(f.plugin, "link");
  await fs.symlink("data.txt", link);
  await fs.chmod(f.file, 0o600);
  expect((await f.capture()).warnings).toEqual([]);
  expect(await f.reuse()).toBeDefined();

  const added = path.join(f.plugin, "new.txt");
  await fs.writeFile(added, "new data");
  expect(await f.reuse(), "added directory child").toBeUndefined();
  await fs.rm(added);
  await fs.rm(f.file);
  expect(await f.reuse(), "removed directory child").toBeUndefined();
  await fs.writeFile(f.file, "before", { mode: 0o600 });
  await fs.chmod(f.file, 0o644);
  expect(await f.reuse(), "changed permissions").toBeUndefined();
  await fs.chmod(f.file, 0o600);
  await fs.rm(link);
  await fs.symlink("elsewhere.txt", link);
  expect(await f.reuse(), "changed link target").toBeUndefined();
  await fs.rm(link);
  await fs.symlink("data.txt", link);
  await fs.writeFile(missing, "new data");
  expect(await f.reuse(), "previously missing resource").toBeUndefined();
  await fs.rm(missing);
  f.resources.push({ path: path.join(f.root, "new-declaration"), kind: "file" });
  expect(await f.reuse(), "new plugin declaration even when absent").toBeUndefined();
  f.resources.pop();
  const include = path.join(f.stateDir, "included.json");
  await fs.writeFile(include, "{}");
  await fs.writeFile(f.config, '{"$include":"included.json"}');
  expect(await f.reuse(), "new configured include").toBeUndefined();
  await fs.writeFile(f.config, "{}");
  await fs.rm(include);
  const agent = path.join(f.stateDir, "agents/new-agent/agent/openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(agent), { recursive: true });
  {
    using db = new DatabaseSync(agent);
    db.exec("CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('new agent')");
  }
  expect(await f.reuse(), "new on-disk database outside original roots").toBeUndefined();
  await fs.rm(agent);
  // The newly discovered agent directory itself adds a missing database root.
  expect(await f.reuse(), "new agent inventory survives database removal").toBeUndefined();
  await fs.rm(path.join(f.stateDir, "agents/new-agent"), { recursive: true });
  expect(
    await f.reuse(),
    "restored exact source is reusable despite timestamp drift",
  ).toBeDefined();
});

it("verifies retained payloads and seals, and leaves unusable originals intact while capturing fresh", async () => {
  const f = await fixture();
  expect((await f.capture()).warnings).toEqual([]);
  const ref = await f.reuse();
  expect(ref).toBeDefined();
  const manifest = parseUpdateRecoveryBackupManifest(await fs.readFile(ref!.manifestPath, "utf8"));
  const entry = manifest.entries.find((candidate) => candidate.sourcePath === f.file);
  if (entry?.kind !== "file") {
    throw new Error("Expected captured plugin file");
  }
  const partial = `${ref!.manifestPath}.partial`;
  await fs.writeFile(partial, "unfinished");
  expect(await f.reuse()).toBeUndefined();
  await fs.rm(partial);
  await fs.mkdir(path.join(ref!.directory, "candidate"));
  expect(await f.reuse()).toBeUndefined();
  await fs.rm(path.join(ref!.directory, "candidate"), { recursive: true });
  await fs.writeFile(path.join(ref!.directory, entry.archivePath), "broken");
  expect(await f.reuse()).toBeUndefined();
  expect((await f.capture()).warnings).toEqual([]);
  expect(await f.captures()).toHaveLength(2);
  expect(await fs.readFile(path.join(ref!.directory, entry.archivePath), "utf8")).toBe("broken");
});

it("accepts only exact consolidated SQLite bytes and rejects durable WAL data and changed databases", async () => {
  const f = await fixture();
  const file = path.join(f.plugin, "plugin.sqlite");
  {
    using db = new DatabaseSync(file);
    db.exec("CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES('retained')");
  }
  expect((await f.capture()).warnings).toEqual([]);
  const [name] = await f.captures();
  const directory = path.join(resolveUpdateCaptureRoot(f.stateDir), name!);
  const manifest = parseUpdateRecoveryBackupManifest(
    await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  const entry = manifest.entries.find((candidate) => candidate.sourcePath === file);
  if (entry?.kind !== "file" || !entry.sqlite) {
    throw new Error("Expected consolidated SQLite capture");
  }
  const payload = await fs.readFile(path.join(directory, entry.archivePath));
  // Doctor retains original bytes under maintenance custody. Repeating capture
  // without a repair must reuse the same image, not require rewriting the source.
  expect(await fs.readFile(file)).toEqual(payload);
  expect((await f.capture()).warnings).toEqual([]);
  expect(await f.captures()).toEqual([name]);
  expect(await f.reuse()).toBeDefined();
  await fs.writeFile(`${file}-wal`, "");
  await fs.writeFile(`${file}-shm`, "disposable index");
  expect(await f.reuse()).toBeDefined();
  await fs.rm(`${file}-wal`);
  await fs.rm(`${file}-shm`);
  let writer: DatabaseSync | undefined;
  let retainedWal: Buffer | undefined;
  try {
    writer = new DatabaseSync(file);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO payload VALUES('newer')",
    );
    retainedWal = await fs.readFile(`${file}-wal`);
    expect(retainedWal.length).toBeGreaterThan(0);
    expect(await f.reuse(), "uncheckpointed data is not in the main-file digest").toBeUndefined();
  } finally {
    writer?.close();
  }
  expect(await f.reuse(), "checkpointed changed data").toBeUndefined();
  await fs.writeFile(file, payload);
  await fs.writeFile(`${file}-wal`, retainedWal!);
  expect(await fs.readFile(file)).toEqual(payload);
  expect(
    await f.reuse(),
    "retained WAL data refuses even an exact main-file match",
  ).toBeUndefined();
  await fs.rm(`${file}-wal`);
  await fs.writeFile(`${file}-journal`, "retained journal");
  expect(await f.reuse(), "unresolved rollback journal").toBeUndefined();
  await fs.rm(`${file}-journal`);
  expect(await f.reuse()).toBeDefined();
});

it("reuses large unchanged originals instead of falling back because of their byte size", async () => {
  const f = await fixture();
  const large = path.join(f.plugin, "history.bin");
  await using source = await fs.open(large, "wx");
  await source.truncate(257 * 1024 * 1024);
  await source.write("retained history", 0, "utf8");
  await source.sync();
  expect((await f.capture()).warnings).toEqual([]);
  const first = await f.captures();
  expect(first).toHaveLength(1);
  expect((await f.capture()).warnings).toEqual([]);
  expect(await f.captures()).toEqual(first);
});

it("treats the verification entry bound as a cache miss and still creates a fresh baseline", async () => {
  const f = await fixture();
  // Empty real directories reach the inspection bound without large payloads.
  for (let i = 0; i < 4096; i++) {
    await fs.mkdir(path.join(f.plugin, String(i)));
  }
  expect((await f.capture()).warnings).toEqual([]);
  expect(await f.reuse()).toBeUndefined();
  expect((await f.capture()).warnings).toEqual([]);
  expect(await f.captures()).toHaveLength(2);
});
