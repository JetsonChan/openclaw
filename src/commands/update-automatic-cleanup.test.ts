import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { automaticallyCleanUpdateRecovery } from "../cli/update-cli/automatic-cleanup.js";
import { prepareUpdateCommandTerminalResult } from "../cli/update-cli/update-command-terminal.js";
import { cleanupGatewayUpdateRecovery } from "../gateway/update-automatic-cleanup.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "../infra/update-capture-privacy-marker.js";
import { createRetainedUpdateRecovery } from "../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { defaultRuntime } from "../runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  completeDoctorMigrationBackups,
  recordDoctorMigrationBackups,
} from "./doctor-migration-backup-artifacts.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let env: NodeJS.ProcessEnv;
let stateDir: string;
let now: number;
beforeEach(() => {
  const home = fs.realpathSync(dirs.make("automatic-recovery-cleanup-"));
  stateDir = path.join(home, "state");
  fs.mkdirSync(stateDir);
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_HOME: "",
    OPENCLAW_PROFILE: "",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  })) {
    vi.stubEnv(key, value);
  }
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, "{}\n");
  env = { ...process.env };
  now = Date.now();
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await cleanupSessionStateForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function capture(runId: string, doctor = false, age = 0) {
  const directory = path.join(resolveUpdateCaptureRoot(stateDir), runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
    UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
  );
  fs.writeFileSync(path.join(directory, "payload"), "preserved rollback bytes");
  fs.writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify(
      doctor
        ? {
            schemaVersion: 2,
            kind: "update-recovery",
            generation: { kind: "baseline" },
            databases: [],
            runId,
            installRoot: stateDir,
            stateDir,
            configPath: env.OPENCLAW_CONFIG_PATH,
            configPaths: [env.OPENCLAW_CONFIG_PATH],
            creator: { host: "fixture", pid: 1, startIdentity: "1" },
            drivers: [],
            createdAt: new Date(now - age * 86_400_000).toISOString(),
            roots: [env.OPENCLAW_CONFIG_PATH],
            excludedRoots: [],
            protectedPaths: [env.OPENCLAW_CONFIG_PATH],
            entries: [
              {
                kind: "missing",
                sourcePath: env.OPENCLAW_CONFIG_PATH,
                sqlite: false,
                directory: false,
              },
            ],
          }
        : {},
    ),
  );
  return directory;
}
function start(at: number) {
  using clock = vi.spyOn(Date, "now").mockReturnValue(at);
  return createUpdateRun({ trigger: "cli" }, { env }).runId;
}
async function complete(runId: string, at: number) {
  using clock = vi.spyOn(Date, "now").mockReturnValue(at);
  const emit = await prepareUpdateCommandTerminalResult(
    { opts: { json: true, run: { runId, env } } },
    { status: "ok", mode: "git", steps: [], durationMs: 1 },
    { rolledBack: false },
  );
  const result = await emit();
  expect(result.status).toBe("ok");
  expect(getUpdateRun(runId, { env })?.status).toBe("succeeded");
  return result;
}

it("retires the previous successful generation and migration originals, but retains current and protected recovery", async () => {
  const failed = start(now - 240_000);
  finishUpdateRun(failed, { status: "failed" }, { env });
  const failedCapture = capture(failed);
  const first = start(now - 120_000);
  const firstCapture = capture(first);
  await closeOpenClawStateDatabaseAsync();
  const source = resolveOpenClawStateSqlitePath(env);
  const backupId = randomUUID();
  const backup = `${source}.pre-startup-migration-${backupId}.bak`;
  await withDoctorSqliteMaintenanceLock({
    env,
    operation: "fixture migration",
    run: () => {
      fs.copyFileSync(source, backup);
      recordDoctorMigrationBackups(env, backupId, [
        { path: source, identity: fs.statSync(source, { bigint: true }), archivePath: backup },
      ]);
      completeDoctorMigrationBackups(env, [source]);
    },
  });
  await complete(first, now + 1_000);
  expect(fs.existsSync(firstCapture)).toBe(true);
  expect(fs.existsSync(backup)).toBe(true);
  const doctors = [5, 4, 3, 2, 1].map((age) => capture(`doctor-${randomUUID()}`, true, age));
  const orphan = capture("unmanifested");
  const second = start(now + 60_000);
  const secondCapture = capture(second);
  const result = await complete(second, now + 61_000);
  expect(result.steps.at(-1)?.advisory).toBeUndefined();
  expect(fs.existsSync(firstCapture)).toBe(false);
  expect(fs.existsSync(backup)).toBe(false);
  expect([secondCapture, failedCapture, orphan].map(fs.existsSync)).toEqual([true, true, true]);
  expect(doctors.map(fs.existsSync)).toEqual([false, false, true, true, true]);
  expect(
    result.steps.find((step) => step.name === "recovery-artifact-cleanup")?.advisory,
  ).toBeUndefined();
});

