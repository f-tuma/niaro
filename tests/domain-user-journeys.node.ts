import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  designHttpFixture,
  designHttpPath,
} from "./helpers/process-design-http";
import {
  addStep,
  createWorkflow,
} from "../apps/server-admin/web/lib/process-editor";
import {
  DesignCapabilitiesSchema,
  emptyDesignBrief,
} from "../packages/protocol/process-design";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import {
  fixture as runtimeFixture,
  admin,
} from "./helpers/service-process-runtime";
import { processObject, processWorkflow } from "./helpers/service-process";
import { processValueSchema } from "../packages/protocol/service-processes";

// Synthetic HTTP fixtures verify both the editor and the authoritative refusal.
test("finite string pattern proofs preserve constraints, regex semantics and evaluation bounds", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "niaro-pattern-proof-"));
  const h = runtimeFixture(join(root, "identity.sqlite"));
  const cases: {
    name: string;
    field: object;
    literal?: string | boolean;
    values?: string[];
    valid: boolean;
    defs?: object;
  }[] = [
    {
      name: "matching finite enum",
      field: { type: "string", pattern: "^TEST-[A-Z]+$" },
      values: ["TEST-A", "TEST-B"],
      valid: true,
    },
    {
      name: "every enum alternative is proved",
      field: { type: "string", pattern: "^TEST-[A-Z]+$" },
      values: ["TEST-A", "bad"],
      valid: false,
    },
    {
      name: "unconstrained strings remain unproven",
      field: { type: "string", pattern: "^TEST" },
      valid: false,
    },
    {
      name: "patterns do not accept nonstring values",
      field: { type: "string", pattern: "^TEST" },
      literal: true,
      valid: false,
    },
    {
      name: "local refs retain pattern and enum constraints",
      field: { $ref: "#/$defs/title" },
      defs: {
        title: { type: "string", pattern: "^TEST-[A-Z]+$", enum: ["TEST-A"] },
      },
      literal: "TEST-A",
      valid: true,
    },
    {
      name: "a matching pattern cannot override a referenced enum",
      field: { $ref: "#/$defs/title" },
      defs: {
        title: { type: "string", pattern: "^TEST-[A-Z]+$", enum: ["TEST-A"] },
      },
      literal: "TEST-B",
      valid: false,
    },
    {
      name: "ref siblings remain conjunctive",
      field: { $ref: "#/$defs/title", pattern: "^TEST-A$" },
      defs: { title: { type: "string", pattern: "^TEST-[A-Z]+$" } },
      literal: "TEST-B",
      valid: false,
    },
    {
      name: "matching allOf constraints",
      field: {
        type: "string",
        allOf: [{ pattern: "^TEST-[A-Z]+$" }, { enum: ["TEST-A"] }],
      },
      literal: "TEST-A",
      valid: true,
    },
    {
      name: "allOf cannot hide a rejected enum",
      field: {
        type: "string",
        allOf: [{ pattern: "^TEST-[A-Z]+$" }, { enum: ["TEST-A"] }],
      },
      literal: "TEST-B",
      valid: false,
    },
    {
      name: "a matching anyOf branch",
      field: {
        type: "string",
        anyOf: [{ pattern: "^TEST-A$" }, { pattern: "^TEST-B$" }],
      },
      literal: "TEST-A",
      valid: true,
    },
    {
      name: "no matching anyOf branch",
      field: {
        type: "string",
        anyOf: [{ pattern: "^TEST-A$" }, { pattern: "^TEST-B$" }],
      },
      literal: "bad",
      valid: false,
    },
    {
      name: "oneOf remains outside the process proof grammar",
      field: {
        type: "string",
        oneOf: [{ pattern: "^TEST-A$" }, { pattern: "^TEST-B$" }],
      },
      literal: "TEST-A",
      valid: false,
    },
    {
      name: "dot retains catalog newline semantics",
      field: { type: "string", pattern: "^a.b$" },
      literal: "a\nb",
      valid: false,
    },
    {
      name: "nonanchored pattern retains catalog search semantics",
      field: { type: "string", pattern: "TEST" },
      literal: "prefixTESTsuffix",
      valid: true,
    },
    {
      name: "matching work beyond the catalog evaluation budget fails closed",
      field: { type: "string", pattern: "a{1000}" },
      literal: "a".repeat(4000),
      valid: false,
    },
    {
      name: "budget exhaustion cannot be rescued by anyOf fallback",
      field: {
        type: "string",
        anyOf: [{ pattern: "a{1000}" }, { type: "string" }],
      },
      literal: "a".repeat(4000),
      valid: false,
    },
    {
      name: "catalog minLength counts Unicode code points",
      field: { type: "string", pattern: "^.$", minLength: 2 },
      literal: "😀",
      valid: false,
    },
    {
      name: "catalog maxLength accepts one Unicode code point",
      field: { type: "string", pattern: "^.$", maxLength: 1 },
      literal: "😀",
      valid: true,
    },
    {
      name: "referenced pattern cannot bypass Unicode length siblings",
      field: { $ref: "#/$defs/title", minLength: 2 },
      defs: { title: { type: "string", pattern: "^.$" } },
      literal: "😀",
      valid: false,
    },
    {
      name: "const and enum are both required",
      field: {
        type: "string",
        pattern: "^TEST-[A-Z]+$",
        const: "TEST-A",
        enum: ["TEST-B"],
      },
      literal: "TEST-A",
      valid: false,
    },
    {
      name: "compatible const and enum constraints both hold",
      field: {
        type: "string",
        pattern: "^TEST-[A-Z]+$",
        const: "TEST-A",
        enum: ["TEST-A", "TEST-B"],
      },
      literal: "TEST-A",
      valid: true,
    },
  ];
  try {
    for (const item of cases)
      await t.test(item.name, () => {
        const service = h.catalog.service(admin.workspaceId, h.ids.serviceId);
        const action = service.actions.find((a) => a.id === h.ids.readId)!;
        const {
          id: _id,
          revision: _revision,
          sourceKey: _sourceKey,
          ...settings
        } = action;
        h.catalog.command(
          CatalogCommand.parse({
            organizationId: admin.organizationId,
            workspaceId: admin.workspaceId,
            type: "saveAction",
            serviceId: service.id,
            serviceRevision: service.revision,
            id: action.id,
            revision: action.revision,
            settings: {
              ...settings,
              inputSchema: {
                type: "object",
                properties: { name: item.field },
                required: ["name"],
                additionalProperties: false,
                ...(item.defs ? { $defs: item.defs } : {}),
              },
            },
          }),
        );
        const definition = processWorkflow(service.id, action.id);
        assert.equal(definition.kind, "workflow");
        if (definition.kind !== "workflow") throw Error("TEST workflow");
        if (item.values)
          definition.inputSchema = processObject({
            name: { type: "string", enum: item.values },
          });
        if (item.literal !== undefined) {
          const step = definition.steps.find((s) => s.type === "action")!;
          step.input.name = { source: "literal", value: item.literal };
        }
        const validation = h.registry.validate(admin, service.id, definition);
        assert.equal(
          validation.valid,
          item.valid,
          JSON.stringify(validation.issues),
        );
        if (!item.valid)
          assert(
            validation.issues.some(
              (issue) => issue.code === "binding_type_unproven",
            ),
          );
      });
    await t.test(
      "portable process output lengths agree with runtime Unicode semantics",
      () => {
        const definition = processWorkflow(h.ids.serviceId, h.ids.readId);
        assert.equal(definition.kind, "workflow");
        if (definition.kind !== "workflow") throw Error("TEST workflow");
        definition.inputSchema = processObject({});
        definition.outputSchema = processObject({
          result: { type: "string", minLength: 2, maxLength: 2 },
        });
        definition.entry = "done";
        definition.steps = [
          {
            id: "done",
            type: "return",
            output: { result: { source: "literal", value: "😀" } },
          },
        ];
        assert.equal(
          h.registry.validate(admin, h.ids.serviceId, definition).valid,
          false,
        );
        assert.equal(
          processValueSchema(definition.outputSchema).safeParse({
            result: "😀",
          }).success,
          false,
        );
        definition.outputSchema = processObject({
          result: { type: "string", maxLength: 1 },
        });
        assert.equal(
          h.registry.validate(admin, h.ids.serviceId, definition).valid,
          true,
        );
        assert.equal(
          processValueSchema(definition.outputSchema).safeParse({
            result: "😀",
          }).success,
          true,
        );
      },
    );
    assert.deepEqual(h.counts(), []);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("novice Add action refuses unavailable schemas and selects the next supported action", async () => {
  const h = await designHttpFixture();
  try {
    const service = h.identity["catalog"].store.service(
      h.target.workspaceId,
      h.serviceId,
    );
    const action = service.actions.find((a) => a.id === h.actionId)!;
    const {
      id: _id,
      revision: _revision,
      sourceKey: _sourceKey,
      ...settings
    } = action;
    const updated = await h.request("owner", "api/identity/catalog/command", {
      ...h.target,
      type: "saveAction",
      serviceId: h.serviceId,
      serviceRevision: service.revision,
      id: action.id,
      revision: action.revision,
      settings: {
        ...settings,
        inputSchema: {
          type: "object",
          properties: { password: { type: "string" } },
          required: ["password"],
          additionalProperties: false,
        },
      },
    });
    assert.equal(updated.status, 200);
    const response = await h.request(
      "owner",
      designHttpPath + "/capabilities?" + h.query,
    );
    assert.equal(response.status, 200);
    const capabilities = DesignCapabilitiesSchema.parse(
      h.record(response.data).capabilities,
    );
    const unavailable = capabilities.services
      .flatMap((s) => s.actions)
      .find((a) => a.id === h.actionId)!;
    assert.equal(unavailable.status, "configured");
    assert.equal(unavailable.schemaUnavailable, "sensitive_fields");
    assert.throws(
      () => addStep(createWorkflow(capabilities), "action", capabilities),
      /process_editor_capability_unavailable/,
    );
    const supportedId = await h.catalog({
      type: "saveAction",
      serviceId: h.serviceId,
      serviceRevision: h.identity["catalog"].store.service(
        h.target.workspaceId,
        h.serviceId,
      ).revision,
      revision: 0,
      settings,
    });
    const refreshed = await h.request(
      "owner",
      designHttpPath + "/capabilities?" + h.query,
    );
    const supported = DesignCapabilitiesSchema.parse(
      h.record(refreshed.data).capabilities,
    );
    const draft = addStep(createWorkflow(supported), "action", supported);
    const selected = draft.steps.find((s) => s.type === "action")!;
    assert.equal(selected.actionId, supportedId);
    // A handcrafted/imported candidate still cannot bypass server review.
    selected.actionId = unavailable.id;
    const started = await h.request("owner", designHttpPath + "/start", {
      ...h.target,
      serviceId: h.serviceId,
      requestId: randomUUID(),
    });
    assert.equal(started.status, 200);
    const review = h.record(h.record(started.data).review);
    const saved = await h.request("owner", designHttpPath + "/update", {
      ...h.target,
      sessionId: review.id,
      requestId: randomUUID(),
      revision: review.revision,
      brief: { ...emptyDesignBrief(), purpose: "TEST novice visual lookup" },
      candidate: draft,
    });
    assert.equal(saved.status, 200);
    const current = h.record(h.record(saved.data).review);
    assert(
      (current.blockers as string[]).includes("capability_schema_unavailable"),
    );
    assert.equal(h.businessCount(), 0);
  } finally {
    await h.close();
  }
});

test("a projected pattern action accepts matching literals and refuses nonmatching or unconstrained bindings", async () => {
  const h = await designHttpFixture();
  try {
    const service = h.identity["catalog"].store.service(
      h.target.workspaceId,
      h.serviceId,
    );
    const action = service.actions.find((a) => a.id === h.actionId)!;
    const {
      id: _id,
      revision: _revision,
      sourceKey: _sourceKey,
      ...settings
    } = action;
    const updated = await h.request("owner", "api/identity/catalog/command", {
      ...h.target,
      type: "saveAction",
      serviceId: h.serviceId,
      serviceRevision: service.revision,
      id: action.id,
      revision: action.revision,
      settings: {
        ...settings,
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", pattern: "^TEST-[A-Z]+$" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    });
    assert.equal(updated.status, 200);
    const capabilitiesResponse = await h.request(
      "owner",
      designHttpPath + "/capabilities?" + h.query,
    );
    const capabilities = DesignCapabilitiesSchema.parse(
      h.record(capabilitiesResponse.data).capabilities,
    );
    const projected = capabilities.services
      .flatMap((s) => s.actions)
      .find((a) => a.id === h.actionId)!;
    assert.equal(projected.status, "configured");
    assert.equal(projected.schemaUnavailable, null);
    for (const scenario of [
      "matching",
      "nonmatching",
      "unconstrained",
    ] as const) {
      const draft = h.workflow();
      assert.equal(draft.kind, "workflow");
      if (draft.kind !== "workflow") throw Error("TEST workflow fixture");
      const first = draft.steps.find((s) => s.type === "action")!;
      if (scenario !== "unconstrained")
        first.input.name = {
          source: "literal",
          value: scenario === "matching" ? "TEST-MATCHING" : "bad",
        };
      const started = await h.request("owner", designHttpPath + "/start", {
        ...h.target,
        serviceId: h.serviceId,
        requestId: randomUUID(),
      });
      const review = h.record(h.record(started.data).review);
      const saved = await h.request("owner", designHttpPath + "/update", {
        ...h.target,
        sessionId: review.id,
        requestId: randomUUID(),
        revision: review.revision,
        brief: {
          ...emptyDesignBrief(),
          purpose: "TEST use a matching pattern value",
        },
        candidate: draft,
      });
      assert.equal(saved.status, 200);
      const current = h.record(h.record(saved.data).review);
      const validation = h.record(current.validation);
      assert.equal(validation.valid, scenario === "matching");
      if (scenario !== "matching")
        assert(
          (validation.issues as { code: string }[]).some(
            (i) => i.code === "binding_type_unproven",
          ),
        );
      const accepted = await h.request("owner", designHttpPath + "/accept", {
        ...h.target,
        sessionId: current.id,
        requestId: randomUUID(),
        revision: current.revision,
        reviewDigest: current.reviewDigest,
      });
      assert.equal(
        accepted.status,
        scenario === "matching" ? 200 : 400,
        JSON.stringify(accepted.data),
      );
      if (scenario === "matching") assert(h.record(accepted.data).receipt);
      else
        assert.equal(h.record(accepted.data).error, "process_design_not_ready");
    }
    assert.equal(h.businessCount(), 0);
  } finally {
    await h.close();
  }
});
