import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveExecutionSelection, resolveProfileScenarios } = vi.hoisted(() => ({
  resolveExecutionSelection: vi.fn(),
  resolveProfileScenarios: vi.fn(),
}));

vi.mock("../../profile-planning.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../profile-planning.js")>();
  return {
    ...actual,
    resolveQaProfileScenarios: (...args: Parameters<typeof actual.resolveQaProfileScenarios>) => {
      resolveProfileScenarios(...args);
      return actual.resolveQaProfileScenarios(...args);
    },
    resolveQaRunProfileExecutionSelection: (
      ...args: Parameters<typeof actual.resolveQaRunProfileExecutionSelection>
    ) => {
      resolveExecutionSelection(...args);
      return actual.resolveQaRunProfileExecutionSelection(...args);
    },
  };
});

import { scenarioDeclaresQaChannel } from "../../profile-planning.js";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import {
  resolveCatalogLiveTransportQaScenarioIds,
  resolveLiveTransportQaScenarioIds,
  listLiveTransportQaScenarios,
} from "./scenario-selection.js";

const MOCK_LANE = {
  providerMode: "mock-openai" as const,
  primaryModel: "mock-openai/gpt-5.6-luna",
};

describe("live transport QA scenario selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      channelId: "qa-channel",
      select: (scenarioIds?: readonly string[]) =>
        resolveCatalogLiveTransportQaScenarioIds({
          ...MOCK_LANE,
          channelId: "qa-channel",
          scenarioIds,
        }),
    },
  ] as const)(
    "keeps explicit and implicit singleton eligibility aligned for $channelId",
    ({ channelId, select }) => {
      const scenarioIds = select();
      const singletonScenarioIds = scenarioIds.slice(0, 1);
      const scenarioById = new Map(
        readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
      );

      expect(singletonScenarioIds).toHaveLength(1);
      expect(
        scenarioIds.every((scenarioId) => {
          const scenario = scenarioById.get(scenarioId);
          return (
            scenario?.execution.kind === "flow" && scenarioDeclaresQaChannel(scenario, channelId)
          );
        }),
      ).toBe(true);
      expect(select(singletonScenarioIds)).toEqual(singletonScenarioIds);
    },
  );

  it("uses the exact requested model for profile selection and listing", () => {
    const primaryModel = "openai/custom-selection-model";

    expect(() =>
      resolveLiveTransportQaScenarioIds({
        channelId: "qa-channel",
        primaryModel,
        providerMode: "mock-openai",
      }),
    ).toThrow("resolved no executable scenarios");
    expect(resolveProfileScenarios).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionKind: "flow", primaryModel }),
    );

    expect(() =>
      listLiveTransportQaScenarios({
        channelId: "qa-channel",
        primaryModel,
        providerMode: "mock-openai",
      }),
    ).toThrow("resolved no executable scenarios");
    expect(resolveProfileScenarios).toHaveBeenLastCalledWith(
      expect.objectContaining({ executionKind: "flow", primaryModel }),
    );
  });

  it("rejects the shared channel canary on unsupported Discord drivers", () => {
    expect(() =>
      resolveCatalogLiveTransportQaScenarioIds({
        ...MOCK_LANE,
        channelId: "discord",
        channelDriver: "crabline",
        scenarioIds: ["channel-canary"],
      }),
    ).toThrow(
      "selected QA scenario(s) do not match the current QA lane: channel-canary (channel=qa-channel)",
    );
  });
});
