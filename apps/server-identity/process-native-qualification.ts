import {
  NativeQualificationReasonSchema,
  NativeQualificationVerdictSchema,
  PROCESS_NATIVE_QUALIFICATION_POLICY,
  type NativeQualificationReason,
  type NativeQualificationRecord,
  type NativeQualificationVerdict,
} from "../../packages/protocol/process-native-qualification";
import {
  NativeTestSuiteSchema,
  NativeTestReportSchema,
  type NativeTestCase,
  type NativeTestObservation,
  type NativeTestReport,
  type NativeTestSuite,
} from "../../packages/protocol/process-native-testing";
import { ProcessTestScenarioSchema } from "../../packages/protocol/process-testing";
import {
  ProcessVersionSchema,
  type ProcessData,
  type ProcessVersion,
} from "../../packages/protocol/service-processes";
import { processValueSchema } from "../server-agent/process-workflow";
import { schemaValidator } from "../server-integrations/schema";
import {
  ProcessTestCatalogSchema,
  type ProcessTestCatalog,
} from "./process-test-catalog";
import {
  nativeObservableAssertions,
  nativePassedBudget,
} from "./process-native-verdict";
import { processDigest } from "./process-validation";
import { rankNativeActions, mastraActionToolName } from "./mastra-domain";
import { processAgentToolName } from "../server-agent/process-agent-tools";
import { nativeScriptedInitialToolNames } from "./process-native-tools";
import {
  processNativeStamp,
  processNativeExecutionSettings,
} from "./process-native-environment";
const same = (left: unknown, right: unknown) =>
  left === undefined || right === undefined
    ? left === right
    : processDigest(left) === processDigest(right);
const orderedReasons = (values: Iterable<NativeQualificationReason>) => {
  const unique = new Set(values);
  return NativeQualificationReasonSchema.options.filter((reason) =>
    unique.has(reason),
  );
};

/** The digest covers every provenance and verdict field except itself. */
export function nativeQualificationDigest(
  record: Omit<NativeQualificationRecord, "qualificationDigest">,
) {
  const { qualificationDigest: _qualificationDigest, ...content } =
    record as NativeQualificationRecord;
  return processDigest(content);
}

