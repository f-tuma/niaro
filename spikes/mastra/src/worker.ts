import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TEST_SCOPE } from "./niaro-boundary.ts";
import { createPrototype } from "./runtime.ts";

const schema = z.object({
  kind: z.enum([
    "start",
    "pending",
    "answer",
    "inspect",
    "revoke",
    "set-objective",
    "workflow-start",
    "workflow-resume",
  ]),
  taskId: z.string().default("TEST-task"),
  operationId: z.string().default("TEST-operation"),
  command: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("create-person"),
        operationId: z.string(),
        name: z.string(),
      }),
      z.object({ kind: z.literal("verify-person"), operationId: z.string() }),
      z.object({ kind: z.literal("remember"), fact: z.string() }),
      z.object({ kind: z.literal("recall") }),
    ])
    .optional(),
  scope: z
    .object({
      organizationId: z.string(),
      workspaceId: z.string(),
      userId: z.string(),
    })
    .optional(),
  runId: z.string().optional(),
  toolCallId: z.string().optional(),
  approved: z.boolean().default(true),
  loseResponse: z.boolean().default(false),
  objective: z.string().optional(),
});
const directory = process.argv[2];
if (!directory) throw new Error("An isolated fixture directory is required.");
const input = schema.parse(JSON.parse(process.argv[3] ?? "{}"));
const scope = input.scope ?? TEST_SCOPE;
const runtime = await createPrototype(directory, () =>
  appendFileSync(join(directory, "prepared.log"), `${input.taskId}\n`),
);
try {
  runtime.boundary.setLoseResponse(input.loseResponse);
  let result: unknown;
  switch (input.kind) {
    case "start":
      if (!input.command) throw new Error("Missing command.");
      result = await runtime.start(scope, input.taskId, input.command);
      break;
    case "pending":
      result = await runtime.pending(scope, input.taskId);
      break;
    case "answer":
      if (!input.runId || !input.toolCallId)
        throw new Error("Missing exact pending tool identity.");
      result = await runtime.answer(
        scope,
        input.taskId,
        input.runId,
        input.toolCallId,
        input.approved,
      );
      break;
    case "inspect":
      result = {
        receipt: runtime.boundary.read(scope, input.operationId),
        verified: runtime.boundary.verify(scope, input.operationId),
        pending: await runtime.pending(scope, input.taskId),
        objective: await runtime.objective(scope, input.taskId),
      };
      break;
    case "revoke":
      runtime.boundary.revoke();
      result = { revoked: true };
      break;
    case "set-objective":
      if (!input.objective) throw new Error("Missing objective.");
      result = await runtime.setObjective(scope, input.taskId, input.objective);
      break;
    case "workflow-start": {
      const run = await runtime.checkpoint.createRun({ runId: input.runId });
      result = {
        runId: run.runId,
        output: await run.start({
          inputData: { taskId: input.taskId, operationId: input.operationId },
        }),
      };
      break;
    }
    case "workflow-resume": {
      if (!input.runId) throw new Error("Missing workflow run identity.");
      const run = await runtime.checkpoint.createRun({ runId: input.runId });
      result = await run.resume({
        step: "review",
        resumeData: { approved: input.approved },
      });
      break;
    }
  }
  process.stdout.write(
    JSON.stringify({
      result,
      dispatches: runtime.boundary.dispatchCount(),
      modelCalls:
        runtime.model.doGenerateCalls.length +
        runtime.model.doStreamCalls.length,
    }) + "\n",
  );
} finally {
  await runtime.close();
}
