import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { parse } from "yaml";
import {
  ciCheckoutFixture,
  expectCiCheckoutCleanup,
  renderGitTestClock,
  withCiCheckoutFixture,
} from "./ci-checkout.test-support.js";

type Step = {
  name?: string;
  run?: string;
  env?: Record<string, string | number>;
  "working-directory"?: string;
};
type WorkflowTarget = { file: string; job: string; step: string };
type WorkflowInput = { jobs: Record<string, { steps: Step[] }> };
type ActionInput = { runs: { steps: (Step & { run: string })[] } };
export type FetchResult = number | "hang" | "cleanup-failure";

const workflowInputs = new Map<string, WorkflowInput>();
const actionInputs = new Map<string, ActionInput>();
const ownerSource = readFileSync(".github/actions/git-owner/owner.py", "utf8");
const basePolicySource = readFileSync(".github/actions/ensure-base-commit/policy.py", "utf8");

function readActionSteps(action: string) {
  const input =
    actionInputs.get(action) ??
    (parse(readFileSync(`.github/actions/${action}/action.yml`, "utf8")) as ActionInput);
  actionInputs.set(action, input);
  return input.runs.steps;
}

const candidate = "a".repeat(40);
const harness = "b".repeat(40);
const base = "c".repeat(40);
const moved = "d".repeat(40);
const merge = "e".repeat(40);
const defaults: Record<string, string> = {
  CHECKOUT_REPO: "fixture/checkout",
  CHECKOUT_TOKEN: "",
  CHECKOUT_REF: candidate,
  CHECKOUT_SHA: candidate,
  CHECKOUT_FALLBACK_REF: candidate,
  CHECKOUT_EVENT_REF: "refs/heads/main",
  WORKFLOW_SHA: harness,
  CHECKOUT_GIT_COMMITS_JSON: "null",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY: "fixture/checkout",
  DEFAULT_BRANCH: "main",
  EVENT_BASE_SHA: base,
  GH_TOKEN: "",
  PULL_REQUEST_NUMBER: "17",
  TARGET_SHA: candidate,
  RELEASE_GATE: "false",
  FROZEN_TARGET: "false",
  HISTORICAL_TARGET: "false",
  FORMAT_CHECK: "false",
  SKIP_NPM_LOCK: "false",
  CHANGED_CORE_TEST_PATHS_JSON: "",
  RUN_CONTROL_UI_I18N: "false",
  RUN_UI_TESTS: "false",
  HOSTED_RUNNER_STRIPES: "false",
  RUNNER_PROFILE: "github",
  PROTOCOL_SINCE_BASE_SHA: base,
  RATCHET_PR_HEAD_SHA: candidate,
};

function stepEnvironment(step: Step, supplied: Record<string, string>) {
  const resolved = { ...defaults, ...supplied };
  for (const [key, value] of Object.entries(step.env ?? {})) {
    if (String(value).startsWith("${{")) {
      if (resolved[key] === undefined) {
        throw new Error(`Unresolved fixture workflow environment: ${key}`);
      }
    } else {
      resolved[key] = String(value);
    }
  }
  return resolved;
}

function readWorkflowStep({ file, job, step: name }: WorkflowTarget): Step & { run: string } {
  const parsed = workflowInputs.get(file) ?? (parse(readFileSync(file, "utf8")) as WorkflowInput);
  workflowInputs.set(file, parsed);
  const step = parsed.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!step?.run) {
    throw new Error(`Missing executable workflow step ${file}/${job}/${name}`);
  }
  return { ...step, run: step.run };
}

