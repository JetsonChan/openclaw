import { readFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { minimatch } from "minimatch";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectChangedScope,
  detectNodeFastScope,
  shouldRunNativeI18n,
  writeGitHubOutput,
} from "../../scripts/ci-changed-scope.mjs";
import { resolveShardPlans } from "../../scripts/ci-run-node-test-shard.mts";
import {
  decodeNodeTestGroups,
  encodeNodeTestGroups,
} from "../../scripts/lib/ci-node-test-groups-codec.mts";
import { createNodeTestShardBundles } from "../../scripts/lib/ci-node-test-plan.mts";
import { buildVitestRunPlans } from "../../scripts/test-projects.test-support.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runCiChangedScopeFixture(
  changedPaths: string[],
  workflowEventName = "",
): Record<string, string> {
  const outputPath = path.join(tempDirs.make("openclaw-ci-scope-"), "scope.out");
  writeGitHubOutput(
    detectChangedScope(changedPaths),
    outputPath,
    undefined,
    detectNodeFastScope(changedPaths),
    shouldRunNativeI18n(changedPaths),
    changedPaths,
    workflowEventName,
  );
  return Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe("changed-path transport", () => {
  it("writes complete changed paths above the Actions output size limit", () => {
    const changedPaths = [
      ...Array.from(
        { length: 1_000 },
        (_, index) => `docs/generated/${index}-${"x".repeat(100)}.md`,
      ),
      "src/focused.ts",
    ];
    const outputs = runCiChangedScopeFixture(changedPaths);
    expect(Buffer.byteLength(JSON.stringify(changedPaths))).toBeGreaterThan(64 * 1024);
    expect(outputs.changed_paths_json).toBe("null");
    expect(
      JSON.parse(readFileSync(expectDefined(outputs.changed_paths_file, "manifest file"), "utf8")),
    ).toEqual(changedPaths);
  });
});

describe("Node test planning", () => {
  it("assigns the regular startup corpus to one Node owner", () => {
    const files = ["src/config/config-startup-corpus.test.ts"];
    const groups = createNodeTestShardBundles({
      compactMode: "push",
      includeReleaseOnlyPluginShards: false,
      includeReleaseOnlyRuntimeTests: false,
    }).flatMap((shard) => shard.groups);
    for (const file of files) {
      expect(
        buildVitestRunPlans([file]).map((plan) => plan.config),
        file,
      ).toEqual(["test/vitest/vitest.runtime-config.config.ts"]);
      const nodeOwners = groups.filter(
        (group) =>
          group.configs.includes("test/vitest/vitest.runtime-config.config.ts") &&
          (!group.includePatterns ||
            group.includePatterns.some((pattern) => minimatch(file, pattern))),
      );
      expect(nodeOwners, file).toHaveLength(1);
    }
  });

  it.each(["grouped", "single-env", "single-no-env"] as const)(
    "packs Node shard groups and unpacks them in the shard runner (%s)",
    (mode) => {
      const grouped = mode === "grouped";
      const groups = [
        {
          configs: ["test/vitest/vitest.unit-fast.config.ts"],
          env: undefined,
          fallbackMaxWorkers: 2,
          minTotalMemoryBytes: 28 * 1024 ** 3,
          includePatterns: ["src/a.test.ts", "src/b.test.ts"],
          requiresDist: false,
          runner: "ubuntu-24.04",
          shard_name: "core-unit-fast-1",
          timing_key: "core-unit-fast-1#include-2-abcd",
        },
        {
          configs: ["test/vitest/vitest.infra.config.ts"],
          env: { OPENCLAW_VITEST_MAX_WORKERS: "2" },
          requiresDist: false,
          runner: "ubuntu-24.04",
          shard_name: "core-runtime-infra-misc",
        },
      ];
      const firstGroup = expectDefined(groups[0], "first compact group");
      const singleGroup = {
        configs: firstGroup.configs,
        env:
          mode === "single-no-env"
            ? undefined
            : {
                OPENCLAW_VITEST_MAX_WORKERS: "2",
                OPENCLAW_NODE_TEST_VITEST_ARGS_JSON: '["--shard=1/2"]',
              },
        includePatterns: firstGroup.includePatterns,
        shard_name: "core-unit-fast-1",
      };
      const projectedGroups = grouped
        ? groups.map(
            ({
              configs,
              env,
              fallbackMaxWorkers,
              includePatterns,
              minTotalMemoryBytes,
              shard_name,
              timing_key,
            }) => ({
              configs,
              env,
              fallbackMaxWorkers,
              includePatterns,
              minTotalMemoryBytes,
              shard_name,
              timing_key,
            }),
          )
        : [singleGroup];
      const packedEnv = encodeNodeTestGroups(projectedGroups);
      expect(decodeNodeTestGroups(packedEnv)).toEqual(projectedGroups);
      // Raw fallback uses null for absent overrides; packed groups omit them.
      const normalizeDefaults = (plans: ReturnType<typeof resolveShardPlans>) =>
        plans.map((entry) =>
          entry.kind === "group"
            ? {
                ...entry,
                plan: {
                  ...entry.plan,
                  env: entry.plan.env ?? null,
                  includePatterns: entry.plan.includePatterns ?? null,
                },
              }
            : entry,
        );
      expect(
        normalizeDefaults(
          resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: String(packedEnv) }),
        ),
      ).toEqual(
        normalizeDefaults(
          resolveShardPlans(
            grouped
              ? {
                  OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(projectedGroups),
                }
              : {
                  OPENCLAW_NODE_TEST_CONFIGS_JSON: JSON.stringify(singleGroup.configs),
                  OPENCLAW_NODE_TEST_ENV_JSON: JSON.stringify(singleGroup.env),
                  OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON: JSON.stringify(
                    singleGroup.includePatterns,
                  ),
                  OPENCLAW_VITEST_SHARD_NAME: singleGroup.shard_name,
                },
          ),
        ),
      );
    },
  );

  it.each([undefined, "changed-manual-inventory", "release-full-manual-inventory"])(
    "packs large Node inventories without losing timing identity %s",
    (timingKey) => {
      const configs = ["test/vitest/vitest.unit-fast.config.ts"];
      const env = { OPENCLAW_VITEST_MAX_WORKERS: "2" };
      const includePatterns = Array.from(
        { length: 6_000 },
        (_, index) =>
          `src/infra/manual-inventory/owner-${index}/workflow-contract-process-boundaries.test.ts`,
      );
      const encoded = encodeNodeTestGroups([
        {
          configs,
          env,
          includePatterns,
          shard_name: "manual-inventory",
          ...(timingKey ? { timing_key: timingKey } : {}),
        },
      ]);
      expect(
        resolveShardPlans({ OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: encoded }),
      ).toEqual([
        {
          kind: "group",
          name: "manual-inventory",
          timingKey: timingKey ?? "manual-inventory",
          plan: {
            configs,
            env,
            includePatterns,
            shard_name: "manual-inventory",
            ...(timingKey ? { timing_key: timingKey } : {}),
          },
        },
      ]);
    },
  );
});
