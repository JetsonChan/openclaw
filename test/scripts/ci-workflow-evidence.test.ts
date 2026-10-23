import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { TSX_IMPORT, quoteShell, runGit, runWorkflowShellScript } from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TYPESCRIPT_NODE_MODULES = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
);

function writeProtocolDescriptor(
  repo: string,
  additions: Array<{
    name: string;
    since?: string;
    compatibilityRestored?: boolean;
  }> = [],
): void {
  const rows = [{ name: "health", since: "2026.7" }, ...additions].map(
    ({ name, since, compatibilityRestored }) => {
      const sinceProperty = since === undefined ? "" : `, since: ${JSON.stringify(since)}`;
      const compatibilityProperty = compatibilityRestored ? ", compatibilityRestored: true" : "";
      return `  { name: ${JSON.stringify(name)}${sinceProperty}${compatibilityProperty} },`;
    },
  );
  const descriptor = path.join(repo, "src/gateway/methods/core-descriptors.ts");
  mkdirSync(path.dirname(descriptor), { recursive: true });
  writeFileSync(
    descriptor,
    `export const CORE_GATEWAY_METHOD_SPECS = [\n${rows.join("\n")}\n] as const;\n`,
  );
}

function commitProtocolFixture(repo: string, message: string): string {
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-q", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

function createQaProtocolTopology() {
  const root = tempDirs.make("openclaw-qa-protocol-topology-");
  const origin = path.join(root, "origin");
  const checkout = path.join(root, "checkout");
  const releaseBranch = "release/2026.8.1";

  runGit(root, ["init", "-q", "-b", "main", origin]);
  runGit(origin, ["config", "commit.gpgsign", "false"]);
  runGit(origin, ["config", "user.email", "qa-protocol@example.invalid"]);
  runGit(origin, ["config", "user.name", "QA Protocol Fixture"]);
  writeFileSync(
    path.join(origin, "package.json"),
    '{"name":"qa-protocol-fixture","version":"2026.8.0"}\n',
  );
  writeProtocolDescriptor(origin);
  const mainBase = commitProtocolFixture(origin, "base protocol");

  writeProtocolDescriptor(origin, [{ name: "sessions.patchMany", since: "2026.8" }]);
  const mainHead = commitProtocolFixture(origin, "add main protocol method");

  runGit(origin, ["checkout", "-q", "-b", "compatibility/restore", mainBase]);
  writeProtocolDescriptor(origin, [
    {
      name: "gateway.restart.preflight",
      since: "<=2026.7",
      compatibilityRestored: true,
    },
  ]);
  const compatibilityHead = commitProtocolFixture(origin, "restore compatibility method");

  runGit(origin, ["checkout", "-q", "-b", "compatibility/invalid", mainBase]);
  writeProtocolDescriptor(origin, [
    {
      name: "gateway.restart.invalid",
      since: "2026.8",
      compatibilityRestored: true,
    },
  ]);
  const invalidCompatibilityHead = commitProtocolFixture(
    origin,
    "mislabel new method as compatibility",
  );

  runGit(origin, ["checkout", "-q", "-b", releaseBranch, mainBase]);
  writeProtocolDescriptor(origin, [{ name: "sessions.releaseOnly" }]);
  const releaseHead = commitProtocolFixture(origin, "add release protocol method");

  runGit(origin, ["checkout", "-q", "main"]);

  runGit(root, ["clone", "-q", "--no-local", origin, checkout]);

  return {
    checkout,
    compatibilityHead,
    invalidCompatibilityHead,
    mainBase,
    mainHead,
    releaseHead,
  };
}

function runProtocolSinceFixture(checkout: string, baseSha: string) {
  for (const scriptPath of [
    "packages/normalization-core/src/record-coerce.ts",
    "scripts/check-protocol-since.mts",
    "scripts/lib/native-typescript.mts",
    "scripts/lib/repo-root.mjs",
    "scripts/lib/ts-guard-utils.mts",
  ]) {
    const target = path.join(checkout, scriptPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(scriptPath, "utf8"));
  }
  writeFileSync(
    path.join(checkout, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: {
          "@openclaw/normalization-core/record-coerce": [
            "./packages/normalization-core/src/record-coerce.ts",
          ],
        },
      },
    }),
  );
  const nodeModules = path.join(checkout, "node_modules");
  if (!existsSync(nodeModules)) {
    symlinkSync(TYPESCRIPT_NODE_MODULES, nodeModules, "dir");
  }
  return runWorkflowShellScript(
    `${quoteShell(process.execPath)} --import ${quoteShell(TSX_IMPORT)} scripts/check-protocol-since.mts`,
    {
      cwd: checkout,
      env: { ...process.env, PROTOCOL_SINCE_BASE_SHA: baseSha },
    },
  );
}

describe("protocol since guard", () => {
  it.skipIf(process.platform === "win32")(
    "checks new and restored protocol metadata through the real guard",
    () => {
      const topology = createQaProtocolTopology();
      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.mainHead]);
      const mainCheck = runProtocolSinceFixture(topology.checkout, topology.mainBase);
      expect(mainCheck.status, `${mainCheck.stdout}${mainCheck.stderr}`).toBe(0);
      expect(mainCheck.stdout).toContain("1 new core method");

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.compatibilityHead]);
      const compatibilityCheck = runProtocolSinceFixture(topology.checkout, topology.mainBase);
      expect(
        compatibilityCheck.status,
        `${compatibilityCheck.stdout}${compatibilityCheck.stderr}`,
      ).toBe(0);
      expect(compatibilityCheck.stdout).toContain("1 restored compatibility method");

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.invalidCompatibilityHead]);
      const invalidCompatibilityCheck = runProtocolSinceFixture(
        topology.checkout,
        topology.mainBase,
      );
      expect(invalidCompatibilityCheck.status).not.toBe(0);
      expect(invalidCompatibilityCheck.stderr).toContain(
        "restored compatibility methods must retain <= vintage metadata",
      );

      runGit(topology.checkout, ["checkout", "-q", "--detach", topology.releaseHead]);
      const releaseCheck = runProtocolSinceFixture(topology.checkout, topology.mainBase);
      expect(releaseCheck.status).not.toBe(0);
      expect(releaseCheck.stderr).toContain("sessions.releaseOnly is missing since metadata");
    },
  );
});