function capabilities(artifact: ProcessVersion) {
  const definition = artifact.definition;
  return definition.kind === "agent"
    ? definition.capabilities
    : definition.steps.flatMap((step) =>
        step.type === "agent"
          ? step.capabilities
          : step.type === "action"
            ? [step]
            : [],
      );
}
function agents(artifact: ProcessVersion) {
  const definition = artifact.definition;
  return definition.kind === "agent"
    ? [definition]
    : definition.steps.filter((step) => step.type === "agent");
}
function sourceBindings(
  artifact: ProcessVersion,
  suite: NativeTestSuite,
  catalog: ProcessTestCatalog,
) {
  const descriptors = [
    ...catalog.services.map((service) => ({
      kind: "service",
      id: service.id,
      revision: service.revision,
    })),
    ...catalog.services.flatMap((service) =>
      service.actions.map((action) => ({
        kind: "action",
        id: action.id,
        revision: action.revision,
      })),
    ),
    ...catalog.models.map((model) => ({
      kind: "model",
      id: model.id,
      revision: model.revision,
    })),
    ...catalog.providers.map((provider) => ({
      kind: "provider",
      id: provider.id,
      revision: provider.revision,
    })),
  ];
  const baseline = catalog.models.find(
    (model) => model.id === suite.genericModelId,
  );
  const configuredOnly = suite.comparisonMode === "configured_only";
  const resources = artifact.sources.resources;
  const actionNames = catalog.services.flatMap((service) =>
    service.actions.map((action) => "action_" + action.id.replaceAll("-", "_")),
  );
  const sourceEqual = (
    left: (typeof descriptors)[number],
    right: (typeof resources)[number],
  ) =>
    left.kind === right.kind &&
    left.id === right.id &&
    left.revision === right.revision;
  return (
    (configuredOnly
      ? artifact.definition.kind === "workflow" &&
        agents(artifact).length === 0 &&
        suite.cases.every(
          (item) =>
            item.models.configured.length === 0 &&
            (item.questions?.configured.length ?? 0) === 0,
        )
      : !!baseline) &&
    new Set(actionNames).size === actionNames.length &&
    new Set(descriptors.map((descriptor) => descriptor.id)).size ===
      descriptors.length &&
    new Set(resources.map((resource) => resource.kind + ":" + resource.id))
      .size === resources.length &&
    resources.every((resource) =>
      descriptors.some((descriptor) => sourceEqual(descriptor, resource)),
    ) &&
    descriptors.every(
      (descriptor) =>
        resources.some((resource) => sourceEqual(descriptor, resource)) ||
        (descriptor.kind === "model" && descriptor.id === baseline?.id) ||
        (descriptor.kind === "provider" &&
          descriptor.id === baseline?.providerId),
    ) &&
    catalog.models.every((model) =>
      catalog.providers.some((provider) => provider.id === model.providerId),
    ) &&
    capabilities(artifact).every((capability) =>
      catalog.services.some(
        (service) =>
          service.id === capability.serviceId &&
          service.actions.some((action) => action.id === capability.actionId),
      ),
    ) &&
    agents(artifact).every((agent) =>
      catalog.models.some((model) => model.id === agent.modelId),
    )
  );
}
function hasMissingRequired(schema: ProcessData, value: unknown): boolean {
  if (
    schema.type === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const object = value as Record<string, unknown>;
    return (
      schema.required.some((key) => !Object.hasOwn(object, key)) ||
      Object.entries(schema.properties).some(
        ([key, field]) =>
          Object.hasOwn(object, key) && hasMissingRequired(field, object[key]),
      )
    );
  }
  return (
    schema.type === "array" &&
    Array.isArray(value) &&
    value.some((item) => hasMissingRequired(schema.items, item))
  );
}

function declaresRequiredInput(schema: ProcessData): boolean {
  return schema.type === "object"
    ? schema.required.length > 0 ||
        Object.values(schema.properties).some(declaresRequiredInput)
    : schema.type === "array" && declaresRequiredInput(schema.items);
}

/** Required hazards come only from the exact frozen graph and pinned catalog. */
export function nativeQualificationApplicableScenarios(
  artifact: ProcessVersion,
  catalog: ProcessTestCatalog,
) {
  const actions = capabilities(artifact).flatMap((capability) => {
    const action = catalog.services
      .find((service) => service.id === capability.serviceId)
      ?.actions.find((action) => action.id === capability.actionId);
    return action ? [action] : [];
  });
  return {
    success: true,
    rejection: actions.some((action) => action.approval === "always"),
    missing_input: declaresRequiredInput(artifact.definition.inputSchema),
    failure: actions.length > 0 || agents(artifact).length > 0,
    unknown: actions.some((action) => action.effect === "write"),
    restart: true,
  };
}

