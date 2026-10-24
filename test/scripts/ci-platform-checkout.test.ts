import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { isProcessAlive } from "../helpers/process-wait.js";
import {
  ciCheckoutFixture,
  expectCiCheckoutCleanup,
  withCiCheckoutFixture,
} from "./ci-checkout.test-support.js";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import { registerWindowsCensusTests } from "./ci-windows-process-census.test-support.js";

registerWindowsCensusTests();

it.for(["prepare", "inspect"])(
  "removes checkout artifacts after %s assertion failure",
  { timeout: 55_000 },
  async (phase, { signal }) => {
    let root: string | undefined;
    await expect(
      withCiCheckoutFixture(
        "early-leader-exit",
        signal,
        (directory) => {
          root = directory;
          expect(phase, "injected prepare assertion").not.toBe("prepare");
          writeFileSync(path.join(directory, "checkout.sh"), "exit 0\n");
        },
        (report, result, stderr) => {
          expect(result, stderr).toEqual({ code: 0, signal: null });
          expectCiCheckoutCleanup(report);
          expect(report.code, "injected inspect assertion").toBe(99);
        },
      ),
    ).rejects.toThrow(`injected ${phase} assertion`);
    expect(existsSync(expectDefined(root, "created checkout root"))).toBe(false);
  },
);

