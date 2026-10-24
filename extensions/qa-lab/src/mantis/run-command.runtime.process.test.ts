import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { removeMantisWorktree } from "./run-cleanup.runtime.js";
import { defaultMantisCommandRunner } from "./run-command.runtime.js";
import { captureMantisDirectoryOwnership } from "./run-directory.runtime.js";
import { successfulCommandResult } from "./run.test-support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it.skipIf(process.platform === "win32")(
  "settles successful command descendants before returning ownership to worktree cleanup",
  async () => {
    const cwd = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "mantis-command-owner-")),
    );
    roots.push(cwd);
    const pidFile = path.join(cwd, "descendant.pid");
    const childScript = `
      const fs = require("node:fs");
      fs.writeFileSync(process.argv[1], String(process.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const parentScript = `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { stdio: "ignore" });
      child.unref();
      const ready = setInterval(() => {
        if (fs.existsSync(process.argv[2])) {
          clearInterval(ready);
        }
      }, 5);
    `;
    let descendantPid: number | undefined;
    try {
      const result = await defaultMantisCommandRunner(
        process.execPath,
        ["-e", parentScript, childScript, pidFile],
        { cwd, env: process.env, stage: "qa", timeoutMs: 5000 },
      );
      descendantPid = Number(await fs.readFile(pidFile, "utf8"));
      expect(result.code).toBe(0);
      let running = true;
      try {
        const stat = await fs.readFile(`/proc/${descendantPid}/stat`, "utf8");
        running = !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
      } catch (error) {
        if (process.platform !== "linux") {
          try {
            process.kill(descendantPid, 0);
          } catch {
            running = false;
          }
        } else if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          running = false;
        } else {
          throw error;
        }
      }
      expect(running).toBe(false);
    } finally {
      descendantPid ??= Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* Already retired. */
        }
      }
    }
  },
  10000,
);

it("retains uncertain Git removal without starting another verification command", async () => {
  const repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mantis-git-owner-")));
  roots.push(repoRoot);
  const worktreeDir = path.join(repoRoot, "worktree");
  await fs.mkdir(worktreeDir);
  const ownership = await captureMantisDirectoryOwnership({ directoryPath: worktreeDir, repoRoot });
  const commands: string[] = [];
  const removal = removeMantisWorktree({
    commandTimeouts: {
      build: 1000,
      install: 1000,
      qa: 1000,
      "worktree-add": 1000,
      "worktree-cleanup": 1000,
    },
    lane: "baseline",
    ownership,
    repoRoot,
    worktreeDir,
    runner: async (_command, args) => {
      commands.push(args[1] ?? "");
      return {
        ...successfulCommandResult(),
        cleanup: args[1] === "remove" ? "uncertain" : "normal",
      };
    },
  });
  await expect(removal).rejects.toThrow("command process cleanup is uncertain");
  expect(commands).toEqual(["remove"]);
  await expect(fs.stat(worktreeDir)).resolves.toBeDefined();
});
