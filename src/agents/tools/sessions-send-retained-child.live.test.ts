import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { isLiveTestEnabled } from "../live-test-helpers.js";
import {
  finalReplies,
  history,
  runWithLiveSubagentGateway,
  until,
} from "../subagents/announce/subagent-challenges.live.test-support.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../subagents/registry/subagent-registry-persistence.js";

const enabled = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_RETAINED_CHILD);
const describeLive = enabled ? describe : describe.skip;

describeLive("retained native child continuation", () => {
  it(
    "continues the same child through sessions_send after display retention expires",
    async () => {
      await runWithLiveSubagentGateway(
        { additionalTools: ["sessions_send"], sessionVisibility: "tree" },
        async ({ gateway, start, record, waitForDescendantSettlement }) => {
          const id = randomUUID().replaceAll("-", "");
          const parent = "agent:main:dashboard:retained-parent-" + id;
          const first = "INITIAL_" + id;
          const continued = "CONTINUED_" + id;
          const parentInitial = await start(
            parent,
            [
              'Call sessions_spawn exactly once with runtime "subagent", taskName "retained-child", cleanup "keep", and task: "Reply with exactly ' +
                first +
                '. Do not use tools."',
              "Then call sessions_yield. When the child completion arrives finish with exactly PARENT_INITIAL. Do not start other work.",
            ].join("\n"),
          );
          await until("native child completes", async () => {
            const outcome = await gateway.request<{ status: string }>("agent.wait", {
              runId: parentInitial.runId,
              timeoutMs: 1000,
            });
            return outcome.status === "ok" ? true : undefined;
          });
          await until(
            "parent consumes child completion",
            async () => finalReplies(await history(parent), "PARENT_INITIAL")[0],
          );
          await waitForDescendantSettlement(parent);
          const childRun = [...subagentRuns.values()].find(
            (run) => run.requesterSessionKey === parent,
          );
          expect(childRun?.execution.endedAt).toBeTypeOf("number");
          if (!childRun) {
            throw new Error("Native spawn did not register a child");
          }
          const child = childRun.childSessionKey;
          expect(finalReplies(await history(child), first)).toEqual([first]);
          const described = await gateway.request<{ session: { sessionId: string } }>(
            "sessions.describe",
            { key: child },
          );
          const childId = described.session.sessionId;
          // Age only temporal facts produced by the real run, not lineage or authorization.
          const old = Date.now() - 31 * 60_000;
          await mutateSubagentRuns([childRun.runId], () => ({
            value: undefined,
            postimages: new Map([
              [childRun.runId, { ...childRun, execution: { ...childRun.execution, endedAt: old } }],
            ]),
          }));
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: child },
            { endedAt: old, updatedAt: old },
          );
          const navigation = await gateway.request<{ session: { childSessions?: string[] } }>(
            "sessions.describe",
            { key: parent },
          );
          record("aged-real-child", {
            parent,
            child,
            childId,
            old,
            childSessions: navigation.session.childSessions,
          });
          const before = (await history(parent)).length;
          const followup = await start(
            parent,
            [
              "Call sessions_send exactly once with " +
                JSON.stringify({
                  sessionKey: child,
                  message: "Reply with exactly " + continued + ". Do not use tools.",
                  timeoutSeconds: 30,
                }) +
                ".",
              "Do not spawn, inspect files, or call other tools. After that tool returns, finish with exactly PARENT_CONTINUED regardless of its result.",
            ].join("\n"),
          );
          await until("parent followup completes", async () => {
            const outcome = await gateway.request<{ status: string }>("agent.wait", {
              runId: followup.runId,
              timeoutMs: 1000,
            });
            return outcome.status === "ok" ? true : undefined;
          });
          const messages = (await history(parent)).slice(before);
          const sends = messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "sessions_send",
          );
          expect(sends).toHaveLength(1);
          record("retained-child-send", { parent, child, details: sends[0]?.details });
          expect(asOptionalRecord(sends[0]?.details)?.status).not.toBe("forbidden");
          await until(
            "same retained child replies",
            async () => finalReplies(await history(child), continued)[0],
          );
          const after = await gateway.request<{ session: { sessionId: string } }>(
            "sessions.describe",
            { key: child },
          );
          expect(after.session.sessionId).toBe(childId);
          record("retained-child-continued", { child, childId, reply: continued });
          const watchedReply = "WATCHED_" + id;
          const beforeWatch = (await history(parent)).length;
          await start(
            parent,
            [
              "Call sessions_send exactly once with " +
                JSON.stringify({
                  sessionKey: child,
                  message: "Reply with exactly " + watchedReply + ". Do not use tools.",
                  timeoutSeconds: 0,
                  watch: true,
                }) +
                ".",
              "If accepted, call sessions_yield and wait for the child result. When it arrives finish with exactly PARENT_WATCHED. On rejection finish with PARENT_REJECTED. Do not call other tools or start other work.",
            ].join("\n"),
          );
          await until(
            "nonblocking retained-child completion reaches its parent",
            async () =>
              finalReplies((await history(parent)).slice(beforeWatch), "PARENT_WATCHED")[0],
          );
          const watchMessages = (await history(parent)).slice(beforeWatch);
          const watchedSend = watchMessages.find(
            (message) => message.role === "toolResult" && message.toolName === "sessions_send",
          );
          expect(watchedSend?.details).toMatchObject({ status: "accepted", watched: true });
          expect(finalReplies(await history(child), watchedReply)).toEqual([watchedReply]);
          const watchedTarget = await gateway.request<{ session: { sessionId: string } }>(
            "sessions.describe",
            { key: child },
          );
          expect(watchedTarget.session.sessionId).toBe(childId);
          record("retained-child-watched-completion", {
            child,
            childId,
            details: watchedSend?.details,
          });
        },
      );
    },
    10 * 60_000,
  );
});
