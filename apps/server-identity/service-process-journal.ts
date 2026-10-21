import { z } from "zod";
import { ScopeSchema, type Scope } from "../../packages/protocol";
import { IdentityId } from "../../packages/protocol/identity";
import type { ProcessVersion } from "../../packages/protocol/service-processes";
import { ProcessQuestionSchema } from "../../packages/protocol/process-questions";
import { processCompilerVersion } from "@niaro/server-agent/process-contract";
import { ProcessAgentStateSchema } from "./process-agent-runtime";
import { LoopTraceSchema, newLoopTrace } from "./loop-trace";
import { processDigest } from "./process-validation";

export const Approval = z.strictObject({
  nodeId: z.string(),
  operationId: IdentityId,
});
export const Failure = z.strictObject({
  code: z.string(),
  nodeId: z.string().optional(),
  operationId: IdentityId.optional(),
});
export const JournalSchema = z.strictObject({
  kind: z.literal("service-process-1"),
  /** Server-owned generation for exact public approval binding. Historical journals start at 1. */
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  runId: IdentityId,
  processId: IdentityId,
  version: z.number().int().positive(),
  artifactDigest: z.string(),
  compilerVersion: z.string(),
  scopeDigest: z.string(),
  inputDigest: z.string(),
  input: z.record(z.string(), z.unknown()),
  text: z.string().max(500),
  status: z.enum([
    "running",
    "waiting",
    "succeeded",
    "failed",
    "unknown",
    "cancelled",
  ]),
  startedAt: z.number().int(),
  visited: z.array(z.string()).max(128),
  inference: z.number().int().nonnegative().max(128).default(0),
  agents: z.record(z.string(), ProcessAgentStateSchema).default({}),
  operations: z.array(IdentityId).max(64),
  receipts: z
    .array(z.strictObject({ callId: z.string(), operationId: IdentityId }))
    .max(64),
  sources: z.array(IdentityId).max(64),
  pending: z.union([Approval, ProcessQuestionSchema]).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  failure: Failure.optional(),
  trace: LoopTraceSchema,
});
export type Journal = z.infer<typeof JournalSchema>;

/** Existing identity algorithm, shared by admission and native execution. */
export function serviceProcessRunIdentity(
  scope: Scope,
  organizationId: string,
  runId: string,
) {
  ScopeSchema.parse(scope);
  IdentityId.parse(organizationId);
  IdentityId.parse(runId);
  const scopeDigest = processDigest([
    scope.serverId,
    organizationId,
    scope.workspaceId,
    scope.userId,
  ]);
  return {
    scopeDigest,
    parentRunId: processDigest(["service-process-1", scopeDigest, runId]),
  };
}
export function newServiceProcessJournal(
  artifact: ProcessVersion,
  runId: string,
  scope: Scope,
  organizationId: string,
  input: Record<string, unknown>,
  startedAt: number,
): Journal {
  return JournalSchema.parse({
    kind: "service-process-1",
    runId,
    processId: artifact.processId,
    version: artifact.version,
    artifactDigest: artifact.digest,
    compilerVersion: processCompilerVersion(artifact.definition),
    scopeDigest: serviceProcessRunIdentity(scope, organizationId, runId)
      .scopeDigest,
    inputDigest: processDigest(input),
    input,
    text: artifact.definition.name,
    status: "running",
    startedAt,
    visited: [],
    inference: 0,
    agents: {},
    operations: [],
    receipts: [],
    sources: [],
    trace: newLoopTrace(),
  });
}
