import { expect, it } from "vitest";
import { evaluateWorkflowExpression, readWorkflow } from "./ci-workflow.test-support.js";

const base = { repository: "openclaw/openclaw", runAttempt: 1, releasePriorityRun: "123" } as const;
type Context = Parameters<typeof evaluateWorkflowExpression>[1];

function evaluate(expression: string, context: Context) {
  return evaluateWorkflowExpression(
    expression.startsWith("${{") ? expression : "${{ " + expression + " }}",
    context,
  );
}

it("retains real per-push CodeQL and workflow security checks", () => {
  const context = { ...base, eventName: "push" } as const;
  const codeql = readWorkflow(".github/workflows/codeql.yml");
  expect(codeql.on.push.branches).toContain("main");
  expect(evaluate(codeql.jobs["security-high"].if, context)).toBe(true);
  const sanity = readWorkflow(".github/workflows/workflow-sanity.yml");
  expect(evaluate(sanity.jobs.actionlint.if, context)).toBe(true);
});
