import { Command } from "commander";
import type { QaRunnerCliContribution } from "openclaw/plugin-sdk/qa-runner-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { listQaRunnerCliContributions } = vi.hoisted(() => ({
  listQaRunnerCliContributions: vi.fn<() => QaRunnerCliContribution[]>(() => []),
}));
vi.mock("openclaw/plugin-sdk/qa-runner-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/qa-runner-runtime")>()),
  listQaRunnerCliContributions,
}));
import { listLiveTransportQaAdapterFactories, listLiveTransportQaCliRegistrations } from "./cli.js";
describe("live transport QA contributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listQaRunnerCliContributions.mockReturnValue([]);
  });
  it("does not register retired built-in lanes without plugin contributions", () => {
    expect(listLiveTransportQaCliRegistrations()).toEqual([]);
    expect(listLiveTransportQaAdapterFactories()).toEqual([]);
  });
  it("preserves an available plugin registration and adapter factory", async () => {
    const run = vi.fn();
    const adapterFactory = { id: "qa-runner-test", matches: () => true, create: vi.fn() };
    const registration = {
      commandName: "runner-test",
      adapterFactory,
      register(qa: Command) {
        qa.command("runner-test").action(run);
      },
    };
    listQaRunnerCliContributions.mockReturnValue([
      { pluginId: "qa-runner-test", commandName: "runner-test", status: "available", registration },
    ]);
    expect(listLiveTransportQaCliRegistrations()).toEqual([registration]);
    expect(listLiveTransportQaAdapterFactories()).toEqual([adapterFactory]);
    const qa = new Command();
    listLiveTransportQaCliRegistrations()[0]!.register(qa);
    await qa.parseAsync(["node", "openclaw", "runner-test"]);
    expect(run).toHaveBeenCalledOnce();
  });
  it("explains how to activate an installed but blocked runner", async () => {
    listQaRunnerCliContributions.mockReturnValue([
      { pluginId: "qa-runner-test", commandName: "runner-test", status: "blocked" },
    ]);
    const qa = new Command();
    listLiveTransportQaCliRegistrations()[0]!.register(qa);
    await expect(qa.parseAsync(["node", "openclaw", "runner-test"])).rejects.toThrow(
      'QA runner "runner-test" is installed but not active. Enable or allow plugin "qa-runner-test"',
    );
    expect(listLiveTransportQaAdapterFactories()).toEqual([]);
  });
});
