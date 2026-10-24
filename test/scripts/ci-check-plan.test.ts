import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCiCheckPlan, type CiCheckPlanInput } from "../../scripts/ci-check-plan.mts";
import { resolveCiExtensionLintSelection } from "../../scripts/lib/ci-extension-lint-plan.mts";
import {
  createExtensionOxlintShards,
  selectExtensionOxlintStripe,
} from "../../scripts/run-oxlint-shards.mts";
import { createChangedCiTypeCheckPlan } from "../../scripts/run-tsgo-core-test-shards.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const typeSelection = vi.hoisted(() => ({
  graphs: null as { name: string; config: string }[] | null,
}));

vi.mock("../../scripts/run-tsgo-core-test-shards.mts", () => ({
  createChangedCiTypeCheckPlan: vi.fn(async () => ({
    mode: "targeted",
    graphs: typeSelection.graphs ?? [
      {
        name: "core-test-agents-root",
        config: "test/tsconfig/tsconfig.core.test.agents-root.json",
      },
      { name: "scripts", config: "tsconfig.scripts.json" },
    ],
  })),
}));
vi.mock("../../scripts/lib/ci-extension-lint-plan.mts", () => ({
  resolveCiExtensionLintSelection: vi.fn(),
}));

function createPlan(overrides: Partial<CiCheckPlanInput>) {
  return createCiCheckPlan({
    typeGraphBoundaryOwner: "check-plan",
    changedPaths: ["src/shared.ts"],
    changedCoreTestPaths: null,
    runnerProfile: "hybrid",
    checkMatrix: {
      include: [{ check_name: "check-test-types", task: "test-types", runner: "unused" }],
    },
    coreTypeMatrix: { include: [1, 2, 3, 4, 5].map((stripe) => ({ stripe })) },
    lintCoreMatrix: { include: [] },
    lintExtensionMatrix: { include: [] },
    ...overrides,
  });
}

