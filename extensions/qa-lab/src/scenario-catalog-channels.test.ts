import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { extractToolPayload } from "openclaw/plugin-sdk/tool-payload";
import { afterEach, describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioFile,
} from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { recentOutboundSummary } from "./suite-runtime-transport.js";
import { projectQaToolActivity } from "./tool-activity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runFanoutScenario(
  options: {
    receipt?:
      | "missing"
      | "failed"
      | "unlinked"
      | "same-child"
      | "wrong-label"
      | "missing-run"
      | "same-run";
    providerMode?: "live-frontier" | "mock-openai";
    reply?: string;
    completion?: "unfinished" | "failed" | "wrong-run" | "yielded" | "empty" | "wrong-result";
  } = {},
) {
  const providerMode = options.providerMode ?? "live-frontier";
  return runLoadedScenarioFlow("subagent-fanout-synthesis", {
    api: {
      env: {
        providerMode,
      },
      readSessionToolActivity: async (_env: unknown, sessionKey: string) => {
        const attempt = sessionKey.split(":")[3];
        const messages = ["alpha", "beta"].flatMap((worker) => {
          const isBeta = worker === "beta";
          const callId = `spawn-${worker}`;
          const call = {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: callId,
                name: "sessions_spawn",
                arguments: {
                  label:
                    options.receipt === "wrong-label" && isBeta
                      ? "unrelated"
                      : `qa-fanout-${worker}${providerMode === "mock-openai" ? "" : `-${attempt}`}`,
                  cleanup: "delete",
                },
              },
            ],
          };
          const result = {
            role: "toolResult",
            toolName: "sessions_spawn",
            toolCallId: options.receipt === "unlinked" && isBeta ? "unrelated" : callId,
            isError: options.receipt === "failed" && isBeta,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: options.receipt === "failed" && isBeta ? "error" : "accepted",
                  childSessionKey: `agent:qa:subagent:${options.receipt === "same-child" ? "alpha" : worker}`,
                  runId:
                    options.receipt === "missing-run" && isBeta
                      ? undefined
                      : `run-${options.receipt === "same-run" ? "alpha" : worker}`,
                }),
              },
            ],
          };
          return options.receipt === "missing" && isBeta ? [call] : [call, result];
        });
        return projectQaToolActivity(messages);
      },
      waitForAgentRun: async (_env: unknown, runId: string) => {
        const completion = runId === "run-beta" ? options.completion : undefined;
        if (completion === "unfinished") {
          return { runId, status: "timeout" };
        }
        const reply =
          providerMode === "mock-openai" ? (runId === "run-alpha" ? "ALPHA-OK" : "BETA-OK") : "ok";
        return {
          runId: completion === "wrong-run" ? "unrelated-run" : runId,
          status: completion === "failed" ? "error" : "ok",
          endedAt: 200,
          ...(completion === "yielded" ? { yielded: true } : {}),
          terminalReply:
            completion === "empty"
              ? { disposition: "empty" }
              : {
                  disposition: "visible",
                  text: completion === "wrong-result" ? "ALPHA-OK" : reply,
                },
        };
      },
      startAgentRun: async () => ({ runId: "parent-run" }),
      waitForAgentHistoryReply: async (
        _env: unknown,
        _sessionKey: string,
        matches: (text: string) => boolean,
      ) => {
        const text = options.reply ?? "subagent-1: ok\nsubagent-2: ok";
        if (!matches(text)) {
          throw new Error("parent synthesis missing");
        }
        return { text };
      },
      // Delete-cleanup retires these rows after the requester has consumed both results.
      readNativeQaSubagentRuns: async () => [],
      extractQaToolPayload: extractToolPayload,
      normalizeLowercaseStringOrEmpty,
      formatErrorMessage: (error: Error) => error.message,
    },
  });
}