it.skipIf(process.platform === "win32").each(["census", "corrupt-report", "timeout", "cancel"])(
  "retains checkout artifacts across failed outer-runner cleanup (%s)",
  async (fault) => {
    const preload = String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import { syncFixtureBuiltinExports } from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
import path from "node:path";
if (process.argv[2] === "sentinel" && fault === "timeout") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (process.argv[2] === "supervise") {
  const root = process.argv[3], children = [], pending = new Set();
  const spawn = cp.spawn, spawnSync = cp.spawnSync, renameSync = fs.renameSync;
  cp.spawn = (...args) => {
    const child = spawn(...args);
    children.push(child.pid);
    pending.add(child);
    fs.writeFileSync(path.join(root, "creator-pids.json"), JSON.stringify([process.pid, ...children]));
    child.once("close", () => pending.delete(child));
    if (fault === "timeout") {
      // Notify after spawn returns and the fixture installs direct-child tracking.
      // Flush IPC before stalling; sentinel registration is deliberately blocked.
      queueMicrotask(() => {
        process.send({ type: "ci-checkout:sentinel-created", pids: [process.pid, child.pid] }, error => {
          if (error) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        });
      });
    }
    if (fault === "cancel" && args[1]?.[1] !== "sentinel") {
      // The detached workflow shell is running; only the supervisor can retire its group.
      queueMicrotask(() => process.send({ type: "ci-checkout:shell-started", pids: [process.pid, ...children] }));
    }
    return child;
  };
  cp.spawnSync = (...args) => {
    if (fault === "census" && args[0] === "/bin/ps" && children.length === 2 && pending.size === 0) {
      fs.writeFileSync(path.join(root, "closed-before-census.json"), JSON.stringify(children));
      throw new Error("injected final census failure after direct child close");
    }
    return spawnSync(...args);
  };
  fs.renameSync = (...args) => {
    const result = renameSync(...args);
    if (fault === "corrupt-report" && args[1] === path.join(root, "report.json")) {
      fs.writeFileSync(args[1], "null");
    }
    return result;
  };
  syncFixtureBuiltinExports();
}
`;
    // Use the actual outer namespace owner, including its cleanup on exit code 1.
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { fixturePreloadEnv, syncFixtureBuiltinExports } from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
import { tmpdir } from "node:os";
import path from "node:path";
const timeoutFault = process.argv[2] === "timeout";
const cancelledFault = timeoutFault || process.argv[2] === "cancel";
const cancellation = new AbortController();
let root, failure;
let supervisor, ready, onReady;
const fork = cp.fork;
if (cancelledFault) {
  ready = new Promise(resolve => {
    onReady = message => {
      if (message?.type === (timeoutFault ? "ci-checkout:sentinel-created" : "ci-checkout:shell-started")) {
        resolve(message.pids);
      }
    };
  });
  cp.fork = (...args) => {
    supervisor = fork(...args);
    supervisor.on("message", onReady);
    return supervisor;
  };
  syncFixtureBuiltinExports();
}
try {
  const { withCiCheckoutFixture } = await import(process.argv[1]);
  const completed = withCiCheckoutFixture("early-leader-exit", cancellation.signal, directory => {
    root = directory;
    fs.writeFileSync(path.join(root, "checkout.sh"), process.argv[2] === "cancel" ? "exec sleep 30\n" : "exit 0\n");
    const preload = path.join(root, "fault.mjs");
    fs.writeFileSync(preload, "const fault = " + JSON.stringify(process.argv[2]) + ";\n" + process.argv[3]);
    return fixturePreloadEnv(preload);
  }, (report, result, stderr) => {
    throw new Error("unexpected completed report: " + JSON.stringify({ report, result, stderr }));
  }).catch(error => {
    console.error(error);
    failure = String(error);
  });
  try {
    if (cancelledFault) {
      const pids = await Promise.race([ready, completed.then(() => {
        throw new Error("supervisor completed before the cancellation probe was ready");
      })]);
      assert.equal(pids.length, timeoutFault ? 2 : 3);
      assert.equal(pids[0], supervisor.pid);
      assert.notEqual(pids[1], supervisor.pid);
      for (const pid of pids) {
        assert(Number.isInteger(pid) && pid > 1);
        process.kill(pid, 0);
      }
    }
  } finally {
    if (cancelledFault) {
      // Creation belongs to the supervisor, not a child's delayed self-registration.
      // Cancel the run the way a Vitest timeout aborts its owning test.
      cancellation.abort(new Error("owning test cancelled the supervised run"));
    }
    await completed;
  }
} catch (error) {
  console.error(error);
  failure = String(error);
} finally {
  if (cancelledFault) {
    supervisor?.off("message", onReady);
    cp.fork = fork;
    syncFixtureBuiltinExports();
  }
}
console.log(JSON.stringify({ root, outerRoot: tmpdir(), failure,
  pids: JSON.parse(fs.readFileSync(path.join(root, "creator-pids.json"), "utf8")),
  closedBeforeCensus: fs.existsSync(path.join(root, "closed-before-census.json")),
}));
process.exitCode = 1;
`,
        new URL("./ci-checkout.test-support.ts", import.meta.url).href,
        fault,
        preload,
      ],
      options: { stdio: ["ignore", "pipe", "pipe"] },
    });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (data) => (stdout += String(data)));
    child.stderr?.on("data", (data) => (stderr += String(data)));
    const result = await completion;
    expect(stdout, stderr).not.toBe("");
    const evidence = JSON.parse(stdout) as {
      root: string;
      outerRoot: string;
      failure: string;
      pids: number[];
      closedBeforeCensus: boolean;
    };
    try {
      console.log(`${fault}: ${JSON.stringify({ result, ...evidence, stderr })}`);
      expect(result, stderr).toEqual({ code: 1, signal: null, groupJoined: true });
      expect(existsSync(evidence.outerRoot), "outer runner did not remove its own namespace").toBe(
        false,
      );
      expect(path.dirname(evidence.root)).toBe(
        realpathSync(fileURLToPath(new URL("../../.artifacts/ci-checkout/", import.meta.url))),
      );
      expect(existsSync(evidence.root), stderr).toBe(true);
      expect(
        evidence.pids.every((pid) => !isProcessAlive(pid)),
        "fixture left owned processes alive",
      ).toBe(true);
      expect(stderr).toContain(
        `Checkout fixture retained at ${evidence.root}; no completed report.`,
      );
      expect(stderr).toContain("Supervisor close: true; group extinction: true.");
      if (fault === "census") {
        expect(evidence.closedBeforeCensus).toBe(true);
        expect(evidence.pids).toHaveLength(3);
        expect(stderr).toContain("injected final census failure after direct child close");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else if (fault === "timeout") {
        expect(evidence.pids).toHaveLength(2);
        expect(evidence.failure).toContain("owning test cancelled the supervised run");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else if (fault === "cancel") {
        // The detached shell group died, so the live supervisor ran its own cleanup.
        expect(evidence.pids).toHaveLength(3);
        expect(evidence.failure).toContain("owning test cancelled the supervised run");
        expect(
          JSON.parse(readFileSync(path.join(evidence.root, "report.json"), "utf8")),
        ).toMatchObject({ error: "test cancelled", cleanupRemaining: [] });
      } else {
        expect(evidence.failure).not.toContain("unexpected completed report");
        expect(readFileSync(path.join(evidence.root, "report.json"), "utf8")).toBe("null");
      }
    } finally {
      // Completion already joined the outer group; the fixture joined its detached owners.
      expect(evidence.pids.every((pid) => !isProcessAlive(pid))).toBe(true);
      rmSync(evidence.root, { recursive: true, force: true });
    }
  },
  55_000,
);

