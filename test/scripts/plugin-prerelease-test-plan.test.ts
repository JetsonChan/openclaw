// Plugin Prerelease Test Plan tests cover plugin prerelease test plan script behavior.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findLaneByName } from "../../scripts/lib/docker-e2e-plan.mts";
import { BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS } from "../../scripts/lib/docker-e2e-scenarios.mts";
import {
  assertPluginPrereleaseTestPlanComplete,
  createPluginPrereleaseTestPlan,
  resolvePluginPrereleaseExtensionRuntime,
} from "../../scripts/lib/plugin-prerelease-test-plan.mts";

function getDockerLane(name: string) {
  const lane = findLaneByName(name);
  if (!lane) {
    throw new Error(`Missing Docker E2E lane ${name}`);
  }
  return lane;
}

describe("scripts/lib/plugin-prerelease-test-plan.mts", () => {
  it.each([
    {
      name: "ordinary plugin validation",
      fullReleaseValidation: false,
      memory: true,
      vitestArgs: [],
      requiresBun: false,
    },
    {
      name: "full release memory and database-worker groups",
      fullReleaseValidation: true,
      memory: true,
      vitestArgs: [],
      requiresBun: true,
    },

    {
      name: "full release with an explicit report",
      fullReleaseValidation: true,
      memory: true,
      vitestArgs: ["--reporter=json", "--outputFile=report.json"],
      requiresBun: false,
    },
  ])(
    "selects runtime setup for $name",
    async ({ fullReleaseValidation, memory, vitestArgs, requiresBun }) => {
      const planGroups = [
        {
          config: "test/vitest/vitest.extension-database-workers.config.ts",
          roots: ["extensions/memory-lancedb/index.test.ts"],
        },
        ...(memory
          ? [
              {
                config: "test/vitest/vitest.extension-memory.config.ts",
                roots: ["extensions/memory-lancedb"],
              },
            ]
          : []),
      ];

      expect(
        await resolvePluginPrereleaseExtensionRuntime({
          planGroups,
          fullReleaseValidation,
          vitestArgs,
        }),
      ).toEqual({ test_runtime_policy: requiresBun ? "dual" : "node", requires_bun: requiresBun });
    },
  );

  it("runs the package and Docker product lanes through the existing scheduler", () => {
    const plan = assertPluginPrereleaseTestPlanComplete();

    expect(plan.dockerLanes).toEqual([
      "npm-onboard-channel-agent",
      "npm-onboard-discord-candidate-channel-agent",
      "npm-onboard-slack-candidate-channel-agent",
      "doctor-switch",
      "update-channel-switch",
      "plugins-offline",
      "plugins",
      "kitchen-sink-plugin",
      "kitchen-sink-rpc",
      "plugin-update",
      "config-reload",
      "gateway-network",
      "mcp-channels",
      "cron-mcp-cleanup",
      ...Array.from(
        { length: BUNDLED_PLUGIN_INSTALL_UNINSTALL_SHARDS },
        (_, index) => `bundled-plugin-install-uninstall-${index}`,
      ),
    ]);

    for (const lane of plan.dockerLanes) {
      expect(getDockerLane(lane).name).toBe(lane);
    }
    const candidateLane = getDockerLane("npm-onboard-discord-candidate-channel-agent");
    expect(candidateLane.command).toContain("OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR");
    expect(candidateLane.command).toContain(
      'OPENCLAW_LIVE_DOCKER_REPO_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}"',
    );
  });

  it("uses kitchen-sink npm and ClawHub scenarios as the registry install canary", () => {
    const lane = getDockerLane("kitchen-sink-plugin");
    const script = readFileSync("scripts/e2e/kitchen-sink-plugin-docker.sh", "utf8");
    const sweepScript = readFileSync("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh", "utf8");
    const assertionsScript = readFileSync(
      "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs",
      "utf8",
    );

    expect(lane).toEqual({
      command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:kitchen-sink-plugin",
      e2eImageKind: "functional",
      live: false,
      name: "kitchen-sink-plugin",
      resources: ["npm"],
      stateScenario: "empty",
      weight: 3,
    });
    expect(script).toContain("npm:@openclaw/kitchen-sink@latest");
    expect(script).toContain("npm-latest-conformance");
    expect(script).toContain("npm-latest-adversarial");
    expect(script).toContain("npm:@openclaw/kitchen-sink@beta");
    expect(script).toContain("clawhub:@openclaw/kitchen-sink@latest");
    expect(script).toContain("clawhub:@openclaw/kitchen-sink@beta");
    expect(script).toContain("OPENCLAW_KITCHEN_SINK_PLUGIN_MAX_MEMORY_MIB");
    expect(script).toContain(
      "npm-to-clawhub|clawhub:@openclaw/kitchen-sink@latest|openclaw-kitchen-sink-fixture|clawhub|success|basic||${KITCHEN_SINK_NPM_SPEC}",
    );
    expect(script).toContain("scripts/e2e/lib/kitchen-sink-plugin/sweep.sh");
    expect(sweepScript).toContain('plugins install "$KITCHEN_SINK_SPEC" --force');
    expect(sweepScript).toContain('plugins install "$KITCHEN_SINK_PREINSTALL_SPEC" --force');
    expect(sweepScript).toContain("assert-cutover-preinstalled");
    expect(sweepScript).toContain('install_args+=("--force")');
    expect(sweepScript).toContain("KITCHEN_SINK_PERSONALITY");
    expect(sweepScript).toContain("OPENCLAW_KITCHEN_SINK_PERSONALITY");
    expect(sweepScript).toContain('plugins uninstall "$KITCHEN_SINK_SPEC" --force');
    const successScenario = sweepScript.slice(
      sweepScript.indexOf("run_success_scenario()"),
      sweepScript.indexOf("run_failure_scenario()"),
    );
    const installIndex = successScenario.indexOf('plugins install "${install_args[@]}" --force');
    const configureIndex = successScenario.indexOf("assertions.mjs configure-runtime");
    const enableIndex = successScenario.indexOf('plugins enable "$KITCHEN_SINK_ID"');
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(configureIndex).toBeGreaterThan(installIndex);
    expect(enableIndex).toBeGreaterThan(configureIndex);
    expect(successScenario).toContain('plugins inspect "$KITCHEN_SINK_ID" --runtime --json');
    expect(successScenario).toContain("plugins inspect --all --runtime --json");
    expect(sweepScript).toContain("run_failure_scenario");
    expect(assertionsScript).toContain("assertCutoverPreinstalled");
    expect(assertionsScript).toContain("record.source !== source");
    expect(assertionsScript).toContain("record.clawhubPackage !== packageName");
    expect(assertionsScript).toContain("record.artifactKind");
    expect(assertionsScript).toContain("assertClawHubExternalInstallContract");
    expect(assertionsScript).toContain("expectedErrorMessages");
    expect(assertionsScript).toContain(
      'const INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES = new Set(["full", "adversarial"]);',
    );
    expect(assertionsScript).toContain("!INVALID_PROBE_DIAGNOSTIC_SURFACE_MODES.has(surfaceMode)");
    expect(readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8")).toContain(
      'from "openclaw/plugin-sdk/plugin-entry"',
    );
    expect(readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8")).toContain(
      "X-ClawHub-Artifact-Sha256",
    );
    expect(script).toContain("docker_e2e_sample_stats_until_exit");
    expect(script).toContain("scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs");
    expect(sweepScript).toContain("assertions.mjs scan-logs");
  });

  it("keeps the generic plugin Docker lane as an external install contract canary", () => {
    const lane = getDockerLane("plugins");
    const sweepScript = readFileSync("scripts/e2e/lib/plugins/sweep.sh", "utf8");
    const clawhubScript = readFileSync("scripts/e2e/lib/plugins/clawhub.sh", "utf8");
    const assertionsScript = readFileSync("scripts/e2e/lib/plugins/assertions.mjs", "utf8");
    const fixtureServer = readFileSync("scripts/e2e/lib/clawhub-fixture-server.cjs", "utf8");
    const prereleasePlan = createPluginPrereleaseTestPlan();

    expect(lane).toEqual({
      command: "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins",
      e2eImageKind: "functional",
      live: false,
      name: "plugins",
      resources: ["npm", "service"],
      stateScenario: "empty",
      weight: 6,
    });
    expect(prereleasePlan.surfaces).toContain("external-install-boundary");
    expect(sweepScript).toContain("run_plugins_clawhub_scenario");
    expect(clawhubScript).toContain('plugins install "$CLAWHUB_PLUGIN_SPEC"');
    expect(assertionsScript).toContain("assertClawHubExternalInstallContract");
    expect(fixtureServer).toContain('"is-number": "7.0.0"');
    expect(fixtureServer).toContain('openclaw: ">=2026.4.11"');
    expect(fixtureServer).toContain(
      "const versionPath = `${packagePath}/versions/${fixture.version}`;",
    );
    expect(fixtureServer).toContain("[`${versionPath}/artifact`, artifactResolverDetail]");
  });

  it("keeps the live-ish availability check redacted", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/plugin-prerelease-liveish-matrix.mts"],
      {
        encoding: "utf8",
        env: {
          DISCORD_TOKEN: "discord-token-should-not-print",
          OPENAI_API_KEY: "openai-token-should-not-print",
        },
      },
    );

    expect(output).toContain("provider-openai: present (OPENAI_API_KEY, OPENAI_BASE_URL)");
    expect(output).toContain("channel-discord: present (DISCORD_TOKEN, OPENCLAW_DISCORD_TOKEN)");
    expect(output).not.toContain("openai-token-should-not-print");
    expect(output).not.toContain("discord-token-should-not-print");
  });
});