describe("qa scenario catalog channel contracts", () => {
  const agentRuntime = "agent-runtime";

  it("keeps the memory channel-context proof on the internal QA channel", () => {
    expect(readQaScenarioById("memory-tools-channel-context").execution.channel).toBe("qa-channel");
  });

  it("keeps channel participant identity proof on isolated QA Channel lifecycle owners", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("channel-participant-identity-inspection"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.channel).toBe("qa-channel");
    expect(scenario.execution.suiteIsolation).toBe("isolated");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      logging: { audit: { executionIdentity: true } },
      messages: { queue: { mode: "collect", debounceMsByChannel: { "qa-channel": 1000 } } },
      channels: { "qa-channel": { groupPolicy: "allowlist" } },
    });
    expect(flow).toContain("inspectQaExecutionIdentityStorage");
    expect(flow).toContain("env.gateway.restartAfterStateMutation");
  });

  it("keeps stored inbound audio proof on the real QA Channel and Gateway flow", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("inbound-media-store-audio-transcription"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.coverage?.primary).toEqual(["media.inbound-media-store"]);
    expect(scenario.coverage?.secondary).toEqual(["channels.inbound-media-normalization"]);
    expect(scenario.plugins).toContain("openai");
    expect(scenario.execution.channel).toBe("qa-channel");
    expect(scenario.execution.providerMode).toBe("mock-openai");
    expect(flow).toContain('"sendInbound"');
    expect(flow).toContain('"contentBase64"');
    expect(flow).toContain('"mediaFactCarrier":"media-store-url"');
    expect(flow).toContain("String(candidate.text ?? '').trim() === config.expectedMarker");
    expect(flow).toContain("String(message.text ?? '').trim() === config.expectedMarker");
    expect(flow).toContain("conversationOutbound.length === 1");
    expect(flow).not.toContain(".includes(config.expectedMarker)");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      tools: { media: { audio: { echoTranscript: false } } },
    });
    expect(flow).not.toContain('"call":"runAgentPrompt"');
  });

  it("binds current-source thread receipt proof to the QA Gateway lane", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("thread-reply-current-source-delivery"),
    );
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.execution.channel).toBe("qa-channel");
    expect(scenario.gatewayConfigPatch).toMatchObject({
      messages: { groupChat: { visibleReplies: "automatic" } },
      tools: { alsoAllow: ["message"] },
      agents: { entries: { qa: { tools: { alsoAllow: ["message"] } } } },
    });
    expect(scenario.execution.config).toMatchObject({ duplicateWindowMs: 2000 });
    expect(flow).toContain("request.plannedToolArgs?.action === 'thread-reply'");
    expect(flow).toContain("readSessionTranscriptSummary");
    expect(flow).toContain("summary.currentSourceToolDeliveries?.find");
    expect(flow).toContain("turnOutbound.length === 1");
    expect(flow).toContain("divergentOutbound.length === 2");
    expect(flow).toContain("return messages.length === 2 ? messages : undefined");
    expect(flow).toContain("QA-THREAD-RECEIPT-TOOL-OK");
    expect(flow).toContain("QA-THREAD-RECEIPT-FINAL-OK");
  });

  it("isolates scenarios that own asynchronous transport state", () => {
    const channelBaseline = requireFlowScenario(readQaScenarioById("channel-chat-baseline"));
    const subagentFanout = requireFlowScenario(readQaScenarioById("subagent-fanout-synthesis"));

    expect(channelBaseline.execution.suiteIsolation).toBe("isolated");
    expect(subagentFanout.execution.suiteIsolation).toBe("isolated");
  });

  it.each(["live-frontier", "mock-openai"] as const)(
    "accepts %s fanout after delete-cleanup retires native child rows",
    async (providerMode) => {
      await expect(runFanoutScenario({ providerMode })).resolves.toMatchObject({ status: "pass" });
    },
  );

  it("rejects beta completing with alpha's mock result", async () => {
    await expect(
      runFanoutScenario({ providerMode: "mock-openai", completion: "wrong-result" }),
    ).rejects.toThrow("child completion missing");
  });

  it.each([
    "missing",
    "failed",
    "unlinked",
    "same-child",
    "wrong-label",
    "missing-run",
    "same-run",
  ] as const)("rejects %s spawn evidence despite matching parent synthesis", async (receipt) => {
    await expect(runFanoutScenario({ receipt })).rejects.toThrow("test condition was not met");
  });

  it.each(["unfinished", "failed", "wrong-run", "yielded", "empty", "wrong-result"] as const)(
    "rejects %s child completion despite accepted spawns and matching parent synthesis",
    async (completion) => {
      await expect(runFanoutScenario({ completion })).rejects.toThrow("child completion missing");
    },
  );

  it.each(["subagent-1: ok", "still waiting: subagent-1: ok\nsubagent-2: ok"])(
    "rejects incomplete parent synthesis %j despite accepted spawns",
    async (reply) => {
      await expect(runFanoutScenario({ reply })).rejects.toThrow("parent synthesis missing");
    },
  );

  it("settles terminal-reply scenarios from native run facts instead of sleeps", () => {
    const scenario = requireFlowScenario(readQaScenarioById("subagent-completion-direct-fallback"));
    const flow = JSON.stringify(scenario.execution.flow);
    const config = scenario.execution.config as
      | {
          requiredProviderMode?: string;
          cases?: Array<{ name?: string; marker?: string; expectedSendCount?: number }>;
        }
      | undefined;

    expect(scenario.execution.providerMode).toBe("mock-openai");
    expect(config?.requiredProviderMode).toBe("mock-openai");
    expect(config?.cases).toEqual([
      {
        name: "visible",
        marker: "QA-SUBAGENT-TERMINAL-VISIBLE-OK",
        expectedSendCount: 1,
      },
      {
        name: "silent",
        marker: "QA-SUBAGENT-TERMINAL-SILENT-REPRESENTED",
        expectedSendCount: 1,
      },
      {
        name: "fallback",
        marker: "QA-SUBAGENT-TERMINAL-FALLBACK-OK",
        expectedSendCount: 1,
      },
    ]);
    expect(flow).toContain("readNativeQaSubagentRuns(env)");
    expect(flow).not.toContain("tasks.list");
    expect(flow).toContain("run.label === `qa-terminal-${caseName}`");
    expect(flow).toContain("terminalRun.execution.status === 'terminal'");
    expect(flow).toContain("run.delivery?.status === 'delivered'");
    expect(flow).toContain("readSettledTerminalRun('restart')");
    expect(flow).toContain("postRestartUnexpectedPayloads.length === 0");
    expect(flow).toContain("env.providerMode === config.requiredProviderMode");
    expect(flow).not.toContain("interrupted by a gateway restart");
    expect(flow).toContain("verdicts.length === 5");
    expect(flow).not.toContain('"call":"sleep"');
  });

  it("keeps channel streaming evidence on QA Channel", () => {
    const scenario = requireFlowScenario(readQaScenarioById("channel-message-flows"));

    expect(scenario.execution.channel).toBeUndefined();
    expect(scenario.execution.channels).toEqual(["qa-channel"]);
    expect(scenario.execution.retryCount).toBe(0);
    expect(scenario.coverage?.primary).toEqual(["channels.streaming-final-reply"]);
    expect(scenario.coverage?.secondary).toEqual([`${agentRuntime}.streaming-replies-delivery`]);
    expect(scenario.gatewayConfigPatch).toBeUndefined();
  });

  it("keeps the shared channel canary eligible for its supported channels", () => {
    const scenario = requireFlowScenario(readQaScenarioById("channel-canary"));

    expect(scenario.execution.channels).toEqual(["qa-channel"]);
  });

  it.each([
    {
      label: "accepts only the authorized driver reply",
      observerReplies: false,
      driverReplies: true,
      expectedFailure: null,
    },
    {
      label: "rejects an observer reply when the authorized driver never replies",
      observerReplies: true,
      driverReplies: false,
      expectedFailure: "waiting for outbound marker",
    },
    {
      label: "rejects a late observer reply even when the authorized driver replies",
      observerReplies: true,
      driverReplies: true,
      expectedFailure: "blocked sender replied",
    },
  ])("$label", async ({ observerReplies, driverReplies, expectedFailure }) => {
    const state = createQaBusState();
    const result = runLoadedScenarioFlow("channel-sender-allowlist", {
      state,
      api: { recentOutboundSummary },
      onWaitForOutboundMessage: ({ state: currentState }) => {
        for (const [senderId, replies] of [
          ["observer", observerReplies],
          ["driver", driverReplies],
        ] as const) {
          if (!replies) {
            continue;
          }
          const inbound = currentState
            .getSnapshot()
            .messages.find(
              (message) => message.direction === "inbound" && message.senderId === senderId,
            );
          if (!inbound) {
            throw new Error(`missing ${senderId} inbound message`);
          }
          const marker = inbound.text.split("reply exactly: ")[1];
          if (!marker) {
            throw new Error(`missing ${senderId} requested reply marker`);
          }
          currentState.addOutboundMessage({
            accountId: "qa-channel",
            to: "group:qa-routing-allowlist",
            replyToId: inbound.id,
            text: marker,
          });
        }
      },
    });

    if (expectedFailure) {
      await expect(result).rejects.toThrow(expectedFailure);
    } else {
      await expect(result).resolves.toMatchObject({ status: "pass" });
    }

    const snapshot = state.getSnapshot();
    const senderIdsByInboundId = new Map(
      snapshot.messages
        .filter((message) => message.direction === "inbound")
        .map((message) => [message.id, message.senderId]),
    );
    expect(
      snapshot.messages
        .filter((message) => message.direction === "outbound")
        .map((message) => senderIdsByInboundId.get(message.replyToId ?? "")),
    ).toEqual([...(observerReplies ? ["observer"] : []), ...(driverReplies ? ["driver"] : [])]);
  });

  it("rejects malformed string matcher lists before running a flow", async () => {
    const filePath = path.join(tempDirs.make("qa-catalog-"), "scenario.yaml");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        title: "Malformed matcher",
        scenario: {
          id: "malformed-matcher",
          surface: "qa",
          execution: {
            kind: "flow",
            config: { gracefulFallbackAny: [{ confirmed: "the hidden fact is present" }] },
          },
        },
        flow: { steps: [{ name: "validate", actions: [{ assert: "true" }] }] },
      }),
    );
    expect(() => readQaScenarioFile(filePath)).toThrow(
      /gracefulFallbackAny entries must be strings/,
    );
  });

  it("returns undefined execution config for an unknown scenario id", () => {
    expect(readQaScenarioExecutionConfig("missing-scenario-id")).toBeUndefined();
  });
});
