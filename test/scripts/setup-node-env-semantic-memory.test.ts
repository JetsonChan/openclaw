import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";

it("keeps privileged provisioning in opted-in Linux CI setup", () => {
  const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
  expect(action.inputs["semantic-checks"].default).toBe("false");
  const setup = action.runs.steps.find((step: { run?: string }) =>
    step.run?.includes("loginctl enable-linger"),
  );
  expect(setup.if).toBe("runner.os == 'Linux' && inputs.semantic-checks == 'true'");
  expect(setup.shell).toBe("bash");
  const script = readFileSync(".github/actions/setup-node-env/semantic-memory.sh", "utf8");
  expect(setup.run).toBe(script.split("\n").slice(1).join("\n"));
  expect(script).toContain("--property=MemoryMax=67108864 --property=MemorySwapMax=0");
  expect(script).toContain("--property=OOMPolicy=kill --property=RuntimeMaxSec=10");
  expect(script).toContain('test "$(cat "/sys/fs/cgroup$group/memory.max")" = 67108864');
  expect(script).toContain('test "$(cat "/sys/fs/cgroup$group/memory.swap.max")" = 0');
  expect(script).toContain('test "$(cat "/sys/fs/cgroup$group/memory.oom.group")" = 1');
});

it.runIf(process.platform !== "win32")("rejects an unsupported runner with setup guidance", () => {
  const script = [
    "ps() { printf 'not-systemd\\n'; }",
    "sudo() { echo 'unexpected sudo' >&2; return 99; }",
    readFileSync(".github/actions/setup-node-env/semantic-memory.sh", "utf8"),
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("::error::Semantic checks require systemd");
  expect(result.stderr).toContain("https://docs.openclaw.ai/ci");
  expect(result.stderr).not.toContain("unexpected sudo");
});