/** One receipt for each consumed fixture, with pinned capability, effect and decision. */
function fixtureLedger(
  item: NativeTestCase,
  artifact: ProcessVersion,
  catalog: ProcessTestCatalog,
) {
  const allowed = capabilities(artifact);
  if (item.actions.length !== item.expected.receipts.length) return false;
  return item.actions.every((fixture, index) => {
    const service = catalog.services.find(
      (value) => value.id === fixture.serviceId,
    );
    const action = service?.actions.find(
      (value) => value.id === fixture.actionId,
    );
    const receipt = item.expected.receipts[index]!;
    if (
      !service ||
      !action ||
      !actionAllowed(catalog, service, action) ||
      !allowed.some(
        (capability) =>
          capability.serviceId === fixture.serviceId &&
          capability.actionId === fixture.actionId,
      ) ||
      (action.approval === "always"
        ? fixture.decision === "none"
        : fixture.decision !== "none")
    )
      return false;
    const rejected = fixture.decision === "reject";
    if (
      (rejected || fixture.outcome !== "complete") &&
      index !== item.actions.length - 1
    )
      return false;
    const status = rejected
      ? "rejected"
      : fixture.outcome === "complete"
        ? "succeeded"
        : fixture.outcome === "failure"
          ? "failed"
          : "unknown";
    return (
      receipt.serviceId === service.id &&
      receipt.actionId === action.id &&
      receipt.serviceRevision === service.revision &&
      receipt.actionRevision === action.revision &&
      receipt.effect === action.effect &&
      same(receipt.input, fixture.input) &&
      receipt.status === status &&
      receipt.dispatches === (rejected ? 0 : 1) &&
      (status === "succeeded"
        ? same(receipt.output, fixture.output) && !receipt.code
        : receipt.output === undefined) &&
      (status === "failed"
        ? receipt.code === "integration_provider_failed"
        : status === "unknown"
          ? receipt.code === "integration_unavailable"
          : !receipt.code)
    );
  });
}
function modelBindings(
  item: NativeTestCase,
  strategy: NativeTestObservation["strategy"],
  artifact: ProcessVersion,
  suite: NativeTestSuite,
  catalog: ProcessTestCatalog,
) {
  const configured = new Set(agents(artifact).map((agent) => agent.modelId));
  return item.models[strategy].every((step) => {
    const model = catalog.models.find((value) => value.id === step.modelId);
    const provider = catalog.providers.find(
      (value) => value.id === model?.providerId,
    );
    return (
      model?.enabled &&
      provider?.enabled &&
      model.tools &&
      ["chat", "router"].includes(model.kind) &&
      (strategy === "generic"
        ? model.id === suite.genericModelId
        : configured.has(model.id))
    );
  });
}
function actionAllowed(
  catalog: ProcessTestCatalog,
  service: ProcessTestCatalog["services"][number],
  action: ProcessTestCatalog["services"][number]["actions"][number],
) {
  if (
    !service.enabled ||
    !action.enabled ||
    (service.access &&
      !service.access.roles.includes(catalog.role) &&
      !service.access.workspaceRoles.some((role) =>
        catalog.workspaceRoles.includes(role),
      ))
  )
    return false;
  const user = action.policy.users.find(
    (value) => value.userId === catalog.userId,
  );
  return user
    ? user.access === "allow"
    : action.policy.roles.includes(catalog.role) ||
        !!action.policy.workspaceRoles?.some((role) =>
          catalog.workspaceRoles.includes(role),
        );
}
function scriptToolExposure(
  item: NativeTestCase,
  strategy: NativeTestObservation["strategy"],
  artifact: ProcessVersion,
  catalog: ProcessTestCatalog,
  maxExposed: number,
) {
  const initial = new Set(nativeScriptedInitialToolNames());
  let exposed: string[] = [];
  let questions = 0;
  for (const step of item.models[strategy]) {
    const configuredAgents = agents(artifact).filter(
      (agent) => agent.modelId === step.modelId,
    );
    const available =
      strategy === "configured"
        ? new Set(
            configuredAgents.flatMap((agent) => [
              ...agent.capabilities.map((_capability, index) =>
                processAgentToolName(index),
              ),
              ...(agent.humanInput === "text" ? ["ask_user"] : []),
            ]),
          )
        : new Set([...initial, ...exposed]);
    if (step.requiredTools.some((name) => !available.has(name))) return false;
    const reply = step.reply;
    if (reply.type === "text") continue;
    if (!available.has(reply.name)) return false;
    if (reply.name === "ask_user") {
      const fixture = item.questions?.[strategy]?.[questions++];
      if (
        !fixture ||
        Object.keys(reply.input).length !== 1 ||
        typeof reply.input.question !== "string" ||
        reply.input.question !== fixture.question
      )
        return false;
      continue;
    }
    if (strategy === "configured" || reply.name.startsWith("action_")) continue;
    if (reply.name === "find_actions") {
      if (
        typeof reply.input.service !== "string" ||
        typeof reply.input.need !== "string" ||
        Object.keys(reply.input).some(
          (key) => !["service", "need"].includes(key),
        )
      )
        return false;
      const named = reply.input.service.toLocaleLowerCase();
      const accessible = catalog.services.filter(
        (service) =>
          service.enabled &&
          service.actions.some((action) =>
            actionAllowed(catalog, service, action),
          ),
      );
      const service =
        accessible.find((value) => value.name.toLocaleLowerCase() === named) ??
        accessible.find((value) =>
          value.name.toLocaleLowerCase().includes(named),
        );
      if (!service) continue;
      let picked = service.actions.filter((action) =>
        actionAllowed(catalog, service, action),
      );
      if (picked.length > 5)
        picked = rankNativeActions(picked, reply.input.need).slice(0, 6);
      for (const action of picked) {
        const name = mastraActionToolName(action.id);
        exposed = [name, ...exposed.filter((value) => value !== name)].slice(
          0,
          maxExposed,
        );
      }
    } else if (reply.name === "find_service") {
      if (
        typeof reply.input.need !== "string" ||
        Object.keys(reply.input).some((key) => key !== "need")
      )
        return false;
    } else if (reply.name === "memory_search") {
      if (
        (reply.input.query !== undefined &&
          (typeof reply.input.query !== "string" ||
            reply.input.query.length > 500)) ||
        Object.keys(reply.input).some((key) => key !== "query")
      )
        return false;
    } else return false;
  }
  return questions === (item.questions?.[strategy]?.length ?? 0);
}
function scriptedActionLedger(
  item: NativeTestCase,
  strategy: NativeTestObservation["strategy"],
  artifact: ProcessVersion,
  catalog: ProcessTestCatalog,
) {
  // Workflow static actions are represented by receipts; configured agents expose indexed tools.
  if (strategy === "configured" && artifact.definition.kind === "workflow")
    return true;
  const available =
    strategy === "configured" && artifact.definition.kind === "agent"
      ? artifact.definition.capabilities.map((capability, index) => ({
          ...capability,
          name: processAgentToolName(index),
        }))
      : catalog.services.flatMap((service) =>
          service.actions.map((action) => ({
            serviceId: service.id,
            actionId: action.id,
            name: mastraActionToolName(action.id),
          })),
        );
  const calls = item.models[strategy].flatMap((step) => {
    if (step.reply.type !== "tool" || !step.reply.name.startsWith("action_"))
      return [];
    const reply = step.reply;
    return [
      {
        capability: available.find(
          (capability) => capability.name === reply.name,
        ),
        input: reply.input,
      },
    ];
  });
  const terminal = item.actions.at(-1);
  const lastReply = item.models[strategy].at(-1)?.reply;
  if (
    strategy === "configured" &&
    terminal &&
    (terminal.decision === "reject" || terminal.outcome !== "complete") &&
    (lastReply?.type !== "tool" ||
      !lastReply.name.startsWith("action_process_"))
  )
    return false;
  return (
    calls.length === item.actions.length &&
    calls.every((call, index) => {
      const fixture = item.actions[index]!;
      return (
        call.capability?.serviceId === fixture.serviceId &&
        call.capability.actionId === fixture.actionId &&
        same(call.input, fixture.input)
      );
    })
  );
}
function receiptOutcome(observation: NativeTestObservation) {
  const unknown = observation.receipts.find(
    (receipt) => receipt.status === "unknown",
  );
  if (unknown)
    return (
      observation.observed === "unknown" && observation.code === unknown.code
    );
  const rejected = observation.receipts.find(
    (receipt) => receipt.status === "rejected",
  );
  if (rejected)
    return (
      observation.observed === "rejected" &&
      observation.code === (rejected.code ?? "process_action_rejected")
    );
  const failed = observation.receipts.find(
    (receipt) => receipt.status === "failed",
  );
  if (failed)
    return (
      observation.observed === "failed" && observation.code === failed.code
    );
  return !["unknown", "rejected"].includes(observation.observed);
}
function terminalOutput(
  item: NativeTestCase,
  observation: NativeTestObservation,
  artifact: ProcessVersion,
) {
  if (
    observation.observed !== "succeeded" ||
    (observation.strategy === "configured" &&
      artifact.definition.kind === "workflow")
  )
    return true;
  const last = item.models[observation.strategy].at(-1);
  if (last?.reply.type !== "text") return false;
  try {
    return same(JSON.parse(last.reply.text), observation.output);
  } catch {
    return false;
  }
}
function domainFailure(
  item: NativeTestCase,
  observation: NativeTestObservation,
  artifact: ProcessVersion,
) {
  if (observation.code === "integration_provider_failed")
    return item.actions.some(
      (fixture, index) =>
        fixture.decision !== "reject" &&
        fixture.outcome === "failure" &&
        observation.receipts[index]?.status === "failed" &&
        observation.receipts[index]?.code === observation.code,
    );
  if (observation.code !== "process_output_invalid") return false;
  const last = item.models[observation.strategy].at(-1);
  if (last?.reply.type === "text") {
    let output: unknown;
    try {
      output = JSON.parse(last.reply.text);
    } catch {
      output = undefined;
    }
    if (
      !processValueSchema(artifact.definition.outputSchema).safeParse(output)
        .success
    )
      return true;
  }
  // A workflow may reject a typed action result before its final return.
  return (
    artifact.definition.kind === "workflow" &&
    artifact.definition.steps.some(
      (step) =>
        step.type === "action" &&
        item.actions.some(
          (fixture) =>
            fixture.serviceId === step.serviceId &&
            fixture.actionId === step.actionId &&
            fixture.outcome === "complete" &&
            !processValueSchema(step.outputSchema).safeParse(fixture.output)
              .success,
        ),
    )
  );
}
function semanticCoverage(
  item: NativeTestCase,
  observation: NativeTestObservation,
  artifact: ProcessVersion,
) {
  if (
    item.scenario !== "missing_input" &&
    (observation.strategy === "generic" ||
      artifact.definition.kind === "agent") &&
    observation.modelCalls === 0
  )
    return false;
  switch (item.scenario) {
    case "success":
      return observation.observed === "succeeded";
    case "rejection":
      return (
        observation.observed === "rejected" &&
        observation.approvals > 0 &&
        observation.code === "process_action_rejected" &&
        item.actions.some(
          (fixture, index) =>
            fixture.decision === "reject" &&
            observation.receipts[index]?.status === "rejected" &&
            observation.receipts[index]?.dispatches === 0,
        )
      );
    case "missing_input":
      return (
        observation.observed === "input_invalid" &&
        observation.code === "process_input_invalid" &&
        hasMissingRequired(artifact.definition.inputSchema, item.input) &&
        item.actions.length === 0 &&
        item.models.configured.length === 0 &&
        item.models.generic.length === 0 &&
        observation.modelCalls === 0 &&
        observation.approvals === 0 &&
        observation.receipts.length === 0 &&
        observation.businessDispatches === 0
      );
    case "failure":
      return (
        observation.observed === "failed" &&
        domainFailure(item, observation, artifact)
      );
    case "unknown":
      return (
        observation.observed === "unknown" &&
        item.actions.some((fixture, index) => {
          const receipt = observation.receipts[index];
          return (
            fixture.decision !== "reject" &&
            fixture.outcome === "unknown" &&
            receipt?.effect === "write" &&
            receipt.status === "unknown" &&
            receipt.dispatches === 1 &&
            receipt.code === observation.code
          );
        })
      );
    case "restart":
      return (
        !!item.reopenAt &&
        observation.reopened &&
        observation.observed === "succeeded" &&
        (item.reopenAt === "completed" ||
          (observation.approvals > 0 &&
            item.actions.some(
              (fixture, index) =>
                fixture.decision === "approve" &&
                observation.receipts[index]?.status === "succeeded" &&
                observation.receipts[index]?.dispatches === 1,
            )))
      );
  }
}

