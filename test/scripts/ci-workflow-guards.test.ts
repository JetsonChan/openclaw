import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { minimatch } from "minimatch";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { isAlias, parse, parseDocument, visit } from "yaml";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { createTempDirTracker, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { assertControlUiE2eOwnership } from "./ci-ui-e2e-ownership.test-support.js";
import {
  CACHE_V5,
  DOWNLOAD_ARTIFACT_V8,
  quoteShell,
  SETUP_GO_V6,
  UPLOAD_ARTIFACT_V7,
  readWorkflowOutputs,
  runGit,
  runWorkflowShellScript,
  testNodeExecPath,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

const OPENGREP_PR_DIFF_WORKFLOW = ".github/workflows/opengrep-precise.yml";
const OPENGREP_FULL_WORKFLOW = ".github/workflows/opengrep-precise-full.yml";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const rootPackageManager = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    packageManager: string;
  }
).packageManager;

function readWorkflowSanityWorkflow() {
  return parse(readFileSync(".github/workflows/workflow-sanity.yml", "utf8"));
}

function findYamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return findYamlFiles(entryPath);
    }
    return entry.isFile() && /\.ya?ml$/u.test(entry.name) ? [entryPath] : [];
  });
}

function findUnpinnedExternalActions(): string[] {
  const violations: string[] = [];
  for (const workflowPath of [
    ...findYamlFiles(".github/workflows"),
    ...findYamlFiles(".github/actions"),
  ]) {
    for (const [index, line] of readFileSync(workflowPath, "utf8").split("\n").entries()) {
      const uses = line.match(/^\s*(?:-\s*)?uses:\s*([^#\s]+)/u)?.[1];
      if (!uses || uses.startsWith("./") || uses.startsWith("docker://")) {
        continue;
      }
      const at = uses.lastIndexOf("@");
      if (at < 1 || !/^[a-f0-9]{40}$/u.test(uses.slice(at + 1))) {
        violations.push(`${workflowPath}:${index + 1}: ${uses}`);
      }
    }
  }
  return violations;
}

describe("ci workflow guards", () => {
  it.each([7])("preserves module heredocs and cleans artifacts after exit %i", (exitCode) => {
    const parentTempDir = tmpdir();
    const run = runWorkflowShellScript(
      `node --input-type=module <<'NODE'
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
NODE_prefix: for (const value of ["heredoc-body-preserved"]) {
  console.log(value);
  break NODE_prefix;
}
console.log(mkdtempSync(join(tmpdir(), 'openclaw-workflow-child-')));
console.log(JSON.stringify(process.execArgv));
process.exitCode = ${exitCode};
NODE
`,
      {},
    );

    expect(run.status, run.stderr).toBe(exitCode);
    const [body, temporaryDirectory, execArgv] = run.stdout.trim().split("\n");
    const childDirectory = expectDefined(temporaryDirectory, "child temporary directory");
    try {
      expect(body).toBe("heredoc-body-preserved");
      expect(JSON.parse(expectDefined(execArgv, "module arguments"))).toEqual([
        "--input-type=module",
      ]);
      expect(tmpdir()).toBe(parentTempDir);
      expect(existsSync(childDirectory)).toBe(false);
    } finally {
      rmSync(childDirectory, { force: true, recursive: true });
    }
  });

  it.each([
    { name: "plain Node", setup: "", nodeOptions: "", extension: "mjs" },
    { name: "tsx", setup: "", nodeOptions: "--import tsx ", extension: "ts" },
    {
      name: "manifest loader",
      setup: "manifest_node_args=()\nmanifest_node_args+=(--import tsx)\n",
      nodeOptions: '"${manifest_node_args[@]}" ',
      extension: "ts",
    },
  ])("keeps $name heredocs outside cwd and resolves imports after cd", (fixture) => {
    const root = tempDirs.make("openclaw-workflow-resolution-");
    const child = path.join(root, "module's directory");
    mkdirSync(child);
    writeFileSync(path.join(child, "package.json"), '{"type":"module"}');
    writeFileSync(
      path.join(child, `value.${fixture.extension}`),
      fixture.extension === "ts"
        ? 'export const value: string = "resolved";'
        : 'export const value = "resolved";',
    );
    const run = runWorkflowShellScript(
      `${fixture.setup}node --input-type=module <<'BEFORE_CD'
import { readdirSync } from 'node:fs';
console.log(JSON.stringify(readdirSync(process.cwd())));
BEFORE_CD
cd ${quoteShell(child)}
node ${fixture.nodeOptions}--input-type=module <<'AFTER_CD'
import { readdirSync } from 'node:fs';
import { value } from './value.${fixture.extension}';
console.log(value);
console.log(JSON.stringify(readdirSync(process.cwd()).sort()));
AFTER_CD
`,
      { cwd: root },
    );

    const [rootFiles, value, childFiles] = run.stdout.trim().split("\n");
    // Observe the namespace while both rewritten bodies exist, not only after cleanup.
    expect(JSON.parse(expectDefined(rootFiles, "cwd namespace"))).toEqual([path.basename(child)]);
    expect(run.status, run.stderr).toBe(0);
    expect(value).toBe("resolved");
    expect(JSON.parse(expectDefined(childFiles, "child namespace"))).toEqual([
      "package.json",
      `value.${fixture.extension}`,
    ]);
  });

  it("shares full-build caches by installed Node version across requests and generations", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const cacheStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.name === "Restore build-all cache"),
      "full-build cache restore",
    );
    const renderCacheKey = (
      template: string,
      runId: number,
      runAttempt: number,
      requestedNode = "24.x",
      resolvedNode = "24.21.0",
    ) =>
      template.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression: string) =>
        String(
          runInNewContext(expression.replace(/\.([A-Za-z_][\w-]*)/gu, '["$1"]'), {
            github: { repository: "openclaw/openclaw", run_id: runId, run_attempt: runAttempt },
            inputs: { "build-all-cache-scope": "full", "node-version": requestedNode },
            runner: { os: "Linux", arch: "X64" },
            steps: { "setup-node": { outputs: { "resolved-version": resolvedNode } } },
            hashFiles: () => "unchanged-source",
          }),
        ),
      );
    // Actions cannot replace an exact key after a declaration group is rebuilt.
    const keys = (
      [
        [10, 1],
        [11, 1],
        [11, 2],
      ] as const
    ).map(([runId, runAttempt]) => renderCacheKey(cacheStep.with.key, runId, runAttempt));
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key.startsWith(renderCacheKey(cacheStep.with["restore-keys"], 11, 2).trim())).toBe(
        true,
      );
    }
    expect(cacheStep.with["restore-keys"]).not.toContain("hashFiles");
    const warmerKey = renderCacheKey(cacheStep.with.key, 10, 1);
    const releasePrefix = renderCacheKey(cacheStep.with["restore-keys"], 11, 1, "24.21.0").trim();
    expect(warmerKey.startsWith(releasePrefix)).toBe(true);
    for (const resolvedNode of ["24.22.0", "26.7.0"]) {
      const otherRuntimePrefix = renderCacheKey(
        cacheStep.with["restore-keys"],
        11,
        1,
        "24.x",
        resolvedNode,
      ).trim();
      expect(warmerKey.startsWith(otherRuntimePrefix)).toBe(false);
    }
  });

  it("persists Node 26 minimum declarations through trusted bounded artifacts", () => {
    const workflow = parse(readFileSync(".github/workflows/node-runtime-compat.yml", "utf8"));
    const steps = workflow.jobs.compat.steps as WorkflowStep[];
    const setupStep = steps.find((step) => step.name === "Setup Node environment");
    const resolveStep = steps.find(
      (step) => step.name === "Resolve trusted declaration cache artifact",
    );
    const downloadStep = steps.find(
      (step) => step.name === "Restore trusted declaration cache artifact",
    );
    const uploadStep = steps.find(
      (step) => step.name === "Publish trusted declaration cache artifact",
    );

    expect(workflow.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(setupStep?.with).not.toHaveProperty("build-all-cache-scope");
    expect(resolveStep?.run).toContain('.head_branch == "main"');
    expect(resolveStep?.run).toContain('(.path | split("@")[0])');
    expect(resolveStep?.run).toContain('.conclusion == "success"');
    expect(resolveStep?.run).toContain("status=success&per_page=5");
    expect(resolveStep?.run).toContain("artifacts?per_page=10");
    expect(resolveStep?.run).not.toContain("--paginate");
    expect(downloadStep).toMatchObject({
      if: "steps.declaration_cache.outputs.artifact_id != ''",
      uses: DOWNLOAD_ARTIFACT_V8,
      with: {
        path: ".artifacts/build-all-cache",
        repository: "${{ github.repository }}",
      },
    });
    expect(uploadStep).toMatchObject({
      if: "success() && github.repository == 'openclaw/openclaw' && github.ref == 'refs/heads/main'",
      uses: UPLOAD_ARTIFACT_V7,
      with: {
        "if-no-files-found": "error",
        "include-hidden-files": true,
        overwrite: true,
        path: ".artifacts/build-all-cache",
        "retention-days": 14,
      },
    });
  });

  it("shares transform generations with the warmer after CI exports its harness", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const generationStep = (action.runs.steps as WorkflowStep[]).find(
      (step) => step.name === "Resolve Vitest transform cache generation",
    );
    const expression = expectDefined(
      generationStep?.run?.match(/\$\{\{(.*?)\}\}/u)?.[1],
      "transform generation expression",
    );
    const sourceFiles = {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "pnpm-workspace.yaml": "packages: ['packages/*']",
      "package.json": '{"name":"fixture"}',
      "packages/worker/package.json": '{"name":"worker"}',
      "packages/worker/tsconfig.json": "{}",
      "vitest.config.ts": "export default {}",
      "test/vitest/shared.ts": "export const shared = {}",
      "src/state/schema.sql": "CREATE TABLE fixture (id TEXT);",
      ".github/actions/setup-security-review/package.json": '{"name":"review"}',
      ".ci-harness-source/package.json": '{"name":"real-source"}',
    };
    const files: Record<string, string> = { ...sourceFiles };
    const fingerprint = () =>
      runInNewContext(expression, {
        hashFiles: (...patterns: string[]) => {
          const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
          const excludes = patterns
            .filter((pattern) => pattern.startsWith("!"))
            .map((pattern) => pattern.slice(1));
          const hash = createHash("sha256");
          for (const [file, contents] of Object.entries(files).toSorted(([left], [right]) =>
            left.localeCompare(right),
          )) {
            if (
              includes.some((pattern) => minimatch(file, pattern, { dot: true })) &&
              !excludes.some((pattern) => minimatch(file, pattern, { dot: true }))
            ) {
              hash.update(createHash("sha256").update(contents).digest());
            }
          }
          return hash.digest("hex");
        },
      });
    const warmer = fingerprint();
    files[".ci-harness/.github/actions/setup-security-review/package.json"] =
      sourceFiles[".github/actions/setup-security-review/package.json"];
    files[".ci-harness/tsconfig.json"] = "{}";
    files["node_modules/dependency/package.json"] = '{"name":"dependency"}';
    expect(fingerprint()).toBe(warmer);
    for (const [file, contents] of Object.entries(sourceFiles)) {
      files[file] = `${contents}\n`;
      expect(fingerprint(), file).not.toBe(warmer);
      files[file] = contents;
    }
  });

  it("persists isolated transform and compile caches through immutable protected archives", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const step = (name: string) =>
      expectDefined(
        action.runs.steps.find((candidate: WorkflowStep) => candidate.name === name),
        name,
      );
    const transform = step("Restore Vitest transform cache");
    const compile = step("Restore Node compile cache");
    for (const reader of [transform, compile]) {
      expect(reader.uses).toBe(CACHE_V5);
      expect(reader.if).toContain("inputs.cache-mode != 'off'");
      expect(reader.if).toContain("inputs.restore-test-caches == 'true'");
      expect(reader.with.key).toContain("github.run_id");
      expect(reader.with.key).toContain("github.run_attempt");
    }
    expect(transform.if).toContain("runner.os != 'Windows'");
    expect(transform.if).not.toMatch(/runner\.(?:environment|labels|name)/u);
    expect(transform.with.key).toContain("vitest-fs-v4-protected-");
    expect(compile.with.key).toContain("node-compile-v3-test-protected-");
    expect(compile.with.key).not.toContain("pull_request");
    const transformConfiguration = step("Configure Vitest transform cache");
    expect(transformConfiguration.env.CACHE_WRITER).toBe("0");
    expect(transformConfiguration.run).toContain("OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER=");
    expect(step("Configure Node compile cache").run).toContain(
      "OPENCLAW_NODE_COMPILE_CACHE_WRITER=0",
    );
  });


  it("pins every external GitHub Action reference to a full commit SHA", () => {
    expect(findUnpinnedExternalActions()).toEqual([]);
  });

  it("fails OpenGrep SARIF artifact uploads when reports are missing", () => {
    const cases = [
      {
        workflowPath: OPENGREP_PR_DIFF_WORKFLOW,
        artifactName: "opengrep-pr-diff-sarif",
      },
      {
        workflowPath: OPENGREP_FULL_WORKFLOW,
        artifactName: "opengrep-full-sarif",
      },
    ];

    for (const item of cases) {
      const workflow = parse(readFileSync(item.workflowPath, "utf8"));
      const uploadStep = workflow.jobs.scan.steps.find(
        (step: WorkflowStep) => step.name === "Upload SARIF as workflow artifact",
      );

      expect(uploadStep.if, item.workflowPath).toBe("always()");
      expect(uploadStep.uses, item.workflowPath).toBe(UPLOAD_ARTIFACT_V7);
      expect(uploadStep.with, item.workflowPath).toMatchObject({
        name: item.artifactName,
        path: ".opengrep-out/precise.sarif",
        "if-no-files-found": "error",
      });
    }
  });

  it("verifies the pinned OpenGrep release binary before installing it", () => {
    for (const workflowPath of [OPENGREP_PR_DIFF_WORKFLOW, OPENGREP_FULL_WORKFLOW]) {
      const workflow = parse(readFileSync(workflowPath, "utf8"));
      const installStep = expectDefined(
        workflow.jobs.scan.steps.find((step: WorkflowStep) => step.name === "Install opengrep"),
        `Install opengrep step in ${workflowPath}`,
      );
      const run = expectDefined(installStep.run, `Install opengrep script in ${workflowPath}`);

      expect(installStep.env, workflowPath).toMatchObject({
        OPENGREP_VERSION: "v1.30.0",
        OPENGREP_LINUX_X64_SHA256:
          "35779bdd72e92129c8df2a77f0c55e8c08356801ea92591ef32108d6b28d564c",
      });
      expect(run, workflowPath).toContain('binary="$(mktemp "${RUNNER_TEMP}/opengrep.XXXXXX")"');
      expect(run, workflowPath).toContain("trap 'rm -f \"$binary\"' EXIT");
      expect(run, workflowPath).toContain(
        "curl -fsSL --retry 4 --retry-all-errors --retry-delay 2",
      );
      expect(run, workflowPath).toContain("--connect-timeout 10 --max-time 300");
      expect(run, workflowPath).toContain('-o "$binary"');
      expect(run, workflowPath).toContain(
        "https://github.com/opengrep/opengrep/releases/download/${OPENGREP_VERSION}/opengrep_manylinux_x86",
      );
      expect(run, workflowPath).toContain(
        'printf \'%s  %s\\n\' "$OPENGREP_LINUX_X64_SHA256" "$binary" | sha256sum --check',
      );
      expect(run, workflowPath).toContain('install -m 0755 "$binary" "$install_dir/opengrep"');
      expect(run.indexOf('-o "$binary"'), workflowPath).toBeLessThan(
        run.indexOf("sha256sum --check"),
      );
      expect(run.indexOf("sha256sum --check"), workflowPath).toBeLessThan(
        run.indexOf('install -m 0755 "$binary"'),
      );
      expect(run, workflowPath).not.toMatch(/\|\s*bash/u);
    }
  });

  it("keeps docs-change detection fail-safe and fixture-aware", () => {
    const action = readFileSync(".github/actions/detect-docs-changes/action.yml", "utf8");

    expect(action).toContain("base-sha:");
    expect(action).toContain("docs_only:");
    expect(action).toContain("docs_changed:");
    expect(action).toContain("BASE_SHA: ${{ inputs.base-sha }}");
    expect(action).toContain('BASE="$BASE_SHA"');
    expect(action).toContain(
      'CHANGED=$(git diff --no-renames --name-only "$BASE" HEAD 2>/dev/null || echo "UNKNOWN")',
    );
    expect(action).toContain('if [ "$CHANGED" = "UNKNOWN" ] || [ -z "$CHANGED" ]; then');
    expect(action).toContain("docs_only=false");
    expect(action).toContain("docs_changed=false");
    expect(action).toContain("test/fixtures/*)");
    expect(action).toContain("docs/* | *.md | *.mdx | config/markdownlint*.jsonc)");

    const run = parse(action).runs.steps[0].run as string;
    for (const [source, destination, docsChanged, docsOnly] of [
      ["src/old.ts", "docs/new.md", "true", "false"],
      ["docs/old.md", "src/new.ts", "true", "false"],
      ["docs/old.md", "docs/new.md", "true", "true"],
      ["docs/old.md", "docs/.generated/config-baseline.counts.json", "true", "true"],
      ["docs/old.md", "docs/plugins/plugin-inventory.md", "true", "true"],
      ["src/old.ts", "src/new.ts", "false", "false"],
      ["test/fixtures/old.md", "docs/new.md", "true", "false"],
      ["docs/removed.md", null, "true", "true"],
    ] as const) {
      const root = tempDirs.make("openclaw-docs-diff-");
      const origin = path.join(root, "origin");
      const checkout = path.join(root, "checkout");
      mkdirSync(path.dirname(path.join(origin, source)), { recursive: true });
      const content = Array.from({ length: 100 }, (_, index) => `line ${index}\n`).join("");
      writeFileSync(path.join(origin, source), content);
      runGit(origin, ["init", "-q", "-b", "main"]);
      for (const [name, value] of [
        ["user.name", "CI Fixture"],
        ["user.email", "ci-fixture@example.invalid"],
        ["commit.gpgsign", "false"],
        ["uploadpack.allowFilter", "true"],
      ] as const) {
        runGit(origin, ["config", name, value]);
      }
      runGit(origin, ["add", "."]);
      runGit(origin, ["commit", "-qm", "base"]);
      const base = runGit(origin, ["rev-parse", "HEAD"]);
      const sourceBlob = runGit(origin, ["rev-parse", `HEAD:${source}`]);
      rmSync(path.join(origin, source));
      if (destination) {
        mkdirSync(path.dirname(path.join(origin, destination)), { recursive: true });
        writeFileSync(path.join(origin, destination), `${content}edited after rename\n`);
      }
      runGit(origin, ["add", "-A"]);
      runGit(origin, ["commit", "-qm", "change"]);
      runGit(root, [
        "clone",
        "-q",
        "--no-local",
        "--filter=blob:none",
        "--depth=2",
        origin,
        checkout,
      ]);
      runGit(checkout, ["config", "diff.renames", "true"]);
      const localObjects = () =>
        runGit(checkout, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
      expect(localObjects()).toContain(base);
      expect(localObjects()).not.toContain(sourceBlob);
      const output = path.join(root, "output");
      const trace = path.join(root, "trace");
      const result = runWorkflowShellScript(run, {
        cwd: checkout,
        env: { ...process.env, BASE_SHA: base, GITHUB_OUTPUT: output, GIT_TRACE2_EVENT: trace },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readWorkflowOutputs(output), `${source} -> ${destination}`).toEqual({
        docs_changed: docsChanged,
        docs_only: docsOnly,
      });
      expect(readFileSync(trace, "utf8")).not.toContain('"fetch"');
      expect(localObjects()).not.toContain(sourceBlob);
    }
  });

  // Native Windows Node cannot execute this fixture's POSIX gh child shim.

  it("keeps action manifests within the runner's anchor-free YAML grammar", () => {
    const files = globSync([".github/actions/**/action.yml", ".github/actions/**/action.yaml"]);
    expect(files.length).toBeGreaterThan(0);
    const unsupported: string[] = [];
    for (const file of files) {
      const document = parseDocument(readFileSync(file, "utf8"));
      expect(document.errors, file).toEqual([]);
      visit(document, {
        Node(_key, node) {
          if (isAlias(node) || node.anchor) {
            unsupported.push(file);
          }
        },
      });
    }
    expect(unsupported).toEqual([]);
  });

  it("keeps setup cache access explicit and isolates every cache write", () => {
    const setupActionPaths = [
      ".github/actions/setup-node-env/action.yml",
      ".github/actions/setup-pnpm-store-cache/action.yml",
    ];
    const legacyInputs = [
      "save-actions-cache",
      "save-dependency-cache",
      "save-node-compile-cache",
      "save-vitest-fs-cache",
      "use-actions-cache",
    ];
    for (const actionPath of setupActionPaths) {
      const action = parse(readFileSync(actionPath, "utf8"));
      const steps = action.runs.steps as WorkflowStep[];
      expect(action.inputs["cache-mode"].default, actionPath).toBe("off");
      for (const legacyInput of legacyInputs) {
        expect(action.inputs, `${actionPath}: ${legacyInput}`).not.toHaveProperty(legacyInput);
      }
      expect(
        steps.filter(
          (step) =>
            step.uses?.startsWith("actions/cache@") || step.uses?.startsWith("actions/cache/save@"),
        ),
        actionPath,
      ).toEqual([]);
      expect(
        steps.filter((step) => step.uses?.startsWith("actions/cache/restore@")).length,
        actionPath,
      ).toBeGreaterThan(0);
      const validation = expectDefined(
        steps.find((step) => step.run?.includes("off|restore|read-write")),
        `${actionPath} cache-mode validation`,
      );
      expect(validation.run).toContain("Invalid cache-mode input");
    }

    const callers: Array<{ file: string; mode: unknown; step: WorkflowStep }> = [];
    const directCaches: Array<{
      file: string;
      step: WorkflowStep;
      jobId?: string;
      jobCondition?: string;
    }> = [];
    const rubySetups: Array<{ file: string; step: WorkflowStep }> = [];
    for (const file of [
      ...findYamlFiles(".github/workflows"),
      ...findYamlFiles(".github/actions"),
    ]) {
      const parsed = parse(readFileSync(file, "utf8"));
      const stepLists = [
        ...Object.entries(parsed?.jobs ?? {}).map(([jobId, job]) => {
          const owner = job as { steps?: WorkflowStep[]; if?: string };
          return { jobId, jobCondition: owner.if, steps: owner.steps ?? [] };
        }),
        {
          jobId: undefined,
          jobCondition: undefined,
          steps: (parsed?.runs?.steps ?? []) as WorkflowStep[],
        },
      ];
      for (const { jobId, jobCondition, steps } of stepLists) {
        for (const step of steps) {
          if (step.uses?.startsWith("actions/cache")) {
            directCaches.push({ file, step, jobId, jobCondition });
          }
          if (step.uses?.startsWith("ruby/setup-ruby@")) {
            rubySetups.push({ file, step });
          }
          if (
            step.uses === "./.github/actions/setup-node-env" ||
            step.uses?.endsWith("/.github/actions/setup-node-env") ||
            step.uses === "./.github/actions/setup-pnpm-store-cache" ||
            step.uses?.endsWith("/.github/actions/setup-pnpm-store-cache")
          ) {
            callers.push({ file, mode: step.with?.["cache-mode"], step });
          }
        }
      }
    }
    for (const { file, step } of rubySetups) {
      const bundlerCache = step.with?.["bundler-cache"] ?? false;
      expect([false, true, "false", "true"], `${file}: ${step.name}`).toContain(bundlerCache);
      if (bundlerCache === true || bundlerCache === "true") {
        expect(String(step.if), `${file}: ${step.name}`).toContain("cache_write_allowed == 'true'");
      }
    }
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) {
      const staticMode = ["off", "restore", "read-write"].includes(String(caller.mode));
      const conditionalMode =
        typeof caller.mode === "string" &&
        caller.mode.startsWith("${{") &&
        (caller.mode.includes("needs.preflight.outputs.cache_mode") ||
          caller.mode.includes("steps.candidate_trust.outputs.cache_mode") ||
          (caller.mode.includes("'restore'") &&
            (caller.mode.includes("'off'") || caller.mode.includes("'read-write'"))));
      expect(staticMode || conditionalMode, `${caller.file}: ${caller.step.name}`).toBe(true);
      for (const legacyInput of legacyInputs) {
        expect(caller.step.with, `${caller.file}: ${legacyInput}`).not.toHaveProperty(legacyInput);
      }
    }
    const writeAuthorizedCallers = callers.filter(
      (caller) =>
        caller.mode === "read-write" ||
        (typeof caller.mode === "string" && caller.mode.includes("'read-write'")),
    );
    expect(writeAuthorizedCallers).toEqual([]);

    const nodeCachePathPattern =
      /(?:^|\n)\s*(?:\.artifacts\/build-all-cache|dist\/|dist-runtime\/|packages\/\*\/dist\/|extensions\/\*\/dist\/|~\/\.cache\/ms-playwright|~\/\.local\/share\/pnpm|~\/\.cache\/pnpm|node_modules)(?:\n|$)/u;
    for (const { file, step, jobId, jobCondition } of directCaches) {
      if (step.uses?.startsWith("actions/cache/save@")) {
        
        
        
        const condition = String(step.if);
        expect(
          condition.includes(".outputs.cache-mode == 'read-write'") ||
            condition.includes("inputs.cache-mode == 'read-write'") ||
            condition.includes("needs.preflight.outputs.cache_write_allowed == 'true'"),
          `${file}: ${step.name}`,
        ).toBe(true);
      }
      if (step.uses?.startsWith("actions/cache@")) {
        expect(nodeCachePathPattern.test(String(step.with?.path)), `${file}: ${step.name}`).toBe(
          false,
        );
      }
    }
  });

  it("uses the workflow Node 24 pin for hosted default requests", () => {
    const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
    const setup: WorkflowStep = expectDefined(
      action.runs.steps.find((step: WorkflowStep) => step.id === "setup-node"),
      "Node setup",
    );
    const expression = String(
      expectDefined(setup.env?.REQUESTED_NODE_VERSION, "requested Node version"),
    )
      .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
      .replaceAll("inputs.node-version", 'inputs["node-version"]');
    for (const [environment, requested, pin, expected] of [
      ["github-hosted", "24.x", "24.21.0", "24.21.0"],
      ["github-hosted", "24.x", undefined, "24.x"],
      ["github-hosted", "24.x", "", "24.x"],
      ["github-hosted", "24.x", "26.1.0", "24.x"],
      ["github-hosted", "24.16.0", "24.21.0", "24.16.0"],
      ["github-hosted", "26.x", "24.21.0", "26.x"],
      ["self-hosted", "24.x", "24.21.0", "24.x"],
      ["", "24.x", "24.21.0", "24.x"],
    ] as const) {
      expect(
        runInNewContext(expression, {
          runner: { environment },
          inputs: { "node-version": requested },
          env: pin === undefined ? {} : { NODE_VERSION: pin },
          startsWith: (value: unknown, prefix: string) =>
            typeof value === "string" && value.startsWith(prefix),
        }),
        `${environment}/${requested}/${pin ?? "unset"}`,
      ).toBe(expected);
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves authenticated toolchain archives during dependency store repair",
    () => {
      const root = tempDirs.make("openclaw-install-recipe-");
      const workspace = path.join(root, "workspace");
      const bin = path.join(root, "bin");
      const store = path.join(root, "store");
      const log = path.join(root, "calls.jsonl");
      const githubEnv = path.join(root, "github.env");
      const payload = path.join(root, "payload");
      for (const directory of [
        bin,
        store,
        ...["", "ui", "packages", "extensions", "examples"].map((entry) =>
          path.join(workspace, entry),
        ),
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      mkdirSync(path.join(workspace, "node_modules"));
      writeFileSync(path.join(workspace, "node_modules", "before"), "");
      writeFileSync(path.join(store, "before"), "");
      mkdirSync(path.join(store, "toolchain"));
      writeFileSync(path.join(store, "toolchain", "pnpm.tgz"), "authenticated archive");
      symlinkSync(testNodeExecPath, path.join(bin, "node"));
      const pnpm = path.join(bin, "pnpm");
      writeFileSync(
        pnpm,
        "#!" +
          testNodeExecPath +
          "\n" +
          String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "-v") { console.log("fixture"); process.exit(0); }
const log = process.env.RECIPE_LOG;
const count = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0;
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), importMethod: process.env.PNPM_CONFIG_PACKAGE_IMPORT_METHOD }) + "\n");
process.exit(JSON.parse(process.env.RECIPE_EXITS)[count] ?? 99);
`,
      );
      chmodSync(pnpm, 0o755);
      const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
      const step: WorkflowStep = expectDefined(
        action.runs.steps.find(
          (candidate: WorkflowStep) => candidate.name === "Install dependencies",
        ),
        "Install dependencies",
      );
      const run = expectDefined(step.run, "Install dependencies script");
      const config = {
        PNPM_CONFIG_CACHE_DIR: path.join(root, "metadata"),
        PNPM_CONFIG_CHILD_CONCURRENCY: "3",
        PNPM_CONFIG_NETWORK_CONCURRENCY: "4",
        PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "copy",
        PNPM_CONFIG_STORE_DIR: store,
        PNPM_CONFIG_VIRTUAL_STORE_DIR: path.join(root, "virtual"),
      };
      const result = spawnSync(
        "bash",
        ["-c", run.trimEnd() + ' && printf reached > "$RECIPE_PAYLOAD"'],
        {
          cwd: workspace,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            NODE_BIN: bin,
            GITHUB_ACTION_PATH: path.resolve(".github/actions/setup-node-env"),
            GITHUB_WORKSPACE: workspace,
            GITHUB_ENV: githubEnv,
            RUNNER_OS: "Linux",
            CI: "true",
            DEPENDENCY_CACHE: "true",
            DEPENDENCY_CACHE_HIT: "true",
            FROZEN_LOCKFILE: "true",
            RECIPE_LOG: log,
            RECIPE_PAYLOAD: payload,
            RECIPE_EXITS: JSON.stringify([23, 23, 0]),
            ...config,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(payload)).toBe(true);
      const calls: Array<{ args: string[]; cwd: string; importMethod: string }> = readFileSync(
        log,
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const expectedArgs = [
        "install",
        "--config.ignore-scripts=false",
        "--config.engine-strict=false",
        "--config.enable-pre-post-scripts=true",
        "--config.side-effects-cache=true",
        "--frozen-lockfile",
        "--config.cache-dir=" + config.PNPM_CONFIG_CACHE_DIR,
        "--config.child-concurrency=3",
        "--config.network-concurrency=4",
        "--config.package-import-method=hardlink",
        "--config.store-dir=" + store,
        "--config.virtual-store-dir=" + config.PNPM_CONFIG_VIRTUAL_STORE_DIR,
      ];
      expect(calls).toEqual(
        ["--offline", "--offline", "--prefer-offline"].map((mode) => ({
          args: [...expectedArgs, mode],
          cwd: workspace,
          importMethod: "hardlink",
        })),
      );
      expect(existsSync(path.join(workspace, "node_modules", "before"))).toBe(false);
      expect(existsSync(path.join(store, "before"))).toBe(false);
      expect(readFileSync(path.join(store, "toolchain", "pnpm.tgz"), "utf8")).toBe(
        "authenticated archive",
      );
      expect(readFileSync(githubEnv, "utf8")).toBe(
        "OPENCLAW_BUILD_ALL_NO_PNPM=1\npnpm_config_verify_deps_before_run=false\n",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves pnpm hard links and validates cached importers and supply-chain policy offline",
    async ({ onTestFinished, signal }) => {
      const fixtureDirs = createTempDirTracker();
      // oxlint-disable-next-line prefer-const -- Failure cleanup can run before the registry is started.
      let stopRegistry: (() => Promise<void>) | undefined;
      // Timeout does not join the test body. Keep close and deletion in one hook,
      // outside afterEach, so a failed join cannot release the registry's files.
      onTestFinished(async () => {
        await stopRegistry?.();
        fixtureDirs.cleanup();
      });
      const root = fixtureDirs.make("openclaw-dependency-cache-");
      const source = path.join(root, "source");
      const registry = path.join(root, "registry");
      const workspace = path.join(root, "workspace");
      const consumer = path.join(workspace, "packages", "consumer");
      const store = path.join(workspace, ".cache", "openclaw-pnpm-store");
      let userHome = path.join(root, "producer-home");
      mkdirSync(userHome, { recursive: true });
      mkdirSync(source, { recursive: true });
      mkdirSync(registry, { recursive: true });
      mkdirSync(consumer, { recursive: true });
      writeFileSync(
        path.join(source, "package.json"),
        JSON.stringify({
          files: ["index.js"],
          name: "cache-proof-dep",
          packageManager: rootPackageManager,
          scripts: { "pnpm-path": "node -p process.env.npm_execpath" },
          version: "1.0.0",
        }),
      );
      writeFileSync(path.join(source, "index.js"), 'module.exports = "cache-proof-v1";\n');
      // Both projects own the pinned environment before any command runs; otherwise
      // pnpm resolves its own metadata from the public registry during bootstrap.
      const { environment } = pnpmLockfileDocuments(readFileSync("pnpm-lock.yaml", "utf8"));
      if (environment !== null) {
        for (const directory of [source, workspace]) {
          writeFileSync(path.join(directory, "pnpm-lock.yaml"), `---\n${environment}\n---\n`);
        }
      }
      // Capture the pinned CLI before switching to the fixture-only registry/store.
      const nodeExecPath = resolveTestNodeExecPath();
      const bootstrap = resolvePnpmRunner({ nodeExecPath });
      const npmExecPath = execFileSync(
        bootstrap.command,
        [...bootstrap.args, "--silent", "run", "pnpm-path"],
        { cwd: source, encoding: "utf8", env: { ...process.env, CI: "true" } },
      ).trim();
      const pnpm = resolvePnpmRunner({ nodeExecPath, npmExecPath });
      const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
      const configureCache = expectDefined(
        action.runs.steps.find(
          (step: WorkflowStep) => step.name === "Configure dependency cache store",
        )?.run,
        "Configure dependency cache store script",
      );
      const envFile = path.join(root, "dependency-cache.env");
      execFileSync("bash", ["-c", configureCache], {
        env: { ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_ENV: envFile },
      });
      const dependencyEnvironment = Object.fromEntries(
        readFileSync(envFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      const runPnpm = (args: string[], cwd: string) =>
        spawnSync(pnpm.command, [...pnpm.args, ...args], {
          cwd,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: userHome,
            XDG_CACHE_HOME: path.join(userHome, ".cache"),
            CI: "true",
            PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "hardlink",
            ...dependencyEnvironment,
          },
        });
      const version = runPnpm(["--version"], source);
      expect(version.status, version.stderr).toBe(0);
      expect(`pnpm@${version.stdout.trim()}`).toBe(rootPackageManager.split("+")[0]);
      const packed = runPnpm(["pack", "--pack-destination", registry], source);
      expect(packed.status, `${packed.stdout}${packed.stderr}`).toBe(0);
      const tarball = path.join(registry, "cache-proof-dep-1.0.0.tgz");
      const registryScript = String.raw`
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { createServer } = require("node:http");
const tarballPath = process.argv[1];
const tarball = readFileSync(tarballPath);
const server = createServer((request, response) => {
  if (request.url === "/cache-proof-dep") {
    const port = server.address().port;
    const metadata = {
      name: "cache-proof-dep",
      "dist-tags": { latest: "1.0.0" },
      time: {
        "1.0.0": new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        modified: new Date().toISOString(),
      },
      versions: {
        "1.0.0": {
          name: "cache-proof-dep",
          version: "1.0.0",
          dist: {
            tarball: "http://127.0.0.1:" + port + "/cache-proof-dep-1.0.0.tgz",
            shasum: createHash("sha1").update(tarball).digest("hex"),
            integrity: "sha512-" + createHash("sha512").update(tarball).digest("base64"),
          },
        },
      },
    };
    const abbreviated = request.headers.accept?.includes("application/vnd.npm.install-v1+json");
    if (abbreviated) {
      delete metadata.time;
    }
    response.setHeader("content-type", abbreviated ? "application/vnd.npm.install-v1+json" : "application/json");
    response.end(JSON.stringify(metadata));
    return;
  }
  if (request.url === "/cache-proof-dep-1.0.0.tgz") {
    response.setHeader("content-type", "application/octet-stream");
    response.end(tarball);
    return;
  }
  response.statusCode = 404;
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  process.send(server.address().port);
});
`;
      const registryServer = spawn(process.execPath, ["-e", registryScript, tarball], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let registryDidClose = false;
      // Retain actual close from launch, including failed spawn; readiness must not own this join.
      const registryClosed = new Promise<void>((resolve) => {
        registryServer.once("close", () => {
          registryDidClose = true;
          resolve();
        });
      });
      const failures: unknown[] = [];
      registryServer.on("error", (error) => failures.push(error));
      stopRegistry = async () => {
        if (!registryDidClose) {
          registryServer.kill("SIGTERM");
        }
        await registryClosed;
      };
      try {
        const ready = new Promise<number>((resolve, reject) => {
          registryServer.once("message", (message) => {
            if (typeof message !== "number") {
              reject(new Error("fixture registry sent an invalid port"));
              return;
            }
            resolve(message);
          });
          registryServer.once("error", reject);
        });
        const port = await withinTest(
          awaitGateBeforeSettlement(ready, registryClosed, "fixture registry closed before ready"),
          signal,
        );
        signal.throwIfAborted();
        const registryUrl = `http://127.0.0.1:${port}`;
        writeFileSync(
          path.join(workspace, "package.json"),
          JSON.stringify({
            dependencies: { "cache-proof-dep": "1.0.0" },
            name: "cache-proof-root",
            packageManager: rootPackageManager,
            private: true,
          }),
        );
        const workspaceConfig =
          "packages:\n  - packages/*\nminimumReleaseAge: 10080\nminimumReleaseAgeStrict: true\n";
        writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), workspaceConfig);
        const writeConsumerManifest = (dependencyVersion: string) =>
          writeFileSync(
            path.join(consumer, "package.json"),
            JSON.stringify({
              dependencies: { "cache-proof-dep": dependencyVersion },
              name: "cache-proof-consumer",
              private: true,
            }),
          );
        writeConsumerManifest("1.0.0");
        // The fixture registry serves only its test package, not the preserved project pnpm pin.
        const installArgs = [
          "install",
          "--ignore-scripts",
          "--config.engine-strict=false",
          "--pm-on-fail=ignore",
        ];
        const onlineArgs = [...installArgs, `--registry=${registryUrl}`];
        const seeded = runPnpm([...onlineArgs, "--lockfile-only"], workspace);
        expect(seeded.status, `${seeded.stdout}${seeded.stderr}`).toBe(0);
        // CI publishes a frozen install, without the lockfile generator's caches.
        rmSync(userHome, { force: true, recursive: true });
        rmSync(store, { force: true, recursive: true });
        mkdirSync(userHome, { recursive: true });
        const installed = runPnpm([...onlineArgs, "--frozen-lockfile"], workspace);
        expect(installed.status, `${installed.stdout}${installed.stderr}`).toBe(0);

        const findSameFile = (directory: string, referencePath: string): string | undefined => {
          const reference = statSync(referencePath);
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              const nested = findSameFile(entryPath, referencePath);
              if (nested) {
                return nested;
              }
            } else if (entry.isFile()) {
              const candidate = statSync(entryPath);
              if (candidate.dev === reference.dev && candidate.ino === reference.ino) {
                return entryPath;
              }
            }
          }
          return undefined;
        };
        const rootPackageFile = path.join(workspace, "node_modules", "cache-proof-dep", "index.js");
        expect(findSameFile(store, rootPackageFile)).toBeDefined();

        const archive = path.join(root, "dependency-cache.tar");
        execFileSync(
          "tar",
          [
            "-cf",
            archive,
            "-C",
            workspace,
            "node_modules",
            "packages/consumer/node_modules",
            ".cache/openclaw-pnpm-store",
          ],
          { stdio: "pipe" },
        );

        rmSync(path.join(workspace, "node_modules"), { force: true, recursive: true });
        rmSync(path.join(consumer, "node_modules"), { force: true, recursive: true });
        rmSync(store, { force: true, recursive: true });
        rmSync(userHome, { force: true, recursive: true });
        userHome = path.join(root, "consumer-home");
        mkdirSync(userHome, { recursive: true });
        execFileSync("tar", ["-xf", archive, "-C", workspace], { stdio: "pipe" });

        const restoredPackageFile = path.join(
          workspace,
          "node_modules",
          "cache-proof-dep",
          "index.js",
        );
        expect(findSameFile(store, restoredPackageFile)).toBeDefined();
        expect(
          readFileSync(path.join(consumer, "node_modules", "cache-proof-dep", "index.js"), "utf8"),
        ).toBe('module.exports = "cache-proof-v1";\n');

        await stopRegistry();
        const registryAtStop = {
          closed: registryDidClose,
          exitCode: registryServer.exitCode,
          signalCode: registryServer.signalCode,
        };
        signal.throwIfAborted();
        expect(
          registryAtStop.closed,
          "registry closed before source deletion/offline install",
        ).toBe(true);
        // This direct child owns the listener; its released port may already have a new owner.
        expect(registryAtStop.exitCode !== null || registryAtStop.signalCode !== null).toBe(true);
        rmSync(registry, { force: true, recursive: true });
        const cachedIdentity = statSync(restoredPackageFile);
        const cachedLockfile = readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8");
        const offlineArgs = [...onlineArgs, "--offline", "--frozen-lockfile"];
        const reconciliation = runPnpm(offlineArgs, workspace);
        expect(reconciliation.status, `${reconciliation.stdout}${reconciliation.stderr}`).toBe(0);
        expect(statSync(restoredPackageFile)).toMatchObject({
          dev: cachedIdentity.dev,
          ino: cachedIdentity.ino,
        });
        expect(readFileSync(path.join(workspace, "pnpm-lock.yaml"), "utf8")).toBe(cachedLockfile);
        expect(
          readFileSync(path.join(consumer, "node_modules", "cache-proof-dep", "index.js"), "utf8"),
        ).toBe('module.exports = "cache-proof-v1";\n');
        // A stricter policy invalidates pnpm's saved verification and reads the
        // restored registry metadata. A 14-day-old release fails a 21-day gate.
        writeFileSync(
          path.join(workspace, "pnpm-workspace.yaml"),
          workspaceConfig.replace("minimumReleaseAge: 10080", "minimumReleaseAge: 30240"),
        );
        const stricterPolicy = runPnpm(offlineArgs, workspace);
        expect(stricterPolicy.status).toBe(1);
        expect(`${stricterPolicy.stdout}${stricterPolicy.stderr}`).toContain(
          "ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION",
        );
        writeFileSync(path.join(workspace, "pnpm-workspace.yaml"), workspaceConfig);
        writeConsumerManifest("2.0.0");
        const drift = runPnpm(offlineArgs, workspace);
        expect(drift.status).toBe(1);
        expect(`${drift.stdout}${drift.stderr}`).toContain('Cannot install with "frozen-lockfile"');
        expect(`${drift.stdout}${drift.stderr}`).toContain('in importers["packages/consumer"]');
        expect(`${drift.stdout}${drift.stderr}`).toContain(
          "cache-proof-dep (lockfile: 1.0.0, manifest: 2.0.0)",
        );
      } catch (error) {
        if (failures[0] !== error) {
          failures.unshift(error);
        }
      } finally {
        try {
          await stopRegistry();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "dependency cache fixture failed");
      }
    },
  );

  it("bounds the workflow sanity ShellCheck download", () => {
    const workflow = readWorkflowSanityWorkflow();
    const shellcheckStep = expectDefined(
      workflow.jobs.actionlint.steps.find(
        (step: WorkflowStep) => step.name === "Install ShellCheck",
      ),
      "ShellCheck install step",
    );
    expect(shellcheckStep.run).toContain("curl --connect-timeout 10 --max-time 120");
    expect(shellcheckStep.run).toContain("--retry 5 --retry-delay 2 --retry-all-errors");
  });

  it("pins workflow and pre-commit actionlint to the large-stdin deadlock fix", () => {
    const revision = "011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7";
    const steps: WorkflowStep[] = readWorkflowSanityWorkflow().jobs.actionlint.steps;
    const setupGo = expectDefined(
      steps.find((step) => step.uses === SETUP_GO_V6),
      "Go setup",
    );
    const install = expectDefined(
      steps.find((step) => step.name === "Install actionlint"),
      "actionlint install",
    );

    expect(setupGo.with).toEqual({ "go-version": "1.27.1", cache: false });
    expect(steps.indexOf(setupGo)).toBeLessThan(steps.indexOf(install));
    expect(install.run).toContain(`ACTIONLINT_REVISION="${revision}"`);
    expect(install.run).toContain('export GOBIN="$RUNNER_TEMP/actionlint-bin"');
    expect(install.run).toContain(
      'go install "github.com/rhysd/actionlint/cmd/actionlint@${ACTIONLINT_REVISION}"',
    );
    expect(install.run).toContain('"$GOBIN/actionlint" -version');
    expect(install.run).toContain("v1.7.13-0.20260419144658-${ACTIONLINT_REVISION:0:12}");
    expect(install.run).toContain('echo "$GOBIN" >> "$GITHUB_PATH"');
    const preCommit = parse(readFileSync(".pre-commit-config.yaml", "utf8"));
    expect(
      preCommit.repos.find(
        (repo: { repo: string }) => repo.repo === "https://github.com/rhysd/actionlint",
      ).rev,
    ).toBe(revision);
  });

  it("keeps private Control UI servers and resource-sensitive files under one serial owner", () => {
    assertControlUiE2eOwnership((prefix) => tempDirs.make(prefix), parser);
  });

  it("keeps network CodeQL off unrelated source-only refactors", () => {
    const workflow = readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8");
    const networkConfig = readFileSync(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
      "utf8",
    );
    const rawSocketQuery = readFileSync(
      ".github/codeql/openclaw-boundary/queries/raw-socket-callsite-classification.ql",
      "utf8",
    );
    const networkSelector = workflow.slice(
      workflow.indexOf(".github/codeql/codeql-network-runtime-boundary-critical-quality.yml"),
      workflow.indexOf("network-runtime-boundary:"),
    );
    const broadCodeqlSelector = workflow.slice(
      workflow.indexOf(".github/codeql/*|.github/workflows/codeql-critical-quality.yml"),
      workflow.indexOf("src/**/*.test.ts|src/**/*.test.tsx"),
    );

    expect(broadCodeqlSelector).not.toContain("network_runtime=true");
    expect(networkSelector).toContain(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
    );
    expect(networkSelector).not.toContain("src/*.ts|src/**/*.ts");
    expect(networkSelector).not.toContain("extensions/*.ts|extensions/**/*.ts");
    expect(networkSelector).toContain("src/infra/net/*");
    expect(networkSelector).toContain("src/infra/ssh-tunnel.ts");
    expect(networkSelector).toContain("packages/net-policy/src/*");
    expect(networkConfig).not.toContain("\n  - src\n");
    expect(networkConfig).not.toContain("\n  - extensions\n");
    expect(networkConfig).toContain("\n  - src/infra/net\n");
    expect(networkConfig).toContain("\n  - packages/net-policy/src\n");
    expect(workflow).toContain("Fast PR network boundary diff scan");
    expect(workflow).toContain(
      '| select(.filename | test("(^|/)[^/]+\\\\.(?:e2e\\\\.)?test\\\\.tsx?$") | not)',
    );
    expect(workflow).toContain("Network runtime boundary-sensitive added lines");
    expect(workflow).toContain(
      'codex_transport="extensions/codex/src/app-server/transport-websocket.ts"',
    );
    expect(workflow).toContain(
      "network_codeql_contract_pattern='^\\.github/codeql/(codeql-network-runtime-boundary-critical-quality\\.yml|openclaw-boundary/queries/(raw-socket-callsite-classification|managed-proxy-runtime-mutation)\\.ql)$'",
    );
    expect(workflow).toContain(
      'if grep -Eq "$network_codeql_contract_pattern" "$changed_files" ||',
    );
    expect(workflow).not.toContain('grep -Fv "$codex_transport: " "$added_lines"');
    expect(workflow).toContain("packages/net-policy/src/");
    expect(workflow).toContain(
      "grep -En 'HTTP_PROXY|HTTPS_PROXY|NO_PROXY|GLOBAL_AGENT_|OPENCLAW_PROXY_' \"$added_lines\"",
    );
    expect(workflow).toContain('echo "full_codeql=true" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain(
      "if: ${{ github.event_name != 'pull_request' || steps.network-diff-scan.outputs.full_codeql == 'true' }}",
    );
    expect(rawSocketQuery).toMatch(
      /allowedOwnerScope\(\s*call\s*,\s*"extensions\/codex\/src\/app-server\/transport-websocket\.ts"\s*,\s*"connectCodexAppServerUnixSocket"\s*\)/,
    );
    expect(rawSocketQuery).not.toContain(
      'call.getFile().getRelativePath() = "extensions/codex/src/app-server/transport-websocket.ts"',
    );
  });

  
});

