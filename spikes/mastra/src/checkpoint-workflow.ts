import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

const taskSchema = z.object({
  taskId: z.string().min(1),
  operationId: z.string().min(1),
});

const preparedSchema = taskSchema.extend({ prepared: z.literal(true) });
const decisionSchema = taskSchema.extend({
  decision: z.enum(["approved", "rejected"]),
});

/** A native checkpoint fixture; approval never dispatches a provider write. */
export function createCheckpointWorkflow(onPrepare: () => void) {
  const prepare = createStep({
    id: "prepare",
    inputSchema: taskSchema,
    outputSchema: preparedSchema,
    retries: 0,
    execute: async ({ inputData }) => {
      onPrepare();
      return { ...inputData, prepared: true as const };
    },
  });

  const review = createStep({
    id: "review",
    inputSchema: preparedSchema,
    outputSchema: decisionSchema,
    suspendSchema: taskSchema,
    resumeSchema: z.object({ approved: z.boolean() }),
    retries: 0,
    execute: async ({ inputData, resumeData, suspend }) => {
      const task = {
        taskId: inputData.taskId,
        operationId: inputData.operationId,
      };
      if (resumeData === undefined) return suspend(task);

      return {
        ...task,
        decision: resumeData.approved
          ? ("approved" as const)
          : ("rejected" as const),
      };
    },
  });

  return createWorkflow({
    id: "niaro-checkpoint-fixture",
    inputSchema: taskSchema,
    outputSchema: decisionSchema,
  })
    .then(prepare)
    .then(review)
    .commit();
}