it.skipIf(process.platform === "win32")(
  "waits for legal slow tree startup before cancellation",
  async ({ signal }) => {
    const report = await runCiGitStep({
      signal,
      policy:
        'from ci_git_owner import run_git\nimport os\nrun_git(os.getcwd(), "fetch", "origin", "fixture")\n',
      fetchResults: ["hang"],
      scenario: "cancel-SIGTERM",
      startupDelay: { tree: 4_100 },
    });
    expect(report.code, report.output).toBe(143);
    expect(report.readyAttempts).toEqual([1]);
    expect(report.fetches).toHaveLength(1);
  },
  55_000,
);

it.skipIf(process.platform === "win32")(
  "reports owner exit and output instead of a cleanup readiness timeout",
  async ({ signal }) => {
    const report = await runCiGitStep({
      signal,
      policy: 'print("owner exited before cleanup readiness", flush=True)\nraise SystemExit(23)\n',
      fetchResults: [],
      cancelDuringCleanup: true,
    });
    expect(report.code).toBe(23);
    expect(report.cancelledDuringCleanup).toBe(false);
    expect(report.output).toBe("owner exited before cleanup readiness\n");
    expect(report.readyAttempts).toEqual([]);
    expect(report.commands).toEqual([]);
  },
  55_000,
);

