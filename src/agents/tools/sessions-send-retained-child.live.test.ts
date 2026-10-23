import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import type { QuestionRecord } from "../../../packages/gateway-protocol/src/index.js";
import type { ChatPendingInputsPage } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { handleSessionStateSessionReset } from "../../sessions/session-state-events.js";
import { readCursor } from "../../sessions/session-state-events.kernel.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isLiveTestEnabled } from "../live-test-helpers.js";
import {
  finalReplies,
  gateTask,
  history,
  runWithLiveSubagentGateway,
  until,
} from "../subagents/announce/subagent-challenges.live.test-support.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../subagents/registry/subagent-registry-persistence.js";
import { registerSubagentRun } from "../subagents/registry/subagent-registry.js";
import { isSubagentRunLive } from "../subagents/registry/subagent-run-liveness.js";

const enabled = isLiveTestEnabled() && isTruthyEnvValue(process.env.OPENCLAW_LIVE_RETAINED_CHILD);
const describeLive = enabled ? describe : describe.skip;

describeLive("retained native child continuation", () => {
  it(
    "continues the same child through sessions_send after display retention expires",
    async () => {
      await runWithLiveSubagentGateway(
        { additionalTools: ["sessions_send"], sessionVisibility: "tree" },
        async ({ gateway, gates, start, record, waitForDescendantSettlement }) => {
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
          const watchCursor = () => readCursor(openOpenClawStateDatabase().db, parent, child);
          const questionFor = (marker: string, runId: string) =>
            until("real communication approval", async () => {
              const pending = await gateway.request<{ questions: QuestionRecord[] }>(
                "question.list",
                {},
              );
              const question = pending.questions.find(
                (item) =>
                  item.sessionKey === child &&
                  item.questions.some((prompt) => prompt.question.includes(marker)),
              );
              if (question) {
                return question;
              }
              const outcome = await gateway.request<{ status: string }>("agent.wait", {
                runId,
                timeoutMs: 1000,
              });
              if (outcome.status !== "timeout") {
                throw new Error(
                  "The real send finished without the required communication approval",
                );
              }
              return undefined;
            });
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: child },
            { communication: { receive: "ask" } },
          );
          for (const change of ["controller", "caller"] as const) {
            await waitForDescendantSettlement(parent);
            const terminal = [...subagentRuns.values()].filter(
              (run) => run.childSessionKey === child && typeof run.execution.endedAt === "number",
            );
            const agedAt = Date.now() - 31 * 60_000;
            await mutateSubagentRuns(
              terminal.map((run) => run.runId),
              () => ({
                value: undefined,
                postimages: new Map(
                  terminal.map((run) => [
                    run.runId,
                    { ...run, execution: { ...run.execution, endedAt: agedAt } },
                  ]),
                ),
              }),
            );
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: child },
              { endedAt: agedAt, updatedAt: agedAt },
            );
            const marker = "DENIED_" + change + "_" + id;
            const attempt = await start(
              parent,
              "Call sessions_send exactly once with " +
                JSON.stringify({
                  sessionKey: child,
                  message: "Reply with exactly " + marker + ". Do not use tools.",
                  timeoutSeconds: 0,
                  watch: true,
                }) +
                ". Then finish with PARENT_DENIED. Do not call other tools or retry.",
            );
            const question = await questionFor(marker, attempt.runId);
            record("prepared-retained-child-send", {
              change,
              parent,
              child,
              childId,
              questionId: question.id,
            });
            const held = gates.create();
            let foreignRunId: string | undefined;
            try {
              if (change === "controller") {
                const foreign = "agent:main:dashboard:foreign-" + id;
                await upsertSessionEntryCore(
                  { agentId: "main", sessionKey: foreign },
                  { sessionId: randomUUID(), updatedAt: Date.now() },
                );
                // The real model execution supplies liveness; its existing registry owner records control.
                const running = await start(child, gateTask(held.url));
                foreignRunId = running.runId;
                await registerSubagentRun({
                  runId: running.runId,
                  childSessionKey: child,
                  childAgentId: "main",
                  sessionEntry: loadSessionEntry({ agentId: "main", sessionKey: child }),
                  requesterSessionKey: foreign,
                  controllerSessionKey: foreign,
                  requesterAgentId: "main",
                  requesterDisplayKey: foreign,
                  task: "Hold real foreign execution for retained-child admission proof",
                  cleanup: "keep",
                  expectsCompletionMessage: false,
                });
                await until("foreign child executor is actually live", () =>
                  isSubagentRunLive(subagentRuns.get(running.runId)) && held.snapshot().waiting > 0
                    ? true
                    : undefined,
                );
                const current = await gateway.request<{
                  session: { controlOwnerSessionKey?: string };
                }>("sessions.describe", { key: child });
                expect(current.session.controlOwnerSessionKey).toBe(foreign);
                record("retained-child-controller-reassigned", {
                  child,
                  runId: running.runId,
                  controller: foreign,
                });
              } else {
                const aborted = await gateway.request<{ aborted: boolean }>("chat.abort", {
                  sessionKey: parent,
                  runId: attempt.runId,
                });
                expect(aborted.aborted).toBe(true);
                record("retained-child-caller-revoked", { parent, runId: attempt.runId });
              }
              // Reset only observation cursors, not session identity or caller/target authority.
              await handleSessionStateSessionReset(parent);
              expect(watchCursor()).toBeUndefined();
              await expect(
                gateway.request("question.resolve", {
                  id: question.id,
                  answers: { answers: { communication: ["Allow once"] } },
                }),
              ).rejects.toThrow();
              await until("revoked send settles", async () => {
                const ended = await gateway.request<{ status: string }>("agent.wait", {
                  runId: attempt.runId,
                  timeoutMs: 1000,
                });
                return ended.status !== "timeout" ? true : undefined;
              });
              const pending = await gateway.request<{ pendingInputs: ChatPendingInputsPage }>(
                "chat.history",
                { sessionKey: child },
              );
              expect(JSON.stringify(pending.pendingInputs.items)).not.toContain(marker);
              expect(JSON.stringify(await history(child))).not.toContain(marker);
              expect(watchCursor()).toBeUndefined();
              expect(loadSessionEntry({ agentId: "main", sessionKey: child })?.sessionId).toBe(
                childId,
              );
              record("retained-child-denied-before-effects", {
                change,
                child,
                childId,
                approvalRejected: true,
                watchRegistered: Boolean(watchCursor()),
                childInputCommitted: false,
                pendingInputCommitted: false,
              });
            } finally {
              held.release("FOREIGN_COMPLETE");
              if (foreignRunId) {
                await until("foreign execution settles", async () => {
                  const ended = await gateway.request<{ status: string }>("agent.wait", {
                    runId: foreignRunId,
                    timeoutMs: 1000,
                  });
                  return ended.status === "ok" ? true : undefined;
                });
              }
            }
          }
          const watchedReply = "WATCHED_" + id;
          const beforeWatch = (await history(parent)).length;
          const watchedAttempt = await start(
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
          const allowedQuestion = await questionFor(watchedReply, watchedAttempt.runId);
          await gateway.request("question.resolve", {
            id: allowedQuestion.id,
            answers: { answers: { communication: ["Allow once"] } },
          });
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
          expect(watchCursor()).toBeDefined();
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
