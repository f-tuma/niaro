import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientSession } from "../packages/client-core/session";
import {
  PROCESS_OUTPUT_PROFILE,
  PROCESS_OUTPUT_WORK_PROFILE,
  PROCESS_OUTPUT_MAX_PAGE_BYTES,
  ProcessOutputCapabilitiesSchema,
  ProcessOutputPageSchema,
  type ProcessOutputPage,
  type ProcessOutputPath,
} from "../packages/protocol/process-output";
import {
  PROCESS_WORK_PROFILE,
  PROCESS_QUESTION_WORK_PROFILE,
  PROCESS_APPROVAL_WORK_PROFILE,
} from "../packages/protocol/process-work";
import { SnapshotSchema, EventsResponseSchema } from "../packages/protocol";
import {
  ProcessDefinitionSchema,
  type ProcessData,
  type ProcessBinding,
} from "../packages/protocol/service-processes";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { JournalSchema } from "../apps/server-identity/service-process-journal";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { processObject } from "./helpers/service-process";

for (const language of ["en", "cs"] as const)
  test(
    `${language} paired ClientSession negotiates passive full output pages, strict profiles and two owner reopens without commands or effects`,
    { timeout: 90000 },
    async () => {
      const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
      let session: ClientSession | undefined;
      try {
        const credential = await h.pair();
        const properties: Record<string, ProcessData> = {},
          bindings: Record<string, ProcessBinding> = {};
        for (let i = 0; i < 31; i++) {
          const key = "field" + i.toString().padStart(2, "0");
          properties[key] = { type: "string" };
          bindings[key] = { source: "input", path: ["value"] };
        }
        const longKey = "L".repeat(64);
        properties[longKey] = { type: "string" };
        bindings[longKey] = { source: "input", path: ["value"] };
        for (const [key, value] of Object.entries({
          meetingId: "TEST meeting M19",
          businessStatus: "created",
          empty: "",
          false: false,
          zero: 0,
          null: null,
        })) {
          properties[key] =
            value === null
              ? { type: "null" }
              : typeof value === "number"
                ? { type: "number" }
                : typeof value === "boolean"
                  ? { type: "boolean" }
                  : { type: "string" };
          bindings[key] = { source: "literal", value };
        }
        properties.object = processObject();
        bindings.object = { source: "input", path: ["object"] };
        properties.items = { type: "array", items: { type: "string" } };
        bindings.items = { source: "input", path: ["items"] };
        const base = h.workflow();
        const definition = ProcessDefinitionSchema.parse({
          ...base,
          inputSchema: processObject({
            value: { type: "string" },
            object: processObject(),
            items: { type: "array", items: { type: "string" } },
          }),
          outputSchema: processObject(properties),
          entry: "done",
          steps: [{ id: "done", type: "return", output: bindings }],
        });
        const input = {
          value: "\u0000".repeat(4000),
          object: {},
          items: Array.from({ length: 100 }, (_, i) => "TEST item " + i),
        };
        const artifact = h.activate(definition);
        const command = {
          ...(await h.prepare(credential, artifact, input)),
          language,
        };
        const started = await h.mobile(
          credential,
          "processes/commands" + h.suffix,
          command,
        );
        assert.equal(started.status, 202, JSON.stringify(started.data));
        const state = ProcessRuntimeResponseSchema.parse(started.data).process!;
        assert.equal(state.status, "succeeded");
        assert.equal(state.outputTruncated, true);
        const values = new Map<string, string>();
        const sessionRequests: { url: URL; method: string }[] = [];
        session = new ClientSession(
          h.origin + "/v1/" + credential.scope.workspaceId,
          {
            getItem: async (key) => values.get(key) ?? null,
            setItem: async (key, value) => {
              values.set(key, value);
            },
          },
          credential,
          async (url, init) => {
            sessionRequests.push({
              url: new URL(String(url)),
              method: init?.method ?? "GET",
            });
            return fetch(url, init);
          },
          undefined,
          undefined,
          false,
          { processOutputs: true },
        );
        await session.start(false);
        assert.equal(session.getSnapshot().status, "online");
        const capabilityIndex = sessionRequests.findIndex((r) =>
          r.url.pathname.endsWith("/processes/output/capabilities"),
        );
        const snapshotIndex = sessionRequests.findIndex((r) =>
          r.url.pathname.endsWith("/snapshot"),
        );
        assert(capabilityIndex >= 0 && capabilityIndex < snapshotIndex);
        assert.equal(
          sessionRequests[snapshotIndex]!.url.searchParams.get("tasks"),
          PROCESS_OUTPUT_WORK_PROFILE,
        );
        const work = session.getSnapshot().store!.workItems[state.parentRunId]!;
        assert(work.native?.process?.output);
        const reference = work.native.process.output;
        assert.equal(reference.nativeRevision, state.revision);
        assert.deepEqual(reference.scope, credential.scope);
        assert.equal(reference.origin.conversationId, command.conversationId);
        assert.equal(reference.provenance.commandId, command.commandId);
        const requestPath = (
          path: ProcessOutputPath,
          cursor: string | null = null,
        ) =>
          "processes/output?profile=" +
          encodeURIComponent(PROCESS_OUTPUT_PROFILE) +
          "&request=" +
          encodeURIComponent(JSON.stringify({ reference, path, cursor }));
        const baselineCalls = h.ordinaryRuntimeCalls(),
          baselineModel = h.modelCount(),
          baselineWrites = [...h.dispatches];
        const capsPath =
          "processes/output/capabilities?profile=" +
          encodeURIComponent(PROCESS_OUTPUT_PROFILE);
        const caps = await h.mobile(credential, capsPath);
        assert.equal(caps.status, 200);
        assert.deepEqual(ProcessOutputCapabilitiesSchema.parse(caps.data), {
          profile: PROCESS_OUTPUT_PROFILE,
          scope: credential.scope,
          available: true,
          readProfile: PROCESS_OUTPUT_PROFILE,
          workProfile: PROCESS_OUTPUT_WORK_PROFILE,
        });
        assert.equal((await h.mobile(undefined, capsPath)).status, 401);
        assert.equal(
          (
            await h.mobile(
              credential,
              capsPath +
                "&profile=" +
                encodeURIComponent(PROCESS_OUTPUT_PROFILE),
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await h.mobile(
              credential,
              "processes/output/capabilities?profile=bad",
            )
          ).status,
          406,
        );
        assert.equal(
          (await h.mobile(credential, capsPath, { unexpected: true })).status,
          405,
        );
        const all: Record<string, unknown> = {};
        const cachedBeforePages = [...values];
        let cursor: string | null = null,
          offset = 0,
          pages = 0;
        do {
          const page: ProcessOutputPage = await session.loadProcessOutputPage(
            { reference, path: [], cursor },
            offset,
          );
          assert.equal(page.offset, offset);
          assert.equal(page.total, 40);
          assert(
            Buffer.byteLength(JSON.stringify(page)) <=
              PROCESS_OUTPUT_MAX_PAGE_BYTES,
          );
          for (const child of page.children) {
            assert(child.label);
            if ("value" in child.node) all[child.label] = child.node.value;
            else all[child.label] = child.node.kind;
          }
          offset += page.children.length;
          cursor = page.nextCursor;
          pages++;
        } while (cursor);
        assert.equal(offset, 40);
        assert(pages > 1);
        assert.equal(all.meetingId, "TEST meeting M19");
        assert.equal(all.businessStatus, "created");
        assert.equal(all.empty, "");
        assert.equal(all.false, false);
        assert.equal(all.zero, 0);
        assert.equal(all.null, null);
        assert.equal(all[longKey], input.value);
        assert.equal(all.object, "object");
        assert.equal(all.items, "array");
        assert.deepEqual([...values], cachedBeforePages);
        assert(sessionRequests.every((r) => r.method === "GET"));
        const canonical = JournalSchema.parse(
          h.identity["catalog"].store.turn(
            state.parentRunId,
            credential.scope.workspaceId,
            credential.scope.userId,
          ),
        );
        assert(Buffer.byteLength(JSON.stringify(canonical.output)) > 65536);
        const parent = ProcessOutputPageSchema.parse(
          (await h.mobile(credential, requestPath([]))).data,
        );
        assert.equal(
          (await h.mobile(credential, requestPath([]) + "&unknown=1")).status,
          400,
        );
        assert.equal(
          (await h.mobile(credential, requestPath([]) + "&request={}")).status,
          400,
        );
        const changed =
          "processes/output?profile=" +
          encodeURIComponent(PROCESS_OUTPUT_PROFILE) +
          "&request=" +
          encodeURIComponent(
            JSON.stringify({
              reference: {
                ...reference,
                nativeRevision: reference.nativeRevision + 1,
              },
              path: [],
              cursor: null,
            }),
          );
        assert.equal((await h.mobile(credential, changed)).status, 409);
        assert.equal(
          (
            await h.mobile(
              credential,
              requestPath([{ kind: "item", index: 0 }]),
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await h.mobile(
              credential,
              requestPath([{ kind: "property", index: 0 }], parent.nextCursor),
            )
          ).status,
          409,
        );
        assert.deepEqual(h.dispatches, baselineWrites);
        assert.equal(h.modelCount(), baselineModel);
        assert.equal(h.ordinaryRuntimeCalls(), baselineCalls);
        for (const profile of [
          PROCESS_WORK_PROFILE,
          PROCESS_QUESTION_WORK_PROFILE,
          PROCESS_APPROVAL_WORK_PROFILE,
        ]) {
          const path = "?tasks=" + encodeURIComponent(profile);
          const old = SnapshotSchema.parse(
            (await h.mobile(credential, "snapshot" + path)).data,
          ).workItems.find((w) => w.id === state.parentRunId)!;
          assert.equal(old.native!.process!.output, undefined);
          assert.equal(old.native!.process!.outputSummary, undefined);
          const events = EventsResponseSchema.parse(
            (await h.mobile(credential, "events" + path + "&after=0")).data,
          ).events;
          for (const event of events)
            if (
              event.type === "work_item.upserted" &&
              event.entity.id === state.parentRunId
            )
              assert.equal(event.entity.native!.process!.output, undefined);
        }
        const stableJournal = structuredClone(canonical);
        const baselineReceipts = h.identity["db"]
          .prepare("SELECT * FROM agent_process_start_command ORDER BY rowid")
          .all();
        for (let i = 0; i < 2; i++) {
          await h.restart();
          await session.refresh();
          assert.equal(session.getSnapshot().status, "online");
          assert.deepEqual(
            session.getSnapshot().store!.workItems[state.parentRunId]!.native!
              .process!.output,
            reference,
          );
          assert.deepEqual(
            await session.loadProcessOutputPage(
              { reference, path: [], cursor: null },
              0,
            ),
            parent,
          );
          const next = await h.mobile(credential, requestPath([]));
          assert.equal(next.status, 200);
          assert.deepEqual(ProcessOutputPageSchema.parse(next.data), parent);
          assert.deepEqual(
            JournalSchema.parse(
              h.identity["catalog"].store.turn(
                state.parentRunId,
                credential.scope.workspaceId,
                credential.scope.userId,
              ),
            ),
            stableJournal,
          );
          assert.deepEqual(
            h.identity["db"]
              .prepare(
                "SELECT * FROM agent_process_start_command ORDER BY rowid",
              )
              .all(),
            baselineReceipts,
          );
        }
        assert.equal(h.modelCount(), 0);
        assert.deepEqual(h.dispatches, []);
        assert(sessionRequests.every((r) => r.method === "GET"));
        assert.equal(
          sessionRequests.filter((r) =>
            r.url.pathname.endsWith("/processes/output/capabilities"),
          ).length,
          1,
        );
      } finally {
        session?.stop();
        await h.close();
      }
    },
  );
