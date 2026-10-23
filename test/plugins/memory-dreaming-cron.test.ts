import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import memoryCore from "../../extensions/memory-core/index.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveCronJobEffectiveAgentId } from "../../src/cron/agent-id.js";
import { CronService } from "../../src/cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../src/cron/service.test-harness.js";
import { createTestPluginApi } from "../../src/plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry.js";
import { startPluginServices, type PluginServicesHandle } from "../../src/plugins/services.js";
import { createTestGatewayScheduler } from "../../src/test-utils/gateway-scheduler-clock.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "memory-dreaming-cron-" });
const services = new Set<PluginServicesHandle>();
const schedulers = new Set<CronService>();
let scheduler: ReturnType<typeof createTestGatewayScheduler>;

beforeEach(() => {
  scheduler = createTestGatewayScheduler();
});

afterEach(async () => {
  scheduler.beginClose();
  try {
    await Promise.all([...services].map((service) => service.stop()));
  } finally {
    services.clear();
    for (const cron of schedulers) {
      cron.stop();
    }
    schedulers.clear();
    await scheduler.stop();
    vi.useRealTimers();
  }
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function startDreaming(config: OpenClawConfig, getCronService: () => CronService) {
  const logger = createNoopLogger();
  const registry = createEmptyPluginRegistry();
  const runtime = createPluginRuntimeMock({ config: { current: () => config } });
  memoryCore.register(
    createTestPluginApi({
      id: "memory-core",
      config,
      logger,
      runtime,
      registerService(service) {
        registry.services.push({
          pluginId: "memory-core",
          origin: "bundled",
          source: "memory-core/index.ts",
          id: service.id,
          service,
        });
      },
    }),
  );
  const handle = await startPluginServices({ scheduler, registry, config, getCronService });
  services.add(handle);
  return { handle, logger, runtime };
}

async function createScheduler(cronEnabled: boolean, owner?: string) {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler,
    nowMs: () => Date.now(),
    storePath,
    cronEnabled,
    resolveDefaultAgentId: () => owner,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  schedulers.add(cron);
  return cron;
}

it("does not author ownerless dreaming work when the scheduler overrides enabled config", async () => {
  vi.useFakeTimers();
  const config: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { qa: {}, "qa-extra": {} } },
    cron: { enabled: true },
  };
  const cron = await createScheduler(false);
  const add = vi.spyOn(cron, "add");
  const { logger } = await startDreaming(config, () => cron);

  expect(logger.error).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(logger.error).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  expect(await cron.list({ includeDisabled: true })).toEqual([]);
});

it("creates one owned declaration after scheduling resumes and across service reload", async () => {
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "qa" } },
      entries: { qa: {}, "qa-extra": {} },
    },
  };
  let cron = await createScheduler(false, "qa");
  const { handle, logger } = await startDreaming(config, () => cron);
  expect(await cron.list({ includeDisabled: true })).toEqual([]);

  cron = await createScheduler(true, "qa");
  await handle.reload(config, new Set(["memory-core-dreaming"]));
  const jobs = await cron.list({ includeDisabled: true });
  expect(jobs).toMatchObject([
    {
      declarationKey: "memory-core:memory-dreaming-promotion",
      enabled: true,
      sessionTarget: "isolated",
      payload: { kind: "agentTurn" },
    },
  ]);
  expect(jobs).toHaveLength(1);
  expect(jobs.map((job) => resolveCronJobEffectiveAgentId(job, cron.getDefaultAgentId()))).toEqual([
    "qa",
  ]);

  await handle.reload(config, new Set(["memory-core-dreaming"]));
  expect((await cron.list({ includeDisabled: true })).map((job) => job.id)).toEqual(
    jobs.map((job) => job.id),
  );
  expect(logger.error).not.toHaveBeenCalled();
});

it.each([true, false])(
  "preserves paused jobs unless dreaming itself is disabled (dreaming enabled=%s)",
  async (dreamingEnabled) => {
    const cron = await createScheduler(false);
    const job = {
      agentId: "qa",
      enabled: false,
      schedule: { kind: "cron" as const, expr: "0 2 * * *" },
      sessionTarget: "isolated" as const,
      wakeMode: "now" as const,
      payload: { kind: "agentTurn" as const, message: "maintenance" },
      delivery: { mode: "none" as const },
    };
    const managed = await cron.add({
      ...job,
      name: "Memory dreaming",
      declarationKey: "memory-core:memory-dreaming-promotion",
    });
    const unrelated = await cron.add({ ...job, name: "Unrelated maintenance" });
    const before = await cron.list({ includeDisabled: true });
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { qa: {}, "qa-extra": {} } },
      plugins: {
        entries: { "memory-core": { config: { dreaming: { enabled: dreamingEnabled } } } },
      },
    };
    const { logger } = await startDreaming(config, () => cron);

    expect(await cron.list({ includeDisabled: true })).toEqual(
      dreamingEnabled ? before : before.filter((entry) => entry.id !== managed.id),
    );
    expect(
      (await cron.list({ includeDisabled: true })).some((entry) => entry.id === unrelated.id),
    ).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  },
);

it("keeps explicitly disabled dreaming idle through cold start, reconciliation, and restart", async () => {
  vi.useFakeTimers();
  const workspaceDir = tempDirs.make("memory-dreaming-disabled-");
  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  const diaryDir = path.join(workspaceDir, "memory");
  const diaryPath = path.join(diaryDir, "2026-10-23.md");
  const memory = "# Memory\nThe violet telescope belongs on the library roof.\n";
  const diary = "# Diary\nToday we watched the clouds from the library.\n";
  await fs.mkdir(diaryDir);
  await fs.writeFile(memoryPath, memory);
  await fs.writeFile(diaryPath, diary);
  const workspaceFiles = (await fs.readdir(workspaceDir, { recursive: true })).toSorted();
  const { storePath } = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "qa" } },
      entries: { qa: { workspace: workspaceDir } },
    },
    cron: { enabled: true },
    plugins: {
      slots: { memory: "memory-core" },
      entries: {
        "memory-core": { enabled: true, config: { dreaming: { enabled: false } } },
      },
    },
  };

  // Reuse only persisted state: each cycle recreates Cron and the real plugin services.
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const cron = new CronService({
      scheduler,
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: true,
      resolveDefaultAgentId: () => "qa",
      log: createNoopLogger(),
      enqueueSystemEvent,
      requestHeartbeat,
      runIsolatedAgentJob,
    });
    schedulers.add(cron);
    const list = vi.spyOn(cron, "list");
    const add = vi.spyOn(cron, "add");
    const update = vi.spyOn(cron, "update");
    await cron.start();
    const { handle, logger, runtime } = await startDreaming(config, () => cron);
    const startupLists = list.mock.calls.length;
    expect(startupLists).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list.mock.calls.length).toBeGreaterThan(startupLists);
    expect(await cron.list({ includeDisabled: true })).toEqual([]);
    expect(add).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(runtime.subagent.complete).not.toHaveBeenCalled();
    expect(runtime.subagent.run).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    await handle.stop();
    services.delete(handle);
    cron.stop();
    await cron.waitForIdle();
    schedulers.delete(cron);
    expect(await fs.readFile(memoryPath, "utf8")).toBe(memory);
    expect(await fs.readFile(diaryPath, "utf8")).toBe(diary);
    expect((await fs.readdir(workspaceDir, { recursive: true })).toSorted()).toEqual(workspaceFiles);
  }
});
