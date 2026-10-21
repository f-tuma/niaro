import {
  DesignCapabilitiesSchema,
  DesignReviewSchema,
  DesignTurnSchema,
  DESIGN_PROFILE,
} from "../packages/protocol/process-design";
import { CatalogSchema } from "../packages/protocol/service-catalog";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";

/** Synthetic DOM fixtures, also used by client recovery tests; never a live model. */
export const designUiTarget = {
  organizationId: "test_org",
  workspaceId: "test_workspace",
};
export const designUiCapabilities = DesignCapabilitiesSchema.parse({
  ...designUiTarget,
  services: [
    {
      id: "test_service",
      revision: 1,
      name: "TEST CRM",
      description: "Synthetic contacts",
      enabled: true,
      actions: [
        {
          id: "test_action",
          revision: 1,
          name: "Find contacts",
          description: "Synthetic lookup",
          enabled: true,
          status: "configured",
          effect: "read",
          approval: "never",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            additionalProperties: false,
          },
          schemaUnavailable: null,
        },
      ],
    },
  ],
  models: [
    {
      id: "test_model",
      revision: 1,
      name: "TEST designer",
      model: "TEST-tool-model",
      providerId: "test_provider",
      providerRevision: 1,
      tools: true,
      status: "configured",
    },
  ],
  memoryModes: ["none", "conversation", "saved"],
  limits: {
    maxSteps: 24,
    maxModelCalls: 32,
    maxTokens: 10000,
    maxCostMicros: 1000000,
    maxDurationMs: 120000,
  },
  grammar: {
    schemaVersion: 1,
    trigger: "manual",
    kinds: ["agent", "workflow"],
  },
  fingerprint: "a".repeat(64),
  nextAfter: null,
  totalItems: 3,
});
const object = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
export const designUiCandidate = ProcessDefinitionSchema.parse({
  schemaVersion: 1,
  kind: "workflow",
  name: "TEST contact workflow",
  description: "Find a contact and return its details",
  trigger: "manual",
  inputSchema: {
    ...object,
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  outputSchema: {
    ...object,
    properties: { found: { type: "boolean" } },
    required: ["found"],
  },
  limits: designUiCapabilities.limits,
  entry: "lookup",
  steps: [
    {
      id: "lookup",
      type: "action",
      serviceId: "test_service",
      actionId: "test_action",
      input: { name: { source: "input", path: ["name"] } },
      outputSchema: {
        ...object,
        properties: { found: { type: "boolean" } },
        required: ["found"],
      },
      next: "check",
    },
    {
      id: "check",
      type: "branch",
      condition: {
        operator: "equals",
        left: { source: "step", stepId: "lookup", path: ["found"] },
        right: true,
      },
      whenTrue: "explain",
      whenFalse: "finish",
    },
    {
      id: "explain",
      type: "agent",
      modelId: "test_model",
      instructions: "Explain synthetic results",
      capabilities: [{ serviceId: "test_service", actionId: "test_action" }],
      memory: "conversation",
      inputSchema: object,
      outputSchema: object,
      input: {},
      next: "finish",
    },
    {
      id: "finish",
      type: "return",
      output: { found: { source: "step", stepId: "lookup", path: ["found"] } },
    },
  ],
});
export const designUiReview = DesignReviewSchema.parse({
  profile: DESIGN_PROFILE,
  ...designUiTarget,
  id: "test_design",
  serviceId: "test_service",
  revision: 1,
  brief: {
    purpose: "Find contacts in the TEST CRM",
    inputs: ["Contact name"],
    outputs: ["Contact details"],
    rules: ["Read only"],
    questions: [],
    assumptions: [{ id: "read_only", text: "No contacts will be modified" }],
  },
  candidate: designUiCandidate,
  baseline: null,
  baselineSources: null,
  dependencyComparison: "new",
  dependencyChanges: [],
  confirmation: "catalog",
  assumptions: [
    { id: "read_only", digest: "b".repeat(64), acknowledged: false },
  ],
  validation: { valid: true, issues: [], sources: null },
  blockers: ["assumptions_unacknowledged"],
  changes: [
    {
      path: "name",
      kind: "added",
      before: null,
      after: "TEST contact workflow",
    },
  ],
  changesTruncated: false,
  capabilityFingerprint: designUiCapabilities.fingerprint,
  reviewDigest: "c".repeat(64),
  acceptedProcessId: null,
  updatedAt: "2026-10-04T12:00:00.000Z",
});
export const designUiTurn = DesignTurnSchema.parse({
  profile: DESIGN_PROFILE,
  ...designUiTarget,
  sessionId: "test_design",
  requestId: "test_request",
  turnId: "d".repeat(64),
  requestRevision: 1,
  nativeSettled: true,
  model: {
    id: "test_model",
    revision: 1,
    providerId: "test_provider",
    providerRevision: 1,
  },
  status: "completed",
  userText: "  Find a contact\n\nwithout modifying it.  ",
  language: "en",
  reply:
    "**Proposal ready**\n\n- Find a contact\n- Review its details\n\n`lookup` is a read action.\n\n<script>TEST literal HTML</script>\n\n[Unsafe](javascript:alert(1)) ![TEST image](https://images.example.test/private.png)",
  failure: null,
  revision: 1,
  toolReceipts: [
    { toolCallId: "test_tool", name: "design_update_proposal", revision: 1 },
  ],
  createdAt: "2026-10-04T12:00:00.000Z",
  updatedAt: "2026-10-04T12:00:00.000Z",
});
export const designUiCatalog = CatalogSchema.parse({
  ...designUiTarget,
  canManage: true,
  services: [
    {
      id: "test_service",
      revision: 1,
      name: "TEST CRM",
      url: "https://services.example.test",
      protocol: "openapi",
      icon: "users",
      iconSource: "custom",
      auth: { type: "none" },
      enabled: true,
      hasCredential: false,
      modelId: null,
      actions: [],
    },
  ],
  providers: [],
  models: [],
  routing: { revision: 0, modelId: null, services: [] },
});