/** Pure server policy over trusted scripted evidence; it never runs a provider or grants activation. */
export function deriveNativeQualification(
  rawArtifact: ProcessVersion,
  rawSuite: NativeTestSuite,
  rawReport: NativeTestReport,
  rawCatalog: ProcessTestCatalog,
): NativeQualificationVerdict {
  const artifactResult = ProcessVersionSchema.safeParse(rawArtifact);
  const suiteResult = NativeTestSuiteSchema.safeParse(rawSuite);
  const reportResult = NativeTestReportSchema.safeParse(rawReport);
  const catalogResult = ProcessTestCatalogSchema.safeParse(rawCatalog);
  const suite = suiteResult.success ? suiteResult.data : undefined;
  const global = new Set<NativeQualificationReason>();
  if (!suiteResult.success) global.add("invalid_input_case");
  if (
    !artifactResult.success ||
    !reportResult.success ||
    !catalogResult.success
  )
    global.add("invalid_observation");
  const coverage = ProcessTestScenarioSchema.options.map((scenario) => ({
    scenario,
    applicable: true,
    caseIds: (
      suite?.cases
        .filter((item) => item.scenario === scenario)
        .map((item) => item.id) ?? []
    ).sort(),
    passed: false,
    reasons: [] as NativeQualificationReason[],
  }));
  if (
    artifactResult.success &&
    suite &&
    reportResult.success &&
    catalogResult.success
  ) {
    const artifact = artifactResult.data,
      report = reportResult.data,
      catalog = catalogResult.data;
    const applicable = nativeQualificationApplicableScenarios(
      artifact,
      catalog,
    );
    // Supplied cases are still validated below, even for inapplicable hazards.
    for (const family of coverage)
      family.applicable = applicable[family.scenario];
    const settings = processNativeExecutionSettings(artifact, catalog);
    const strategies =
      suite.comparisonMode === "configured_only"
        ? (["configured"] as const)
        : (["configured", "generic"] as const);
    if (report.status !== "passed") global.add("report_failed");
    if (
      processDigest({
        definition: artifact.definition,
        sources: artifact.sources,
      }) !== artifact.digest
    )
      global.add("invalid_observation");
    if (
      !sourceBindings(artifact, suite, catalog) ||
      !same(report.stamp, processNativeStamp(artifact, catalog, suite)) ||
      report.comparison.mode !== suite.comparisonMode
    )
      global.add("invalid_observation");
    if (
      catalog.budget.mode !== "enforce" ||
      !same(report.executionSettings, settings)
    )
      global.add("budget_invalid");
    const expectedPairs = suite.cases
      .flatMap((item) =>
        strategies.map((strategy) => [item.id, item.scenario, strategy]),
      )
      .sort();
    const actualPairs = report.observations
      .map((observation) => [
        observation.caseId,
        observation.scenario,
        observation.strategy,
      ])
      .sort();
    if (
      !same(expectedPairs, actualPairs) ||
      new Set(report.observations.map((observation) => observation.runId))
        .size !== report.observations.length ||
      report.experiments.configured === report.experiments.generic
    )
      global.add("invalid_observation");
    for (const item of suite.cases) {
      const reasons = new Set<NativeQualificationReason>();
      const input = processValueSchema(
        artifact.definition.inputSchema,
      ).safeParse(item.input);
      if (
        item.scenario === "missing_input"
          ? input.success ||
            !hasMissingRequired(artifact.definition.inputSchema, item.input)
          : !input.success
      )
        reasons.add("invalid_input_case");
      if (
        (item.expected.outcome === "succeeded" &&
          !processValueSchema(artifact.definition.outputSchema).safeParse(
            item.expected.output,
          ).success) ||
        (item.expected.outcome !== "succeeded" &&
          item.expected.output !== undefined)
      )
        reasons.add("invalid_output_case");
      if (!fixtureLedger(item, artifact, catalog))
        reasons.add("invalid_observation");
      for (const fixture of item.actions) {
        const action = catalog.services
          .find((service) => service.id === fixture.serviceId)
          ?.actions.find((value) => value.id === fixture.actionId);
        try {
          if (!action || !schemaValidator(action.inputSchema)(fixture.input))
            reasons.add("invalid_input_case");
        } catch {
          reasons.add("invalid_input_case");
        }
      }
      for (const strategy of strategies) {
        const observation = report.observations.find(
          (value) =>
            value.caseId === item.id &&
            value.strategy === strategy &&
            value.scenario === item.scenario,
        );
        if (!observation) {
          reasons.add("invalid_observation");
          continue;
        }
        if (
          !observation.passed ||
          observation.assertions.length ||
          nativeObservableAssertions(item, observation).length ||
          observation.modelCalls !== item.models[strategy].length ||
          observation.reopened !== !!item.reopenAt ||
          !modelBindings(item, strategy, artifact, suite, catalog) ||
          !scriptToolExposure(
            item,
            strategy,
            artifact,
            catalog,
            settings.genericSafetyLimits.maxExposed,
          ) ||
          !scriptedActionLedger(item, strategy, artifact, catalog) ||
          !receiptOutcome(observation) ||
          !terminalOutput(item, observation, artifact) ||
          (observation.observed !== "succeeded" &&
            observation.output !== undefined)
        )
          reasons.add("invalid_observation");
        if (
          observation.observed === "succeeded" &&
          !processValueSchema(artifact.definition.outputSchema).safeParse(
            observation.output,
          ).success
        )
          reasons.add("invalid_output_case");
        const budget = nativePassedBudget(
          item,
          strategy,
          catalog,
          settings.effectiveBudgetLimits,
        );
        const approvalCalls = item.actions.filter(
          (fixture) => fixture.decision !== "none",
        ).length;
        const limitExceeded =
          strategy === "generic"
            ? observation.modelCalls >
                Math.min(
                  settings.genericSafetyLimits.maxModelCalls,
                  settings.genericSafetyLimits.maxInference,
                ) ||
              observation.receipts.length >
                settings.genericSafetyLimits.maxActionCalls
            : observation.modelCalls >
              settings.nativeAgentMaxStepsPerInvocation *
                (agents(artifact).length + approvalCalls);
        if (
          !budget ||
          !same(budget, observation.budget) ||
          limitExceeded ||
          observation.receipts.length > artifact.definition.limits.maxSteps
        )
          reasons.add("budget_invalid");
        if (!semanticCoverage(item, observation, artifact))
          reasons.add("scenario_not_exercised");
      }
      const family = coverage.find(
        (value) => value.scenario === item.scenario,
      )!;
      family.reasons = orderedReasons([...family.reasons, ...reasons]);
    }
  }
  for (const family of coverage) {
    family.reasons = orderedReasons([
      ...family.reasons,
      ...global,
      ...(family.caseIds.length || !family.applicable
        ? []
        : ["missing_scenario" as const]),
    ]);
    family.passed = family.reasons.length === 0;
  }
  return NativeQualificationVerdictSchema.parse({
    policy: PROCESS_NATIVE_QUALIFICATION_POLICY,
    scope: "native_scripted_runtime",
    liveAcceptance: false,
    status: coverage.every((family) => family.passed) ? "qualified" : "failed",
    reasons: orderedReasons(coverage.flatMap((family) => family.reasons)),
    coverage,
  });
}