describe("workflow file size", () => {
  // GitHub refuses workflow files above 500 KiB: it creates a run named after
  // the file that fails with no jobs, so CI stops without reporting a failure.
  const GITHUB_WORKFLOW_MAX_BYTES = 512_000;
  const WORKFLOW_SOFT_LIMIT_BYTES = 480_000;

  it("keeps every workflow file well below GitHub's size limit", () => {
    const oversized = readdirSync(".github/workflows")
      .filter((name) => /\.ya?ml$/u.test(name))
      .map((name) => `.github/workflows/${name}`)
      .map((file) => ({ file, bytes: statSync(file).size }))
      .filter(({ bytes }) => bytes > WORKFLOW_SOFT_LIMIT_BYTES)
      .map(({ file, bytes }) => `${file}: ${bytes} bytes`);

    expect(
      oversized,
      `Workflow files must stay at or below ${WORKFLOW_SOFT_LIMIT_BYTES} bytes. GitHub's hard limit is ` +
        `${GITHUB_WORKFLOW_MAX_BYTES} bytes (500 KiB); above it, GitHub creates a run named after the ` +
        `file that fails immediately with no jobs, so all PR and main CI silently stops. Shrink the file ` +
        `(for example, YAML anchors/aliases for byte-identical expressions) before raising this limit.`,
    ).toEqual([]);
  });
});