it("keeps durable success and reports an actual retirement failure in JSON and update status", async () => {
  const first = start(now - 120_000);
  const original = capture(first);
  await complete(first, now - 60_000);
  const second = start(now);
  const rm = fs.promises.rm;
  using failure = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
    if (String(target).startsWith(original + path.sep)) {
      throw new Error("injected retirement failure");
    }
    return rm(target, options);
  });
  const result = await complete(second, now + 1_000);
  expect(fs.existsSync(original)).toBe(true);
  expect(result.steps.at(-1)?.advisory?.message).toContain("injected retirement failure");
  const output = vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)?.[0] as UpdateRunResult;
  expect(output.status).toBe("ok");
  expect(output.steps.at(-1)?.advisory?.message).toContain("injected retirement failure");
  expect(getUpdateRun(second, { env })?.steps).toContainEqual(
    expect.objectContaining({
      step: "warning:recovery-artifact-cleanup",
      detail: expect.stringContaining("injected retirement failure"),
    }),
  );
});

it("runs retirement in the owning Gateway worker while manual cleanup still refuses its live lock", async () => {
  const pending = start(now - 240_000);
  const pendingCapture = capture(pending);
  finishUpdateRun(pending, { status: "rolled-back" }, { env });
  const first = start(now - 120_000);
  const original = capture(first);
  finishUpdateRun(first, { status: "succeeded" }, { env });
  const second = start(now + 60_000);
  const current = capture(second);
  {
    using clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    finishUpdateRun(second, { status: "succeeded" }, { env });
  }
  // Persist an actual pending recovery record after terminal history, as on
  // a restart observing old unresolved work. It must never release its capture.
  const runtime = { root: stateDir, nodePath: process.execPath, version: "1.0.0", buildId: null };
  createRetainedUpdateRecovery({ runId: pending, from: runtime, to: runtime }, { env });
  await closeOpenClawStateDatabaseAsync();
  const lock = await acquireGatewayLock({ env, role: "gateway", allowInTests: true });
  expect(lock).toBeTruthy();
  try {
    await expect(
      retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      }),
    ).rejects.toThrow(/ownership|lock/i);
    expect(fs.existsSync(original)).toBe(true);
    const result = await cleanupGatewayUpdateRecovery(second, env, () => lock!.assertCurrent());
    expect(result?.advisory).toBeUndefined();
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(pendingCapture)).toBe(true);
    expect(getUpdateRun(second, { env })?.status).toBe("succeeded");
  } finally {
    await lock?.release();
  }
});

it("does not retire artifacts when another process owns live state", async () => {
  const first = start(now - 120_000);
  const original = capture(first);
  finishUpdateRun(first, { status: "succeeded" }, { env });
  const second = start(now);
  finishUpdateRun(second, { status: "succeeded" }, { env });
  await closeOpenClawStateDatabaseAsync();
  const owner = acquireGatewayStateOwner({ databasePath: resolveOpenClawStateSqlitePath(env) });
  const lockPath = owner.path;
  owner.release();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { acquireFileLockSync } from "@openclaw/fs-safe/file-lock";
    const pathname = process.argv[1];
    const lock = acquireFileLockSync(pathname, { lockPath: pathname, retry: { retries: 0 },
      payload: () => ({ pid: process.pid, createdAt: new Date().toISOString(), configPath: "synthetic", role: "gateway", processNamespace: ${JSON.stringify(readGatewayLockProcessNamespace())} }) });
    process.on("message", () => { lock.release(); process.disconnect(); });
    process.send("held");
  `,
      lockPath,
    ],
    { env, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const closed = once(child, "close");
  try {
    await Promise.race([
      once(child, "message"),
      closed.then(() => {
        throw new Error("Foreign owner exited before acquiring its lock");
      }),
    ]);
    const result = await automaticallyCleanUpdateRecovery(second, env);
    expect(result?.advisory?.message).toMatch(/owner|ownership|Gateway/);
    expect(fs.existsSync(original)).toBe(true);
    expect(getUpdateRun(second, { env })?.status).toBe("succeeded");
  } finally {
    if (child.connected) {
      child.send("release");
    } else if (child.exitCode === null) {
      child.kill();
    }
    await closed;
  }
});