describe("CI check-plan selection", () => {
  it.each(["hybrid", "github", "blacksmith"])(
    "selects complete extension roots without narrowing full check owners (%s)",
    async (runnerProfile) => {
      for (const mode of ["affected", "none", "full"] as const) {
        const roots = mode === "affected" ? ["extensions/imessage"] : [];
        vi.mocked(resolveCiExtensionLintSelection).mockResolvedValue({
          mode: mode === "full" ? "full" : "selected",
          extensionRoots: roots,
          reasons: Object.fromEntries(roots.map((root) => [root, ["changed owner"]])),
          fullReasons: mode === "full" ? ["OPENCLAW_CI_EXTENSION_LINT_FULL"] : [],
        });
        vi.mocked(createChangedCiTypeCheckPlan).mockClear();
        const checkMatrix = {
          include: ["lint", "prod-types", "test-types", "guards"].map((task) => ({
            check_name: `check-${task}`,
            task,
            runner: "unused",
          })),
        };
        const coreStripes = runnerProfile === "hybrid" ? [1, 2] : [1, 2, 3, 4, 5];
        const coreTypeMatrix = { include: [1, 2, 3, 4, 5].map((stripe) => ({ stripe })) };
        const plan = await createPlan({
          changedBaseRef: "a".repeat(40),
          extensionLintMode: mode === "full" ? "full" : "affected",
          preserveFullChecks: true,
          typeGraphBoundaryOwner: "additional-checks",
          changedPaths: ["package.json"],
          runnerProfile,
          checkMatrix,
          coreTypeMatrix,
          lintCoreMatrix: { include: coreStripes.map((stripe) => ({ stripe })) },
          lintExtensionMatrix: { include: [1, 2, 3, 4, 5, 6].map((stripe) => ({ stripe })) },
        });
        expect(plan.check_matrix).toEqual(checkMatrix);
        expect(resolveCiExtensionLintSelection).toHaveBeenLastCalledWith(
          ["package.json"],
          process.cwd(),
          { forceFull: mode === "full", baseRef: "a".repeat(40) },
        );
        expect(plan.core_type_matrix.include).toEqual(
          runnerProfile === "blacksmith" ? [] : coreTypeMatrix.include,
        );
        expect(createChangedCiTypeCheckPlan).not.toHaveBeenCalled();
        const encoded = [
          plan.central_lint_selection_json,
          ...plan.lint_core_matrix.include.map((row) => row.lint_selection_json),
          ...plan.lint_extension_matrix.include.map((row) => row.lint_selection_json),
        ];
        const payloads = encoded
          .filter((value): value is string => Boolean(value))
          .map((value) => JSON.parse(value));
        const central = JSON.parse(plan.central_lint_selection_json);
        expect(central.fullGroups).toEqual(
          runnerProfile === "blacksmith" ? ["core", "scripts"] : ["scripts"],
        );
        if (runnerProfile === "hybrid") {
          expect(plan.lint_core_matrix.include).toEqual([{ stripe: 1 }, { stripe: 2 }]);
          expect(plan.run_lint_extensions).toBe(mode !== "none");
        } else if (runnerProfile === "github") {
          expect(payloads.flatMap((payload) => payload.fullCoreStripes ?? [])).toEqual([
            1, 2, 3, 4, 5,
          ]);
        }
        const extensionPayloads = payloads.filter(
          (payload) => payload.extensionRoots || payload.fullExtensionStripes,
        );
        if (mode === "none") {
          expect(extensionPayloads).toEqual([]);
          expect(plan.lint_extension_matrix.include).toEqual([]);
        } else {
          expect(extensionPayloads.length).toBeGreaterThan(0);
          for (const payload of extensionPayloads) {
            expect(payload.extensionStripeCount).toBe(
              runnerProfile === "hybrid" ? 3 : runnerProfile === "github" ? 6 : 1,
            );
            if (mode === "affected") {
              expect(payload.extensionRoots).toEqual(roots);
              expect(payload.extensionStripes.length).toBeGreaterThan(0);
              expect(payload.fullExtensionStripes).toBeUndefined();
            } else {
              expect(payload.extensionRoots).toBeUndefined();
              expect(payload.fullExtensionStripes.length).toBeGreaterThan(0);
            }
          }
        }
      }
    },
  );
  it.each(["check-plan", "additional-checks"] as const)(
    "passes only an admitted parallel boundary owner without adding compiler rows (%s)",
    async (typeGraphBoundaryOwner) => {
      typeSelection.graphs = [
        { name: "extensions", config: "tsconfig.extensions.json" },
        { name: "extensions-test", config: "test/tsconfig/tsconfig.extensions.test.json" },
        { name: "test-root", config: "test/tsconfig/tsconfig.test.root.json" },
      ];
      vi.mocked(createChangedCiTypeCheckPlan).mockClear();
      try {
        const paths = ["extensions/example/value.ts"];
        const plan = await createPlan({
          typeGraphBoundaryOwner,
          changedPaths: paths,
          checkMatrix: {
            include: [
              { check_name: "check-prod-types", task: "prod-types", runner: "unused" },
              { check_name: "check-test-types", task: "test-types", runner: "unused" },
            ],
          },
        });
        expect(createChangedCiTypeCheckPlan).toHaveBeenCalledExactlyOnceWith(paths, {
          cwd: process.cwd(),
          coreBoundaryOwner:
            typeGraphBoundaryOwner === "additional-checks" ? "additional-checks" : undefined,
        });
        expect(plan.core_type_matrix.include).toEqual([]);
        expect(
          plan.check_matrix.include.map((row) => JSON.parse(row.type_graph_names_json!)),
        ).toEqual([["extensions"], ["extensions-test", "test-root"]]);
      } finally {
        typeSelection.graphs = null;
      }
    },
  );

  it.each([
    ["hybrid", [1, 2, 4, 5]],
    ["hybrid", [1, 2, 5]],
    ["blacksmith", [1, 2, 3, 4, 5]],
  ] as const)(
    "assigns root partitions without adding %s rows (%j)",
    async (runnerProfile, stripes) => {
      const core = [
        "agents-root",
        "agents-other",
        "agents-tools",
        "gateway-root",
        "gateway-server",
      ];
      typeSelection.graphs = [
        ...stripes.map((stripe) => ({
          name: `core-test-${core[stripe - 1]}`,
          config: `test/tsconfig/tsconfig.core.test.${core[stripe - 1]}.json`,
        })),
        { name: "scripts", config: "tsconfig.scripts.json" },
        { name: "test-root", config: "test/tsconfig/tsconfig.test.root.json" },
      ];
      try {
        const plan = await createPlan({ runnerProfile });
        const hosted = runnerProfile !== "blacksmith";
        const moved = hosted && stripes.length >= 4;
        expect(plan.core_type_matrix.include.map((row) => row.stripe)).toEqual(
          hosted ? stripes : [],
        );
        expect(plan.core_type_matrix.include.flatMap((row) => row.root_type_stripe ?? [])).toEqual(
          moved ? ["1/4", "2/4", "3/4", "4/4"] : [],
        );
        expect(JSON.parse(plan.check_matrix.include[0]!.type_graph_names_json!)).toEqual(
          moved ? ["scripts"] : hosted ? ["scripts", "test-root"] : ["test-root", "scripts"],
        );
      } finally {
        typeSelection.graphs = null;
      }
    },
  );

  it.each(["hybrid", "github", "blacksmith"])(
    "preserves complete fallback chunks while reducing only hybrid rows (%s)",
    async (runnerProfile) => {
      const cwd = tempDirs.make("ci-full-extension-lint-");
      for (let index = 0; index < 49; index++) {
        mkdirSync(join(cwd, "extensions", `plugin-${String(index).padStart(2, "0")}`), {
          recursive: true,
        });
      }
      writeFileSync(join(cwd, "extensions/root.ts"), "export {};\n");
      const shards = createExtensionOxlintShards({ cwd, platform: "linux", chunkSize: 8 });
      const plan = await createPlan({
        typeGraphBoundaryOwner: "",
        changedPaths: ["package.json"],
        runnerProfile,
        checkMatrix: { include: [{ check_name: "check-lint", task: "lint", runner: "unused" }] },
        coreTypeMatrix: { include: [] },
        lintExtensionMatrix: { include: [1, 2, 3, 4, 5, 6].map((stripe) => ({ stripe })) },
      });
      const rows = plan.lint_extension_matrix.include;
      expect(rows).toHaveLength(runnerProfile === "hybrid" ? 3 : 6);
      const selected = rows.flatMap((row) =>
        selectExtensionOxlintStripe(shards, {
          index: row.stripe,
          total: row.stripe_count ?? 6,
        }),
      );
      expect(selected.map(({ name, args }) => JSON.stringify({ name, args })).toSorted()).toEqual(
        shards.map(({ name, args }) => JSON.stringify({ name, args })).toSorted(),
      );
      expect(plan.central_lint_selection_json).toBe("");
    },
  );
});
