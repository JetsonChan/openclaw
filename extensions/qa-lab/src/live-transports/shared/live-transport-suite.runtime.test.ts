import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runQaSuiteCommand = vi.hoisted(() => vi.fn());
const resolveLiveTransportQaScenarioIds = vi.hoisted(() => vi.fn());
const runFlowWorkers = vi.hoisted(() =>
  vi.fn<typeof import("../../suite-run-standard.js").runQaFlowSuiteStandard>(),
);

vi.mock("../../cli.runtime.js", () => ({ runQaSuiteCommand }));
vi.mock("../../suite-run-standard.js", () => ({ runQaFlowSuiteStandard: runFlowWorkers }));
vi.mock("../../suite-run-isolated.js", () => ({ runQaFlowSuiteIsolated: runFlowWorkers }));
vi.mock("./scenario-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scenario-selection.js")>()),
  resolveLiveTransportQaScenarioIds,
}));

import type { QaSeedScenarioWithSource } from "../../scenario-catalog.js";
import { runQaSuite } from "../../suite-launch.runtime.js";
import { selectQaFlowSuiteScenarios } from "../../suite-planning.js";
import { recordQaSuiteTestResults } from "../../suite-test-helpers.js";
import type { QaSuiteRunParams } from "../../suite.js";
import { createStandardLiveTransportQaCliRegistration } from "./live-transport-cli.js";
import {
  runLiveTransportQaSuiteCommand,
  runStandardLiveTransportQaSuiteCommand,
} from "./live-transport-suite.runtime.js";
const discordQaCliRegistration = createStandardLiveTransportQaCliRegistration({
  channelId: "discord",
  channelLabel: "Fixture",
  agentE2e: true,
  description: "Test external runner",
  createAdapter: vi.fn(),
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function parseQa(channel: "discord", ...args: string[]) {
  const qa = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  const registration = discordQaCliRegistration;
  registration.register(qa);
  return qa.parseAsync(["node", "openclaw", channel, ...args]);
}

async function writeAgentE2eRecipe(
  directory: string,
  id: string,
  execution: Record<string, unknown> = {},
  includeFlow = true,
) {
  const file = path.join(directory, `${id}.yaml`);
  await fs.writeFile(
    file,
    JSON.stringify({
      title: `External ${id}`,
      scenario: {
        id,
        surface: "channels",
        objective: "Exercise only this selected native flow.",
        successCriteria: ["The selected flow completes."],
        execution: {
          kind: "flow",
          channel: "discord",
          timeoutMs: 23456,
          config: { agentE2e: true, marker: "external-recipe" },
          ...execution,
        },
      },
      ...(includeFlow
        ? {
            flow: {
              steps: [{ name: "native readiness", actions: [{ call: "channelE2e.doctor" }] }],
            },
          }
        : {}),
    }),
  );
  return file;
}

describe("live transport suite runtime", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_SOURCE", "");
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_ROLE", "");
    vi.stubEnv("OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT", "1");
    vi.clearAllMocks();
    runQaSuiteCommand.mockReset();
    resolveLiveTransportQaScenarioIds.mockReset();
    runFlowWorkers.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes one live command into the shared suite host", async () => {
    const options = {
      repoRoot: "/repo",
      outputDir: ".artifacts/slack",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5-alt",
      fastMode: true,
      allowFailures: true,
      failFast: true,
      credentialFile: "/secure/slack-qa.json",
      credentialSource: " convex ",
      credentialRole: " ci ",
      sutAccountId: "slack-sut",
    };
    await runLiveTransportQaSuiteCommand({
      channelId: "slack",
      defaultProviderMode: "live-frontier",
      options: { ...options },
      selectScenarioIds: ({ primaryModel, providerMode, scenarioIds }) => {
        expect(primaryModel).toBe("openai/gpt-5.5");
        expect(providerMode).toBe("live-frontier");
        expect(scenarioIds).toBeUndefined();
        return ["slack-canary"];
      },
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith({
      ...options,
      providerMode: "live-frontier",
      channelDriver: "live",
      channel: "slack",
      scenarioIds: ["slack-canary"],
      credentialSource: "convex",
      credentialRole: "ci",
      explicitScenarioSelection: false,
    });
  });

  it("propagates selection context through the standard suite owner", async () => {
    const channelId = "discord";
    const scenarioId = "discord-canary";
    resolveLiveTransportQaScenarioIds.mockReturnValueOnce([scenarioId]);

    await runStandardLiveTransportQaSuiteCommand({
      channelId,
      options: {
        primaryModel: "openai/custom-selection-model",
        profile: "all",
        providerMode: "mock-openai",
        scenarioIds: [scenarioId, scenarioId],
      },
    });

    expect(resolveLiveTransportQaScenarioIds).toHaveBeenLastCalledWith({
      channelId,
      primaryModel: "openai/custom-selection-model",
      profile: "all",
      providerMode: "mock-openai",
      scenarioIds: [scenarioId, scenarioId],
      supportsModuleFlows: true,
    });
    expect(runQaSuiteCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: channelId,
        primaryModel: "openai/custom-selection-model",
        providerMode: "mock-openai",
        scenarioIds: [scenarioId],
        explicitScenarioSelection: true,
      }),
    );
  });

  it("normalizes the shared credential source environment override", async () => {
    vi.stubEnv("OPENCLAW_QA_CREDENTIAL_SOURCE", " convex ");

    await runLiveTransportQaSuiteCommand({
      channelId: "buzz",
      defaultProviderMode: "mock-openai",
      options: {},
      selectScenarioIds: () => ["channel-canary"],
    });

    expect(runQaSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({ credentialSource: "convex" }),
    );
  });

  it("rejects shared credentials for disposable transports", async () => {
    await expect(
      runLiveTransportQaSuiteCommand({
        channelId: "matrix",
        credentialMode: "env-only",
        defaultProviderMode: "live-frontier",
        envCredentialReason: "its homeserver is disposable and local.",
        laneLabel: "Matrix",
        options: { credentialSource: "convex" },
        selectScenarioIds: () => ["channel-chat-baseline"],
      }),
    ).rejects.toThrow(
      "QA Lab Matrix supports only --credential-source env because its homeserver is disposable and local.",
    );
    await expect(
      runLiveTransportQaSuiteCommand({
        channelId: "matrix",
        credentialMode: "env-only",
        defaultProviderMode: "live-frontier",
        laneLabel: "Matrix",
        options: { credentialRole: "ci" },
        selectScenarioIds: () => ["channel-chat-baseline"],
      }),
    ).rejects.toThrow("QA Lab Matrix does not use credential roles.");
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("lists only the repeated file selections without dispatching or injecting the curated suite", async () => {
    const directory = tempDirs.make("agent-e2e-selection-");
    const first = await writeAgentE2eRecipe(directory, "first-external");
    const second = await writeAgentE2eRecipe(directory, "second-external");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await parseQa(
        "discord",
        "--scenario-file",
        first,
        "--scenario-file",
        second,
        "--list-scenarios",
      );
      expect(output.mock.calls.map(([text]) => text).join("")).toBe(
        "first-external\nsecond-external\n",
      );
      expect(runQaSuiteCommand).not.toHaveBeenCalled();
      expect(resolveLiveTransportQaScenarioIds).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });

  it("runs the external definition rather than a catalog flow with the same id", async () => {
    const directory = tempDirs.make("agent-e2e-external-flow-");
    const file = await writeAgentE2eRecipe(directory, "channel-chat-baseline");
    let selected: QaSeedScenarioWithSource[] = [];
    const boundary = new Error("reached selected workers without acquiring credentials");
    runFlowWorkers.mockImplementation((_params, context) => {
      selected = context.selectedScenarios;
      throw boundary;
    });
    runQaSuiteCommand.mockImplementation((options) =>
      runQaSuite({
        repoRoot: directory,
        outputDir: path.join(directory, "proof"),
        providerMode: options.providerMode,
        channelDriver: "live",
        channelId: "discord",
        scenarioIds: options.scenarioIds,
        scenarioDefinitions: options.scenarioDefinitions,
        adapterFactories: [discordQaCliRegistration.adapterFactory!],
      }),
    );
    await expect(parseQa("discord", "--scenario-file", file)).rejects.toBe(boundary);
    expect(selected).toMatchObject([
      {
        id: "channel-chat-baseline",
        title: "External channel-chat-baseline",
        sourcePath: file,
        execution: {
          timeoutMs: 23456,
          retryCount: 0,
          config: { agentE2e: true, marker: "external-recipe" },
          flow: { steps: [{ name: "native readiness", actions: [{ call: "channelE2e.doctor" }] }] },
        },
      },
    ]);
    const ordinary = {
      ...selected[0]!,
      id: "ordinary",
      execution: { ...selected[0]!.execution, config: {} },
    };
    expect(
      selectQaFlowSuiteScenarios({
        scenarios: [...selected, ordinary],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/fixture",
        channelDriver: "live",
        channel: "discord",
      }).map((scenario) => scenario.id),
    ).toEqual(["ordinary"]);
  });

  it.each([
    {
      name: "wrong channel",
      execution: { channel: "slack" },
      expected: /must declare channel discord/u,
    },
    { name: "missing flow", includeFlow: false, expected: /top-level flow block/u },
    { name: "missing file", missing: true, expected: /ENOENT/u },
    { name: "missing opt-in", execution: { config: {} }, expected: /execution.config.agentE2e/u },
    { name: "retrying writes", execution: { retryCount: 1 }, expected: /retryCount: 0/u },
    {
      name: "provider mismatch",
      execution: { config: { agentE2e: true, requiredProviderMode: "live-frontier" } },
      expected: /providerMode=live-frontier/u,
    },
  ])("rejects $name before credential-bearing suite dispatch", async (fixture) => {
    const directory = tempDirs.make("agent-e2e-invalid-");
    const file = fixture.missing
      ? path.join(directory, "missing.yaml")
      : await writeAgentE2eRecipe(directory, "invalid", fixture.execution, fixture.includeFlow);
    await expect(parseQa("discord", "--scenario-file", file)).rejects.toThrow(fixture.expected);
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it.each([
    { args: ["--scenario-file", " "], expected: /non-empty YAML file path/u },
    { args: ["--doctor", "--scenario-file", "unused.yaml"], expected: /cannot be combined/u },
    {
      args: ["--scenario-file", "unused.yaml", "--scenario", "discord-canary"],
      expected: /cannot be combined/u,
    },
    {
      args: ["--doctor", "--channel-driver", "crabline"],
      expected: /unknown option '--channel-driver'/u,
    },
  ])("rejects conflicting or empty explicit selection: $args", async ({ args, expected }) => {
    await expect(parseQa("discord", ...args)).rejects.toThrow(expected);
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects colliding file scenario ids instead of silently replacing a flow", async () => {
    const firstDir = tempDirs.make("agent-e2e-first-");
    const secondDir = tempDirs.make("agent-e2e-second-");
    const first = await writeAgentE2eRecipe(firstDir, "collision");
    const second = await writeAgentE2eRecipe(secondDir, "collision", { timeoutMs: 9999 });
    await expect(
      parseQa("discord", "--scenario-file", first, "--scenario-file", second),
    ).rejects.toThrow(/duplicate QA scenario id/u);
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });

  it("rejects unknown provider modes before suite dispatch", async () => {
    await expect(
      runLiveTransportQaSuiteCommand({
        channelId: "discord",
        defaultProviderMode: "live-frontier",
        options: { providerMode: "unknown" },
        selectScenarioIds: () => ["discord-canary"],
      }),
    ).rejects.toThrow("unknown QA provider mode: unknown");
    expect(runQaSuiteCommand).not.toHaveBeenCalled();
  });
});
