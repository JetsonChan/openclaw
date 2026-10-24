import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createUiTestShardGroups,
  resolveUiE2ePrTestSelection,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { resolvePolicyTestTargets } from "../../scripts/lib/ci-policy-test-watch.mts";
import { UI_E2E_SMOKE_TEST_FILES } from "../../scripts/lib/ci-ui-e2e-owner-inventory.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { uiE2eRealGatewayTestFiles } from "../vitest/vitest.ui-paths.mjs";

const temporary = useAutoCleanupTempDirTracker(afterAll);
const cron = "ui/src/e2e/cron-descriptions.e2e.test.ts";
const appearance = "ui/src/e2e/appearance-control-layout.e2e.test.ts";
const unknown = "ui/src/e2e/new-unmapped-flow.e2e.test.ts";
let fixtureCwd: string | undefined;

function fixture() {
  if (fixtureCwd) {
    return fixtureCwd;
  }
  const cwd = temporary.make("ui-e2e-selection-");
  const files: Record<string, string> = {
    [cron]: 'import "../test-helpers/cron-fixture.ts";',
    [appearance]: "export {};",
    [unknown]: "export {};",
    "ui/src/test-helpers/cron-fixture.ts": "export {};",
    "ui/src/pages/cron/route.ts": 'export const route = () => import("../../lib/cron/view.ts");',
    "ui/src/lib/cron/view.ts": 'import "./labels.ts";',
    "ui/src/lib/cron/labels.ts": "export const label = 'Run';",
    "ui/src/pages/appearance/route.ts": "export const route = {};",
    ...Object.fromEntries(UI_E2E_SMOKE_TEST_FILES.map((file) => [file, "export {};\n"])),
  };
  for (const [file, source] of Object.entries(files)) {
    const destination = path.join(cwd, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
  return (fixtureCwd = cwd);
}

describe("Control UI PR owner selection", () => {
  it("does not turn a neighboring unit-test edit into a browser source-owner change", () => {
    expect(resolvePolicyTestTargets(["ui/src/pages/cron/cron-page.test.ts"])).not.toContain(cron);
    expect(resolvePolicyTestTargets(["ui/src/pages/cron/route.ts"])).toContain(cron);
  });
  it("follows a direct dynamic route dependency while deferring transitive composition and unknown tests", () => {
    const cwd = fixture();
    const selected = resolveUiE2ePrTestSelection(["ui/src/lib/cron/view.ts"], { cwd });
    expect(selected.mode).toBe("owners");
    expect(selected.files).toContain(cron);
    expect(selected.files).not.toContain(appearance);
    expect(selected.files).not.toContain(unknown);
    for (const smoke of UI_E2E_SMOKE_TEST_FILES) {
      expect(selected.files).toContain(smoke);
    }
    expect(selected.reasons[cron]).toContain(
      "direct route/component dependency: ui/src/pages/cron/route.ts",
    );
    const transitive = resolveUiE2ePrTestSelection(["ui/src/lib/cron/labels.ts"], { cwd });
    expect(transitive.files.toSorted()).toEqual([...UI_E2E_SMOKE_TEST_FILES].toSorted());
  });

  it.each([
    [unknown, "edited test", unknown],
    ["ui/src/test-helpers/cron-fixture.ts", "test or fixture import dependency", cron],
    ["ui/src/pages/cron/route.ts", "explicit source-owner watch", cron],
  ])(
    "retains edited tests, imported fixtures, and declared route entries: %s",
    (changed, reason, target) => {
      const selected = resolveUiE2ePrTestSelection([changed], { cwd: fixture() });
      expect(selected.files).toContain(target);
      expect(selected.reasons[target]).toContain(reason);
    },
  );

  it.each([
    { changed: null, forceFull: false },
    { changed: [], forceFull: false },
    { changed: ["ui/src/app/bootstrap.ts"], forceFull: false },
    { changed: [cron], forceFull: true },
  ])(
    "selects the full inventory for missing/shared inputs or a forced run: %j",
    ({ changed, forceFull }) => {
      const selected = resolveUiE2ePrTestSelection(changed, { cwd: fixture(), forceFull });
      expect(selected.mode).toBe("full");
      expect(selected.files).toContain(cron);
      expect(selected.files).toContain(appearance);
      expect(selected.files).toContain(unknown);
    },
  );

  it("keeps an unmapped source change on the smoke cohort", () => {
    const selected = resolveUiE2ePrTestSelection(["ui/src/unmapped-runtime.ts"], {
      cwd: fixture(),
    });
    expect(selected.mode).toBe("owners");
    expect(selected.files.toSorted()).toEqual([...UI_E2E_SMOKE_TEST_FILES].toSorted());
  });

  it("retains formerly release-only and real-Gateway files in full periodic groups", () => {
    const selection = resolveUiE2ePrTestSelection(null);
    expect(selection.files).toContain("ui/src/e2e/native-embed-settings.e2e.test.ts");
    expect(selection.files).toContain("ui/src/e2e/board-fixture.e2e.test.ts");
    const groups = createUiTestShardGroups({
      includeReleaseOnlyTests: false,
      includePrExemptRuntimeTests: false,
      includeReleaseOnlyE2eTests: true,
      uiE2eFiles: selection.files,
    });
    expect(groups.e2e.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
      [...new Set([...selection.files, ...uiE2eRealGatewayTestFiles])].toSorted(),
    );
  });
});
