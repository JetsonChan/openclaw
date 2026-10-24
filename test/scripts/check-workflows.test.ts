import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const scriptPath = path.resolve("scripts/check-workflows.mts");
const tempDirs: string[] = [];
const testNodeExecPath = resolveTestNodeExecPath();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("check-workflows", () => {
  it("prints an actionable diagnostic when actionlint and go are unavailable", () => {
    const result = spawnSync(testNodeExecPath, ["--import", "tsx", scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing workflow linter");
    expect(result.stderr).toContain("install actionlint built from");
    expect(result.stderr).toContain("011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7");
  });

  it.each([
    { version: undefined, tool: "go" },
    { version: "1.7.12", tool: "go" },
    { version: "unknown", tool: "pre-commit" },
    { version: "v1.7.13-0.20260419144658-011a6d15e749", tool: "installed" },
    { version: "1.7.12", tool: "pre-commit", acquireStatus: 1 },
    { version: "1.7.12", tool: "go", lintStatus: 7 },
    { version: "1.7.12", tool: "unavailable", lintStatus: 1 },
  ])(
    "selects $tool actionlint for installed version $version ($acquireStatus/$lintStatus)",
    ({ version, tool, acquireStatus = 0, lintStatus = 0 }) => {
      const tempDir = makeTempDir(tempDirs, "check-workflows-");
      const binDir = path.join(tempDir, "bin");
      const markerPath = path.join(tempDir, "go-install.txt");
      const binMarkerPath = path.join(tempDir, "go-bin.txt");
      const pinnedMarkerPath = path.join(tempDir, "pinned-actionlint.txt");
      const preCommitMarkerPath = path.join(tempDir, "pre-commit.txt");
      const actionlintMarkerPath = path.join(tempDir, "actionlint.txt");
      mkdirSync(binDir);
      if (version) {
        writeFileSync(
          path.join(binDir, "actionlint"),
          [
            "#!/bin/sh",
            `if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi`,
            'printf "%s\\n" "$*" > "$ACTIONLINT_MARKER"',
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
      }
      if (tool === "go" || acquireStatus !== 0) {
        writeFileSync(
          path.join(binDir, "pinned-actionlint"),
          [
            "#!/bin/sh",
            'printf "%s\\n" "$*" > "$PINNED_ACTIONLINT_MARKER"',
            `exit ${lintStatus}`,
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        writeFileSync(
          path.join(binDir, "go"),
          [
            "#!/bin/sh",
            'if [ "$1" = "version" ]; then exit 0; fi',
            'if [ "$1" = "install" ]; then',
            '  printf "%s\\n" "$*" > "$GO_FALLBACK_MARKER"',
            '  printf "%s\\n" "$GOBIN" > "$GO_BIN_MARKER"',
            `  if [ ${acquireStatus} != 0 ]; then exit ${acquireStatus}; fi`,
            '  /bin/cp "$PINNED_ACTIONLINT" "$GOBIN/actionlint"',
            "  exit 0",
            "fi",
            "exit 1",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
      }
      if (tool !== "unavailable") {
        writeFileSync(
          path.join(binDir, "pre-commit"),
          [
            "#!/bin/sh",
            'if [ "$1" = "--version" ]; then exit 0; fi',
            'printf "%s\\n" "$*" >> "$PRE_COMMIT_MARKER"',
            "exit 0",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
      }
      for (const command of tool === "unavailable" ? ["node"] : ["python3", "node"]) {
        writeFileSync(path.join(binDir, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }

      const result = spawnSync(testNodeExecPath, ["--import", "tsx", scriptPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          GO_FALLBACK_MARKER: markerPath,
          GO_BIN_MARKER: binMarkerPath,
          PINNED_ACTIONLINT: path.join(binDir, "pinned-actionlint"),
          PINNED_ACTIONLINT_MARKER: pinnedMarkerPath,
          PRE_COMMIT_MARKER: preCommitMarkerPath,
          ACTIONLINT_MARKER: actionlintMarkerPath,
          PATH: binDir,
        },
      });

      expect(result.status).toBe(lintStatus);
      expect(existsSync(actionlintMarkerPath)).toBe(tool === "installed");
      const acquired = tool === "go" || acquireStatus !== 0;
      expect(existsSync(markerPath)).toBe(acquired);
      if (acquired) {
        expect(readFileSync(markerPath, "utf8")).toContain(
          "install github.com/rhysd/actionlint/cmd/actionlint@011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7",
        );
        expect(existsSync(readFileSync(binMarkerPath, "utf8").trim())).toBe(false);
      } else if (tool === "installed") {
        expect(readFileSync(actionlintMarkerPath, "utf8")).toContain(".github/workflows/ci.yml");
      }
      expect(existsSync(pinnedMarkerPath)).toBe(tool === "go");
      if (tool === "go") {
        expect(readFileSync(pinnedMarkerPath, "utf8")).toContain(".github/workflows/ci.yml");
      }
      if (lintStatus !== 0) {
        expect(existsSync(preCommitMarkerPath)).toBe(false);
        if (tool === "unavailable") {
          expect(result.stderr).toContain(
            "missing workflow linter: install actionlint built from 011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7",
          );
          expect(result.stderr).toContain("Go to acquire that revision, or a pre-commit runtime");
        }
        return;
      }
      const preCommitArgs = readFileSync(preCommitMarkerPath, "utf8");
      expect(preCommitArgs.includes(" actionlint --files")).toBe(tool === "pre-commit");
      expect(preCommitArgs).toContain("run --config .pre-commit-config.yaml zizmor --files");
      expect(preCommitArgs).toContain(".github/workflows/ci.yml");
    },
  );

  it.each([
    { mode: "bootstrap", code: 0, errors: [] },
    {
      mode: "old-python",
      code: 1,
      errors: ["python3 is 3.9.6", "pre-commit 4.6.2 requires Python >=3.10"],
    },
    {
      mode: "missing-venv",
      code: 1,
      errors: [
        "python venv unavailable",
        "missing pre-commit runtime for actionlint",
        "Python venv support for pre-commit 4.6.2",
      ],
    },
    { mode: "hook-failure", code: 13, errors: ["hook failed"] },
  ])("handles $mode through the temporary Python runtime", ({ mode, code, errors }) => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const markerPath = path.join(tempDir, "python.txt");
    const venvPath = path.join(tempDir, "venv-path.txt");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      path.join(binDir, "python3"),
      [
        "#!/bin/sh",
        `if [ "$1" = "--version" ]; then printf '%s\\n' '${mode === "old-python" ? "Python 3.9.6" : ""}'; exit 0; fi`,
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ] && [ "$3" = "--version" ]; then exit 1; fi',
        'printf "%s\\n" "$*" >> "$PYTHON_MARKER"',
        'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
        `  if [ '${mode}' = 'missing-venv' ]; then echo 'python venv unavailable' >&2; exit 1; fi`,
        '  /bin/mkdir -p "$3/bin"',
        '  /bin/cp "$0" "$3/bin/python"',
        '  /bin/chmod +x "$3/bin/python"',
        '  printf "%s\\n" "$3" > "$VENV_MARKER"',
        "  exit 0",
        "fi",
        'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then exit 0; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ]; then',
        `  if [ '${mode}' = 'hook-failure' ]; then echo 'hook failed' >&2; exit 13; fi`,
        "  exit 0",
        "fi",
        'if [ "$1" = "scripts/check-composite-action-input-interpolation.py" ]; then exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const result = spawnSync(testNodeExecPath, ["--import", "tsx", scriptPath], {
      encoding: "utf8",
      env: { ...process.env, PATH: binDir, PYTHON_MARKER: markerPath, VENV_MARKER: venvPath },
    });
    expect(result.status).toBe(code);
    for (const error of errors) {
      expect(result.stderr).toContain(error);
    }
    if (mode === "old-python") {
      expect(existsSync(markerPath)).toBe(false);
    } else if (mode === "bootstrap") {
      const pythonArgs = readFileSync(markerPath, "utf8");
      expect(pythonArgs).toContain("-m pip install --disable-pip-version-check pre-commit==4.6.2");
      expect(pythonArgs).toContain(
        "-m pre_commit run --config .pre-commit-config.yaml actionlint --files",
      );
      expect(pythonArgs).toContain(
        "-m pre_commit run --config .pre-commit-config.yaml zizmor --files",
      );
    } else if (mode === "hook-failure") {
      expect(existsSync(readFileSync(venvPath, "utf8").trim())).toBe(false);
    }
  });
});