it("does not revive a terminated fixture instance when its PID is reused", () => {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-c",
      String.raw`
import contextlib, json, os, pathlib, runpy, subprocess, sys, tempfile

with tempfile.TemporaryDirectory(prefix="checkout-pid-reuse-") as directory:
    root = pathlib.Path(directory).resolve()
    workspace = root / "workspace"
    workspace.mkdir()
    records = root / "pids"
    records.mkdir()
    (root / "lease").write_text("owned")
    # Guard command scope while retaining the real OS liveness result.
    guard = root / "census.cjs"
    guard.write_text('''
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const spawnSync = cp.spawnSync;
const inspected = new Set();
cp.spawnSync = (command, args, options) => {
  if (command === "/bin/ps") {
    const index = args.indexOf("-p");
    assert(index >= 0 && args.filter(arg => arg === "-p").length === 1 && /^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(args[index + 1]), "fixture census must query an explicit PID list");
    const selected = args[index + 1].split(",").map(Number);
    assert(process.platform === "linux" || selected.length === 1, "non-Linux census must query exactly one PID");
    assert(args.every(arg => !arg.startsWith("-") || ["-p", "-o"].includes(arg)), "fixture census must select owned PIDs only");
    const records = path.join(process.argv[3], "pids");
    const allowed = new Set(fs.readdirSync(records).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(records, name), "utf8"))).filter(record => !fs.existsSync(path.join(records, record.instance + ".dead"))).map(record => record.pid));
    for (const pid of selected) {
      assert(allowed.has(pid) && !inspected.has(pid), "fixture census escaped deduplicated registered ownership");
      inspected.add(pid);
    }
  }
  return spawnSync(command, args, options);
};
''' + "\nrequire(" + json.dumps(sys.argv[5]) + ").syncFixtureBuiltinExports();\n")
    with subprocess.Popen([sys.executable, "-I", "-S", "-c", "import sys; sys.stdin.read()"],
                          stdin=subprocess.PIPE) as child, contextlib.ExitStack() as cleanup:
        lease_owner = cleanup.enter_context(subprocess.Popen([
            sys.argv[1], sys.argv[2], "lease-owner", str(root), "standalone"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True))
        def close_lease_owner():
            lease_owner.communicate(timeout=4)
            assert lease_owner.returncode == 0, "lease owner failed during retirement"
        cleanup.callback(close_lease_owner)
        assert lease_owner.stdout.readline().strip() == "ready", "lease owner failed to initialize"
        if os.name == "nt":
            broker = cleanup.enter_context(subprocess.Popen([
                sys.argv[1], "--input-type=module", "-e", """
const { createWindowsProcessCensus } = await import(process.argv[1]);
const owner = createWindowsProcessCensus({ root: process.argv[2], token: "owned",
  onFailure: error => { console.error(error); process.exitCode = 1; void owner.close(); } });
try {
  await owner.ready;
  console.log("ready");
  await new Promise(resolve => { process.stdin.once("end", resolve); process.stdin.resume(); });
} finally { await owner.close(); }
""", sys.argv[4], str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True))
            # EOF retires the broker and sampler before the Python namespace owner leaves.
            cleanup.callback(lambda: broker.communicate(timeout=4))
            assert broker.stdout.readline().strip() == "ready", "census owner failed to initialize"
        retired = dict(pid=child.pid, role="grandchild", attempt=1, instance="retired")
        current = dict(pid=os.getpid(), role="grandchild", attempt=2, instance="current")
        if os.name == "nt":
            read_processes = runpy.run_path(sys.argv[3])["read_processes"]
            identities = read_processes([child.pid, os.getpid()])
            assert all(identity["alive"] for identity in identities)
            retired["creationTime"], current["creationTime"] = (
                identity["creationTime"] for identity in identities)
        child.communicate(timeout=10)
        (records / "retired.json").write_text(json.dumps(retired))
        (records / "current.json").write_text(json.dumps(current))
        (records / "sentinel.json").write_text(json.dumps(
            dict(current, role="sentinel", attempt=0, instance="sentinel")))

        def observe():
            subprocess.run([sys.argv[1], "--require", str(guard), sys.argv[2], "git", str(root), "early-leader-exit",
                            "-C", str(workspace), "checkout"], cwd=workspace, check=True)
            observed = json.loads((root / "events.jsonl").read_text().splitlines()[-1])
            assert observed["sentinelAlive"], "unrelated live sentinel was lost"
            return observed["alive"]

        assert observe() == [current], "first boundary must observe real child termination"
        # Fault-inject PID reuse only after actual death was observed. The fresh
        # instance at that live PID must remain visible, never hidden by retirement.
        retired["pid"] = current["pid"]
        (records / "retired.json").write_text(json.dumps(retired))
        assert observe() == [current], "a retired instance was revived by a reused PID"
        if os.name == "nt":
            # No death receipt exists for this instance: birth identity must
            # reject reuse even when no census observed the PID between lives.
            (records / "unobserved.json").write_text(json.dumps(
                dict(retired, instance="unobserved")))
            assert observe() == [current], "an unobserved retired birth was revived by PID reuse"
print("fixture lifetime contract passed")
`,
      process.execPath,
      ciCheckoutFixture,
      fileURLToPath(new URL("./fixtures/ci-windows-process-census.py", import.meta.url)),
      new URL("./fixtures/ci-windows-process-census.mjs", import.meta.url).href,
      fileURLToPath(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("fixture lifetime contract passed");
});

it.skipIf(process.platform === "win32")(
  "recognizes terminated POSIX groups without accepting live signal denials",
  () => {
    const owner = readFileSync(".github/actions/git-owner/owner.py", "utf8");
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-c",
        String.raw`
import ast, contextlib, errno, io, json, os, pathlib, re, signal, subprocess, sys, tempfile, time

# Load only the actual boundary functions; never execute checkout or real Git.
functions = [node for node in ast.parse(sys.stdin.read()).body
             if isinstance(node, ast.FunctionDef) and node.name in ("group_alive", "group_signal", "group_states", "drain")]
exec(compile(ast.Module(body=functions, type_ignores=[]), "checkout-owner.py", "exec"))
cleanup_seconds = 10

# Retain the Popen handle without polling, so the owned zombie cannot be reaped or reused.
with subprocess.Popen([sys.executable, "-I", "-S", "-c", "pass"], start_new_session=True) as child:
    deadline = time.monotonic() + 10
    while True:
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(child.pid)],
                               check=True, capture_output=True, text=True).stdout.strip()
        if state.startswith("Z"):
            break
        assert time.monotonic() < deadline, "owned child did not terminate"
        time.sleep(0.01)
    assert not group_alive(child.pid, deadline), "zombies are terminated, not checkout writers"
    group_signal(child.pid, signal.SIGTERM, deadline)
    group_signal(child.pid, signal.SIGKILL, deadline)
    with tempfile.TemporaryDirectory(prefix="checkout-zombie-") as directory, contextlib.ExitStack() as cleanup:
        root = pathlib.Path(directory).resolve()
        (root / "workspace").mkdir()
        (root / "pids").mkdir()
        (root / "lease").write_text("owned")
        lease_owner = cleanup.enter_context(subprocess.Popen([
            sys.argv[1], sys.argv[2], "lease-owner", str(root), "standalone"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True))
        def close_lease_owner():
            lease_owner.communicate(timeout=4)
            assert lease_owner.returncode == 0, "lease owner failed during retirement"
        cleanup.callback(close_lease_owner)
        assert lease_owner.stdout.readline().strip() == "ready", "lease owner failed to initialize"
        for pid, role, attempt in [(child.pid, "grandchild", 1), (os.getpid(), "sentinel", 0)]:
            (root / "pids" / f"{pid}.json").write_text(json.dumps(dict(pid=pid, role=role, attempt=attempt, instance=str(pid))))
        subprocess.run([sys.argv[1], sys.argv[2], "git", str(root), "early-leader-exit",
                        "-C", str(root / "workspace"), "checkout"], cwd=root / "workspace", check=True)
        observed = json.loads((root / "events.jsonl").read_text())
        assert observed["alive"] == [], "fixture counted a terminated zombie as a live writer"
        assert observed["sentinelAlive"]

# Reap the session/group leader while its real descendant still owns the pipe.
# A PID-only query or Darwin's legacy -g must not lose that remaining writer.
with subprocess.Popen([sys.executable, "-I", "-S", "-c", """
import os, sys
if os.fork():
    os._exit(0)
print(os.getpid(), os.getpgrp(), os.getsid(0), flush=True)
sys.stdin.read()
"""], start_new_session=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as child:
    descendant, pgid, sid = map(int, child.stdout.readline().split())
    assert descendant != child.pid and pgid == sid == child.pid
    child.wait(timeout=2)
    actual_run = subprocess.run
    command_mode = os.environ.get("COMMAND_MODE")
    def scoped_census(command, **options):
        assert "-g" in command and command[command.index("-g") + 1] == str(pgid), "owner census must select its owned group/session"
        assert not set(command) & {"-a", "-A", "-e", "-x", "-axo", "-p"}, "owner census broadened or lost descendants"
        result = actual_run(command, **options)
        assert result.returncode == 0 and result.stderr == ""
        assert [int(line.split()[0]) for line in result.stdout.splitlines()] == [pgid]
        return result
    try:
        subprocess.run = scoped_census
        for mode in ("legacy", "unix2003"):
            os.environ["COMMAND_MODE"] = mode
            assert group_alive(pgid, time.monotonic() + 2), "reaped leader hid a live descendant"
            assert os.environ["COMMAND_MODE"] == mode, "query changed its owner's environment"
    finally:
        subprocess.run = actual_run
        if command_mode is None:
            os.environ.pop("COMMAND_MODE", None)
        else:
            os.environ["COMMAND_MODE"] = command_mode
        child.communicate(timeout=2)
    deadline = time.monotonic() + 2
    while group_alive(pgid, deadline):
        assert time.monotonic() < deadline, "descendant survived pipe closure"
        time.sleep(0.01)

# A denied signal is safe to normalize only if the same census proves extinction.
with subprocess.Popen([sys.executable, "-I", "-S", "-c",
                       "import sys; print('ready', flush=True); sys.stdin.read()"],
                      start_new_session=True, stdin=subprocess.PIPE,
                      stdout=subprocess.PIPE, text=True) as child:
    assert child.stdout.readline().strip() == "ready"
    actual_killpg = os.killpg
    def denied(pgid, signum):
        assert pgid == child.pid and signum in (0, signal.SIGTERM)
        raise PermissionError(errno.EPERM, "test-owned signal denial")
    actual_run = subprocess.run
    try:
        for probe in (actual_killpg, denied):
            os.killpg = probe
            for code, output, diagnostic in [
                (1, "", ""), (0, "", ""), (0, " \n", ""), (2, "", ""), (-9, "", ""),
                (1, f"{child.pid} Z\n", ""),
                (0, f"{child.pid} Z\n", "injected census diagnostic\n"),
                (1, "", "injected census diagnostic\n"),
                ("timeout", "", "injected census diagnostic\n"),
                (0, f"{child.pid} Z\nbroken\n", ""),
                (0, f"{child.pid} S\nbroken\n", ""),
                (0, f"{child.pid} Z", ""),
                (0, f"{os.getpgrp()} S\n", ""),
                (0, "invalid Z\n", ""),
                (0, f"{child.pid} Zbogus\n", ""),
                (0, f"{child.pid} Z extra\n", ""),
            ]:
                def census_result(command, **options):
                    if code == "timeout":
                        raise subprocess.TimeoutExpired(command, options["timeout"], stderr=diagnostic.encode())
                    result = subprocess.CompletedProcess(command, code, output, diagnostic)
                    if options.get("check"):
                        result.check_returncode()
                    return result
                subprocess.run = census_result
                captured = io.StringIO()
                with contextlib.redirect_stderr(captured):
                    try:
                        group_alive(child.pid, time.monotonic() + 2)
                    except (RuntimeError, ValueError, PermissionError, subprocess.SubprocessError):
                        pass
                    else:
                        raise AssertionError(f"ambiguous census accepted: {(code, output, diagnostic)!r}")
                assert captured.getvalue() == diagnostic, "census lost its diagnostic"
    finally:
        subprocess.run = actual_run
        os.killpg = actual_killpg
    os.killpg = denied
    try:
        try:
            group_signal(child.pid, signal.SIGTERM, time.monotonic() + 10)
        except PermissionError:
            pass
        else:
            raise AssertionError("live denied group was accepted as terminated")
    finally:
        os.killpg = actual_killpg
    # Force the real probe/query race: the group exists at killpg(0), then exits
    # before native ps selects it. Only the subsequent native ESRCH proves absence.
    def census_after_exit(command, **options):
        child.communicate(timeout=2)
        result = actual_run(command, **options)
        assert result.returncode == 1 and result.stdout == result.stderr == ""
        return result
    try:
        subprocess.run = census_after_exit
        assert not group_alive(child.pid, time.monotonic() + 2)
    finally:
        subprocess.run = actual_run
if sys.platform == "darwin":
    # Replay the native EPERM + ?E exit window while retaining a real owned child.
    # Exiting is still pending: only the subsequent native census permits drain to return.
    with subprocess.Popen([sys.executable, "-I", "-S", "-c",
                           "import sys; print('ready', flush=True); sys.stdin.read()"],
                          start_new_session=True, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True) as child:
        assert child.stdout.readline().strip() == "ready"
        exiting = False
        observed_exiting = 0
        native_probes = 0
        actual_killpg = os.killpg
        actual_run = subprocess.run
        def terminating_signal(pgid, signum):
            global exiting, native_probes
            assert pgid == child.pid
            if signum == signal.SIGTERM:
                actual_killpg(pgid, signal.SIGKILL)
                exiting = True
            if exiting:
                raise PermissionError(errno.EPERM, "owned group is exiting")
            if signum == 0:
                native_probes += 1
            return actual_killpg(pgid, signum)
        def exiting_census(command, **options):
            global exiting, observed_exiting
            if exiting:
                observed_exiting += 1
                exiting = observed_exiting < 2
                return subprocess.CompletedProcess(command, 0, f"{child.pid} ?E  \n", "")
            return actual_run(command, **options)
        try:
            os.killpg = terminating_signal
            subprocess.run = exiting_census
            drain(child, None)
            assert observed_exiting == 2, "drain did not wait through the exiting process window"
            assert native_probes, "drain accepted exiting as proof of termination"
            assert child.returncode is not None, "drain returned before the owned child settled"
            assert not group_alive(child.pid, time.monotonic() + 2)
        finally:
            os.killpg = actual_killpg
            subprocess.run = actual_run
print("group contract passed")
`,
        process.execPath,
        ciCheckoutFixture,
      ],
      { input: owner, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("group contract passed");
  },
);

const diagnosticSecret = "synthetic-diagnostic-secret";
const diagnosticPrefix = "[ci-git-owner] diagnostic=";

function runOwnerDiagnostic(policy: string) {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-S", path.resolve(".github/actions/git-owner/owner.py"), "--policy", "-"],
    {
      input: `import ci_git_owner as owner, os, sys
secret = ${JSON.stringify(diagnosticSecret)}
sys.argv.append(secret)
os.environ["OWNER_DIAGNOSTIC_SECRET"] = secret
${policy}`,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(125);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain(diagnosticSecret);
  expect(result.stderr).not.toContain(process.cwd());
  expect(result.stderr).not.toContain("Traceback");
  const lines = result.stderr.trim().split(/\r?\n/u);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(
    /^::error::Git ownership\/setup failed \([A-Za-z]+\); refusing reuse or retry$/u,
  );
  expect(lines[1]?.startsWith(diagnosticPrefix)).toBe(true);
  expect(result.stderr.length).toBeLessThan(4_096);
  return { annotation: lines[0], diagnostic: lines[1]!.slice(diagnosticPrefix.length) };
}

it.each([
  {
    scenario: "timeout context",
    setup: "error.__context__ = owner.FetchTimeout()",
    types: ["PermissionError", "FetchTimeout"],
  },
  {
    scenario: "explicit cause before context",
    setup: "error.__cause__ = owner.FetchTimeout()\nerror.__context__ = ValueError(secret)",
    types: ["PermissionError", "FetchTimeout"],
  },
  {
    scenario: "cyclic context",
    setup: "error.__context__ = error",
    types: ["PermissionError"],
  },
  {
    scenario: "bounded context",
    setup:
      "cursor = error\nfor _ in range(8):\n    cursor.__context__ = RuntimeError(secret)\n    cursor = cursor.__context__",
    types: ["PermissionError", "RuntimeError", "RuntimeError", "RuntimeError"],
  },
])("retains bounded terminal diagnostics: $scenario", ({ scenario, setup, types }) => {
  const { diagnostic } = runOwnerDiagnostic(`
error = PermissionError(13, secret, secret + "/private-path")
error.winerror = 5
${setup}
raise error
`);
  const chain = JSON.parse(diagnostic) as { type: string; via: string; owner_frames: unknown[] }[];
  expect(chain.map((record) => record.type)).toEqual(types);
  expect(chain.map((record) => record.via)).toEqual([
    "terminal",
    ...types.slice(1).map(() => (scenario.startsWith("explicit") ? "cause" : "context")),
  ]);
  expect(chain[0]).toEqual({
    type: "PermissionError",
    via: "terminal",
    errno: 13,
    winerror: 5,
    owner_frames: [
      { function: "<module>", line: expect.any(Number) },
      { function: "main", line: expect.any(Number) },
    ],
  });
  for (const record of chain.slice(1)) {
    expect(record).toEqual({ type: record.type, via: record.via, owner_frames: [] });
  }
});

it.each([
  { errno: "secret", winerror: "True" },
  { errno: "2 ** 100", winerror: "-(2 ** 100)" },
  { errno: "type('NumericSecret', (int,), {})(13)", winerror: "None" },
])("redacts terminal diagnostic metadata ($errno, $winerror)", ({ errno, winerror }) => {
  const { annotation, diagnostic } = runOwnerDiagnostic(`
error = type(secret, (Exception,), {"__module__": "builtins"})(secret)
error.errno, error.winerror = ${errno}, ${winerror}
# Even the owner's filename and globals cannot turn policy code into owner source.
owner.diagnostic_error = error
exec(compile("def synthetic_diagnostic_secret():\\n    raise diagnostic_error\\nsynthetic_diagnostic_secret()",
             owner.__file__, "exec"), vars(owner))
`);
  expect(annotation).toContain("(unknown)");
  expect(JSON.parse(diagnostic)).toEqual([
    {
      type: "unknown",
      via: "terminal",
      owner_frames: [
        { function: "<module>", line: expect.any(Number) },
        { function: "main", line: expect.any(Number) },
      ],
    },
  ]);
});

it("bounds terminal diagnostics to the last six actual owner frames", () => {
  const { diagnostic } = runOwnerDiagnostic(`
import io, sys
owner.diagnostic_depth = 0
owner.diagnostic_policy = '''import ci_git_owner as owner, io, sys
owner.diagnostic_depth += 1
if owner.diagnostic_depth == 12:
    raise ValueError("synthetic-diagnostic-secret")
sys.stdin = io.StringIO(owner.diagnostic_policy)
owner.main()
'''
sys.stdin = io.StringIO(owner.diagnostic_policy)
owner.main()
`);
  expect(JSON.parse(diagnostic)).toEqual([
    {
      type: "ValueError",
      via: "terminal",
      owner_frames: Array.from({ length: 6 }, () => ({
        function: "main",
        line: expect.any(Number),
      })),
    },
  ]);
});

it.each(["raises", "malformed traceback"])(
  "keeps terminal exit 125 with %s metadata and cyclic context",
  (fault) => {
    const { diagnostic } = runOwnerDiagnostic(`
class BrokenMetadata(Exception):
    def __getattribute__(self, name):
        if name == "errno" and ${JSON.stringify(fault)} == "raises":
            raise SystemExit(42)
        if name == "__traceback__" and ${JSON.stringify(fault)} == "malformed traceback":
            return self
        return super().__getattribute__(name)
error = BrokenMetadata(secret)
error.__context__ = error
raise error
`);
    expect(diagnostic).toBe("unavailable");
  },
);

it.each([...(process.platform === "win32" ? ["setup"] : []), "launch", "timeout-drain"])(
  "distinguishes terminal diagnostic failure sites: %s",
  (site) => {
    const { diagnostic } = runOwnerDiagnostic(String.raw`
import os, shlex, subprocess, sys, tempfile
site = ${JSON.stringify(site)}
if os.name == "nt":
    import ctypes as c
    from ctypes import wintypes as w
    kernel = c.WinDLL("kernel32", use_last_error=True)
    duplicate = kernel.DuplicateHandle
    duplicate.argtypes = [w.HANDLE, w.HANDLE, w.HANDLE, c.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD]
    duplicate.restype = w.BOOL
    current = kernel.GetCurrentProcess
    current.argtypes, current.restype = [], w.HANDLE
    def restricted_call(actual, rights, *args):
        handle = w.HANDLE()
        if not duplicate(current(), args[0], current(), c.byref(handle), rights, False, 0):
            raise c.WinError(c.get_last_error())
        try:
            return actual(handle, *args[1:])
        finally:
            owner.close_handle(handle)
    if site == "setup":
        actual = owner.set_job
        owner.set_job = lambda *args: restricted_call(actual, 0x4, *args)
    elif site == "timeout-drain":
        actual = owner.query_job
        owner.query_job = lambda *args: restricted_call(actual, 0x8, *args)
elif site == "timeout-drain":
    actual_drain = owner.drain
    def denied_drain(*args):
        actual_drain(*args)
        raise PermissionError(13, secret)
    owner.drain = denied_drain

# No files are created or removed after deliberately unverified Job cleanup.
directory = tempfile.gettempdir()
if site == "launch":
    actual_popen = subprocess.Popen
    def invalid_executable(*args, **kwargs):
        kwargs["executable"] = directory
        return actual_popen(*args, **kwargs)
    subprocess.Popen = invalid_executable
alias = "!" + shlex.join([sys.executable.replace("\\", "/"), "-I", "-S", "-c", "import time; time.sleep(30)"])
owner.run_git(directory, "-c", "alias.diagnostic=" + alias, "diagnostic", timeout=0.1,
              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`);
    const chain = JSON.parse(diagnostic) as {
      type: string;
      errno?: number;
      winerror?: number;
      owner_frames: { function: string; line: number }[];
    }[];
    expect(chain.map((record) => record.type)).toEqual(
      site === "timeout-drain"
        ? ["RuntimeError", "PermissionError", "FetchTimeout"]
        : ["PermissionError"],
    );
    const denial = expectDefined(
      chain.find((record) => record.type === "PermissionError"),
      "recorded permission denial",
    );
    expect(denial.errno).toBe(13);
    expect(denial.winerror).toBe(process.platform === "win32" ? 5 : undefined);
    expect(denial.owner_frames.map((frame) => frame.function)).toContain("run_git");
    expect(denial.owner_frames.some((frame) => frame.function === "drain")).toBe(
      process.platform === "win32" && site === "timeout-drain",
    );
    const windowsDrain = process.platform === "win32" && site === "timeout-drain";
    expect(denial.owner_frames.some((frame) => frame.function === "job_members")).toBe(
      windowsDrain,
    );
    for (const frame of chain.flatMap((record) => record.owner_frames)) {
      expect(Number.isInteger(frame.line) && frame.line > 0).toBe(true);
      expect([
        "<module>",
        "main",
        "run_git",
        "drain",
        ...(windowsDrain ? ["job_members"] : []),
      ]).toContain(frame.function);
    }
  },
);