export async function runCiGitStep(options: {
  signal: AbortSignal;
  workflow?: "workflow-sanity" | WorkflowTarget;
  action?: "ensure-base-commit" | "git-owner";
  gitFault?: { match: string; occurrence?: number; code: FetchResult | "cancel"; output?: string };
  gitFaults?: {
    match: string;
    occurrence?: number;
    code: FetchResult | "cancel";
    output?: string;
  }[];
  policy?: string;
  inlinePolicy?: boolean;
  step?: string;
  stepOutputs?: Record<string, Record<string, string>>;
  env?: Record<string, string>;
  fetchResults: FetchResult[];
  cloneResults?: FetchResult[];
  worktreeResults?: FetchResult[];
  rebaseResults?: FetchResult[];
  pushResults?: FetchResult[];
  revParseResult?: FetchResult;
  diffResult?: number;
  commandResults?: Record<string, { code: FetchResult; output?: string }>;
  workflowRuns?: {
    id: number;
    run_attempt: number;
    created_at: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
  }[];
  workflowJobs?: {
    runId: number;
    runAttempt: number;
    jobs: {
      name: string;
      status: string;
      conclusion: string | null;
      steps: { name: string; status: string; conclusion: string | null }[];
    }[];
  }[];
  publishPath?: "directory" | "file" | "symlink";
  checkoutResults?: number[];
  mergeSnapshots?: { sha: string; head: string }[];
  cancelDuringCleanup?: boolean;
  cleanupCancelMatch?: string;
  startupDelay?: { tree: number };
  revisions?: Record<string, string>;
  mergeBase?: { ancestor: boolean; revision: string };
  poisonPython?: boolean;
  baseAvailableAfter?: number;
  invalidRef?: boolean;
  scenario?: string;
  lsRemoteResults?: { output: string; code: number | "hang" | "cleanup-failure" }[];
  realClock?: boolean;
  virtualBackoff?: boolean;
  realDrain?: boolean;
  readyFetchClockAdvanceSeconds?: number;
  objects?: Record<string, { probe?: number; code?: number; text: string }>;
  cooperativeTrees?: boolean;
  cancelDuringBackoff?: boolean;
  setupFailure?: "owner" | "python" | "git";
}) {
  const externalOwner = Boolean(options.workflow);
  const clock = {
    ...options,
    realDrain:
      options.cancelDuringCleanup || options.scenario?.startsWith("cancel-") || options.realDrain,
  };
  const step: (Step & { run: string }) | undefined = options.action
    ? readActionSteps(options.action).find((entry) =>
        options.step ? entry.name === options.step : entry.run,
      )
    : options.workflow
      ? readWorkflowStep(
          options.workflow === "workflow-sanity"
            ? {
                file: ".github/workflows/workflow-sanity.yml",
                job: "actionlint",
                step: "Prepare trusted workflow audit configs",
              }
            : options.workflow,
        )
      : readActionSteps("git-owner")[0];
  if (!step?.run) {
    throw new Error("Missing executable action step");
  }
  let env: Record<string, string>;
  return withCiCheckoutFixture(
    `linux:${options.scenario ?? "configured"}`,
    options.signal,
    (root) => {
      const actions = path.join(root, "trusted-actions");

      env = stepEnvironment(step, {
        CONTENTS_TOKEN: "fixture-contents",
        HEAD_BRANCH: "automation/locale",
        BASE_BRANCH: "main",
        COMMIT_MESSAGE: "fixture",
        PR_TITLE: "fixture",
        PR_BODY: "fixture",
        GENERATED_PATHS: "generated",
        INVALIDATION_PATHS: "source",
        OVERLAP_POLICY: "defer",
        AUTO_MERGE: "false",
        BASE_SHA: base,
        BASE_REF: "main",
        FETCH_REF: "fixture-base",
        BASE_ACTION_PATH: path.join(actions, "ensure-base-commit"),
        OWNER_ACTION_PATH: path.join(actions, "git-owner"),
        ...options.env,
      });
      const workspace = path.join(root, "workspace");

      if (externalOwner) {
        // Workflow bodies follow actions/checkout; selected-source bootstrap must
        // still create its own directory, while later selected steps inherit one.
        for (const directory of [
          workspace,
          ...(step["working-directory"] ? [path.join(workspace, step["working-directory"])] : []),
        ]) {
          mkdirSync(path.join(directory, ".git"), { recursive: true });
          writeFileSync(path.join(directory, ".git/preexisting.lock"), "not invocation-owned\n");
        }
      }
      if (options.startupDelay?.tree) {
        writeFileSync(
          path.join(root, "tree-start-delay-1.json"),
          String(options.startupDelay.tree),
        );
      }
      for (const action of ["git-owner", "ensure-base-commit"]) {
        mkdirSync(path.join(actions, action), { recursive: true });
        const name = action === "git-owner" ? "owner.py" : "policy.py";
        let source = renderGitTestClock(
          action === "git-owner" ? ownerSource : basePolicySource,
          clock,
        );
        if (
          action === "git-owner" &&
          options.cancelDuringCleanup &&
          !source.includes("cleanup-cancelled.json")
        ) {
          throw new Error("Missing copied Git owner cleanup cancellation boundary");
        }

        if (action === "git-owner" && options.cancelDuringBackoff) {
          if (!options.realClock || options.virtualBackoff) {
            throw new Error("Backoff cancellation requires the real owner clock");
          }
          // Existing callers exec Python into the supervised shell's PID.
          // A non-exec caller would require separate shell propagation proof.
          if (!step.run.includes('exec python3 -I -S "$CI_GIT_OWNER" --policy')) {
            throw new Error("Backoff cancellation requires an exec-owned Python policy");
          }
          const boundary = "    while time.monotonic() < retry_at:\n        check_cancelled()";
          if (source.split(boundary).length !== 2) {
            throw new Error("Missing unique Git owner backoff cancellation boundary");
          }
          // Claim before acknowledgment so a dropped first signal cannot be retried.
          source = source.replace(
            boundary,
            `${boundary}
        fixture_cancel = os.path.join(os.environ["TMPDIR"], "backoff-cancel-claimed.json")
        if not os.path.exists(fixture_cancel):
            with open(fixture_cancel, "x") as receipt:
                json.dump(os.getpid(), receipt)
            subprocess.run([${JSON.stringify(process.execPath)}, ${JSON.stringify(ciCheckoutFixture)},
                            "observe", os.environ["TMPDIR"], "linux:configured", "backoff-cancel"], check=True)
            os.kill(os.getpid(), signal.SIGTERM)`,
          );
        }
        writeFileSync(path.join(actions, action, name), source);
      }

      const protectedFile = path.join(
        env.CHECKOUT_KIND === "clawhub" ? workspace : root,
        "protected",
      );
      writeFileSync(protectedFile, "not checkout-owned\n");
      if (["android", "clawhub"].includes(env.CHECKOUT_KIND ?? "")) {
        const checkout =
          env.CHECKOUT_KIND === "clawhub" ? path.join(workspace, "clawhub-source") : workspace;
        mkdirSync(checkout, { recursive: true });
        writeFileSync(path.join(checkout, ".previous-checkout"), "stale\n");
      }
      if (options.poisonPython) {
        env.PYTHONPATH = workspace;
        const poison = `from pathlib import Path\nPath(${JSON.stringify(path.join(root, "python-injected"))}).write_text("injected")\nraise RuntimeError("candidate Python startup executed")\n`;
        for (const name of ["sitecustomize.py", "subprocess.py"]) {
          writeFileSync(path.join(workspace, name), poison);
        }
      }
      const revisions = {
        HEAD: candidate,
        "refs/heads/main": moved,
        "refs/pull/17/merge": merge,
        "refs/remotes/origin/release-gate-merge^1": base,
        "refs/remotes/origin/release-gate-merge^2": candidate,
        ...options.revisions,
      };
      writeFileSync(
        path.join(root, "fixture-options.json"),
        JSON.stringify({
          env,
          gitFault: options.gitFault,
          gitFaults: options.gitFaults,
          revisions,
          mergeBase: options.mergeBase,
          workingDirectory: step["working-directory"],
          fetchResults: options.fetchResults,
          cloneResults: options.cloneResults,
          worktreeResults: options.worktreeResults,
          rebaseResults: options.rebaseResults,
          pushResults: options.pushResults,
          revParseResult: options.revParseResult,
          diffResult: options.diffResult,
          commandResults: options.commandResults,
          workflowRuns: options.workflowRuns,
          workflowJobs: options.workflowJobs,
          checkoutResults: options.checkoutResults,
          mergeSnapshots: options.mergeSnapshots,
          consumers: externalOwner,
          cancelDuringCleanup: options.cancelDuringCleanup,
          cleanupCancelMatch: options.cleanupCancelMatch,
          baseAvailableAfter: options.baseAvailableAfter,
          invalidRef: options.invalidRef,
          lsRemoteResults: options.lsRemoteResults,
          objects: options.objects,
          cooperativeTrees: options.cooperativeTrees,
          setupFailure: options.setupFailure,
        }),
      );
      let run = renderGitTestClock(step.run, clock);
      for (const [stepId, outputs] of Object.entries(options.stepOutputs ?? {})) {
        for (const [name, value] of Object.entries(outputs)) {
          run = run.replaceAll(`\${{ steps.${stepId}.outputs.${name} }}`, value);
        }
      }
      if (externalOwner) {
        const prepareRun = readActionSteps("git-owner")[0]?.run;
        if (!prepareRun) {
          throw new Error("Missing Git owner preparation body");
        }
        writeFileSync(path.join(root, "prepare.sh"), prepareRun);
        // Model the runner's environment handoff, not shell evaluation of paths with spaces.
        run = `bash --noprofile --norc -eo pipefail "$TMPDIR/prepare.sh"
export CI_GIT_OWNER
CI_GIT_OWNER="$(sed -n 's/^CI_GIT_OWNER=//p' "$GITHUB_ENV")"
: > "$GITHUB_ENV"
: > "$GITHUB_OUTPUT"
${options.setupFailure === "owner" ? 'rm "$CI_GIT_OWNER"' : ""}
${run}`;
      }
      if (options.policy) {
        const policy = path.join(root, "policy.py");
        writeFileSync(policy, options.policy);
        run =
          'unset RUNNER_OS GITHUB_WORKSPACE RUNNER_TEMP\nexec python3 -I -S "$OWNER_ACTION_PATH/owner.py" --policy ' +
          (options.inlinePolicy ? '- < "$TMPDIR/policy.py"' : '"$TMPDIR/policy.py"');
      }

      writeFileSync(path.join(root, "checkout.sh"), run);
    },
    (report, result, stderr, root) => {
      const workspace = path.join(root, "workspace");
      const protectedFile = path.join(
        env.CHECKOUT_KIND === "clawhub" ? workspace : root,
        "protected",
      );
      const actions = path.join(root, "trusted-actions");
      console.log(
        `${typeof options.workflow === "object" ? `${options.workflow.file}/${options.workflow.job}/${options.workflow.step}` : `${options.workflow ?? options.action}/${options.step ?? "Checkout"}`}: ${JSON.stringify(report)}`,
      );
      expect(result, `${stderr}\n${report.error ?? ""}`).toEqual({ code: 0, signal: null });
      expect(report.error, stderr).toBeUndefined();
      expectCiCheckoutCleanup(report);

      if (externalOwner) {
        for (const directory of new Set([
          workspace,
          ...report.commands
            .filter(({ tool, args }) => tool === "git" && args[0] === "fetch")
            .map(({ cwd }) => cwd),
          ...report.commands
            .filter(
              ({ tool, args }) => tool === "git" && (args[0] === "clone" || args[0] === "worktree"),
            )
            .map(({ cwd, args }) => path.resolve(cwd, args.at(args[0] === "clone" ? -1 : -2)!)),
        ])) {
          expect(readFileSync(path.join(directory, ".git/preexisting.lock"), "utf8")).toBe(
            "not invocation-owned\n",
          );
        }
      }
      expect(readFileSync(protectedFile, "utf8")).toBe("not checkout-owned\n");
      expect(
        existsSync(path.join(root, "python-injected")),
        "candidate Python startup executed",
      ).toBe(false);
      const readOutput = (name: string) =>
        existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), "utf8") : "";
      if (options.action === "ensure-base-commit") {
        expect(report.output).not.toContain("fixture quiet probe");
      }
      if (options.action === "git-owner") {
        const ownerPath = readOutput("github-env")
          .trim()
          .replace(/^CI_GIT_OWNER=/u, "");
        expect(path.relative(path.join(root, "temp"), ownerPath)).not.toMatch(/^\.\./u);
        expect(readFileSync(ownerPath, "utf8")).toBe(
          readFileSync(path.join(actions, "git-owner/owner.py"), "utf8"),
        );
        expect(readOutput("github-output")).toBe(`owner-path=${ownerPath}\n`);
      }

      return {
        ...report,
        backoffClockAdvancedSeconds: [
          ...report.output.matchAll(/fixture backoff advanced: ([\d.]+)/gu),
        ].reduce((total, match) => total + Number(match[1]), 0),
        ...(options.readyFetchClockAdvanceSeconds === undefined
          ? {}
          : {
              fetchClockAdvancedSeconds:
                options.readyFetchClockAdvanceSeconds *
                readdirSync(root).filter((name) => /^fetch-tick-\d+\.json$/u.test(name)).length,
            }),
        workspace,
        githubOutput: readOutput("github-output"),
        githubEnv: readOutput("github-env"),
        githubSummary: readOutput("github-summary"),
        githubPath: readOutput("github-path"),
        trustedConfig: readOutput("temp/pre-commit-base.yaml"),
        trustedZizmor: readOutput("temp/zizmor-base.yml"),
        runnerTemp: path.join(root, "temp"),
        fetches: report.commands.filter(({ tool, args }) => tool === "git" && args[0] === "fetch"),
        clones: report.commands.filter(({ tool, args }) => tool === "git" && args[0] === "clone"),
        worktrees: report.commands.filter(
          ({ tool, args }) => tool === "git" && args[0] === "worktree",
        ),
        rebases: report.commands.filter(({ tool, args }) => tool === "git" && args[0] === "rebase"),
        pushes: report.commands.filter(({ tool, args }) => tool === "git" && args[0] === "push"),
        checkouts: report.commands.filter(
          ({ tool, args }) => tool === "git" && args[0] === "checkout",
        ),
      };
    },
  );
}
