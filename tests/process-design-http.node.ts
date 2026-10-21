import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  emptyDesignBrief,
  DesignReviewSchema,
  DesignTurnSchema,
  DesignCapabilitiesSchema,
} from "../packages/protocol/process-design";
import { ProcessListSchema } from "../packages/protocol/service-processes";
import {
  designHttpFixture,
  designHttpPath as base,
} from "./helpers/process-design-http";

test("authenticated designer HTTP preserves scope, native replay and shutdown boundaries", async (t) => {
  const h = await designHttpFixture();
  const review = (data: unknown) =>
    DesignReviewSchema.parse(h.record(data).review);
  const turn = (data: unknown) => DesignTurnSchema.parse(h.record(data).turn);
  let sequence = 0;
  const start = async () => {
    const response = await h.request("owner", base + "/start", {
      ...h.target,
      requestId: "TEST-start-" + ++sequence,
      serviceId: h.serviceId,
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return review(response.data);
  };
  const query = (sessionId: string, requestId?: string) =>
    new URLSearchParams({
      ...h.target,
      sessionId,
      ...(requestId ? { requestId } : {}),
    }).toString();
  const command = (sessionId: string, requestId: string) => ({
    ...h.target,
    sessionId,
    requestId,
    revision: 1,
    modelId: h.modelId,
    text: "TEST native HTTP request",
    language: "cs" as const,
  });
  try {
    await t.test(
      "metadata capabilities, creator-private review and exact human acceptance stay passive",
      async () => {
        const capabilities = base + "/capabilities?" + h.query;
        for (const [role, status] of [
          ["owner", 200],
          ["admin", 200],
          // Members design personal processes with their own grants.
          ["member", 200],
          ["operator", 403],
          ["anonymous", 401],
        ] as const)
          assert.equal((await h.request(role, capabilities)).status, status);
        const safe = JSON.stringify(
          (await h.request("owner", capabilities)).data,
        );
        DesignCapabilitiesSchema.parse(
          h.record((await h.request("owner", capabilities)).data).capabilities,
        );
        assert(!safe.includes("TEST-HTTP-provider-key"));
        assert(!safe.includes("https://models.example.test"));
        assert(!safe.includes("https://services.example.test"));
        const initial = await start();
        const get = base + "?" + query(initial.id);
        assert.equal((await h.request("admin", get)).status, 404);
        const update = {
          ...h.target,
          sessionId: initial.id,
          requestId: "TEST-human-update",
          revision: 1,
          brief: {
            ...emptyDesignBrief(),
            purpose: "TEST lookup workflow",
            assumptions: [
              { id: "confirmed_input", text: "TEST user provides a name" },
            ],
          },
          candidate: h.workflow(),
        };
        assert.equal(
          (await h.request("admin", base + "/update", update)).status,
          404,
        );
        assert.equal(
          (
            await h.request("owner", base + "/update", {
              ...update,
              actor: "forged",
            })
          ).status,
          400,
        );
        const editedResponse = await h.request(
          "owner",
          base + "/update",
          update,
        );
        assert.equal(
          editedResponse.status,
          200,
          JSON.stringify(editedResponse.data),
        );
        const edited = review(editedResponse.data);
        assert(edited.blockers.includes("assumptions_unacknowledged"));
        const acknowledged = await h.request("owner", base + "/acknowledge", {
          ...h.target,
          sessionId: initial.id,
          requestId: "TEST-human-ack",
          revision: edited.revision,
          assumptions: edited.assumptions.map((a) => ({
            id: a.id,
            digest: a.digest,
          })),
        });
        assert.equal(
          acknowledged.status,
          200,
          JSON.stringify(acknowledged.data),
        );
        const checked = review(acknowledged.data);
        const accept = {
          ...h.target,
          sessionId: initial.id,
          requestId: "TEST-human-accept",
          revision: checked.revision,
          reviewDigest: checked.reviewDigest,
        };
        const saved = await h.request("owner", base + "/accept", accept);
        assert.equal(saved.status, 200, JSON.stringify(saved.data));
        const replay = await h.request("owner", base + "/accept", accept);
        assert.deepEqual(
          h.record(replay.data).receipt,
          h.record(saved.data).receipt,
        );
        const processes = ProcessListSchema.parse(
          (
            await h.request(
              "owner",
              "api/identity/catalog/processes?" + h.query,
            )
          ).data,
        );
        assert.equal(processes.processes.length, 1);
        assert.equal(processes.processes[0]!.activeVersion, null);
        for (const suffix of [
          "/test",
          "/activate",
          "/run",
          "/resume",
          "-foreign",
        ])
          assert.equal(
            (await h.request("owner", base + suffix, accept)).status,
            404,
          );
        assert.equal(h.modelCount(), 0);
        assert.equal(h.businessCount(), 0);
      },
    );
    await t.test(
      "HTTP rejects forged scope, CSRF, wrong content, malformed and oversized bodies",
      async () => {
        const endpoint = base + "/capabilities?" + h.query;
        assert.equal(
          (
            await h.request("owner", endpoint, undefined, {
              headers: { Origin: "https://foreign.example.test" },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await h.request("owner", endpoint, undefined, {
              headers: { Host: "foreign.example.test" },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await h.request("owner", endpoint, undefined, {
              headers: { "Sec-Fetch-Site": "cross-site" },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await h.request(
              "owner",
              base + "/start",
              {},
              { headers: { "Content-Type": "text/plain" } },
            )
          ).status,
          403,
        );
        assert.equal(
          (await h.request("owner", base + "/start", undefined, { raw: "{" }))
            .status,
          400,
        );
        assert.equal(
          (
            await h.request("owner", base + "/start", undefined, {
              raw: JSON.stringify({ text: "x".repeat(131073) }),
            })
          ).status,
          413,
        );
        assert.equal(
          (
            await h.request(
              "owner",
              base +
                "/capabilities?" +
                new URLSearchParams({
                  ...h.target,
                  organizationId: "TEST-foreign",
                }),
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await h.request(
              "owner",
              base +
                "/capabilities?" +
                new URLSearchParams({
                  ...h.target,
                  workspaceId: "33333333-3333-4333-8333-333333333333",
                }),
            )
          ).status,
          404,
        );
        assert.equal(
          (await h.request("owner", endpoint + "&role=owner")).status,
          400,
        );
        assert.equal(h.modelCount(), 0);
      },
    );
    await t.test(
      "disconnect after the body ends never admits a native turn",
      async () => {
        const initial = await start();
        const input = command(initial.id, "TEST-disconnect-before-admission");
        const count = h.modelCount();
        h.disconnectNextTurnAtBodyEnd();
        await assert.rejects(h.request("owner", base + "/turns", input));
        await delay(30);
        const current = await h.request(
          "owner",
          base + "/turns?" + query(initial.id, input.requestId),
        );
        assert.equal(current.status, 404, JSON.stringify(current.data));
        assert.equal(h.modelCount(), count);
        assert.equal(h.businessCount(), 0);
      },
    );
    await t.test(
      "native POST runs outside the queue; polling/concurrent replay never reinfers",
      async () => {
        const initial = await start();
        const input = command(initial.id, "TEST-gated-turn");
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const ready = new Promise<void>((r) => {
          entered = r;
        });
        h.onModel(async () => {
          entered();
          await gate;
          return { content: "TEST completed native design" };
        });
        const pending = h.request("owner", base + "/turns", input);
        await ready;
        const get = base + "/turns?" + query(initial.id, input.requestId);
        const running = await h.request("owner", get);
        assert.equal(running.status, 200);
        assert.equal(turn(running.data).status, "running");
        assert.deepEqual(turn(running.data).model, {
          id: h.modelId,
          revision: 1,
          providerId: h.providerId,
          providerRevision: 1,
        });
        assert.equal((await h.request("admin", get)).status, 404);
        const duplicate = await h.request("owner", base + "/turns", input);
        assert.equal(duplicate.status, 200);
        assert.equal(turn(duplicate.data).status, "running");
        assert.equal(
          (
            await h.request("owner", base + "/turns", {
              ...input,
              text: "TEST changed same command",
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await h.request("owner", base + "/turns", {
              ...input,
              requestId: "TEST-concurrent-new",
            })
          ).status,
          429,
        );
        assert.equal(h.modelCount(), 1);
        release();
        const result = await pending;
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(turn(result.data).status, "completed");
        assert.deepEqual(
          turn((await h.request("owner", base + "/turns", input)).data),
          turn(result.data),
        );
        await h.restart();
        assert.deepEqual(
          turn((await h.request("owner", base + "/turns", input)).data),
          turn(result.data),
        );
        const history = h.record(
          (await h.request("owner", base + "/turns/list?" + query(initial.id)))
            .data,
        ).turns as unknown[];
        assert.deepEqual(
          history.map((item) => DesignTurnSchema.parse(item).model),
          [turn(result.data).model],
        );
        assert.equal(h.modelCount(), 1);
        assert.equal(h.businessCount(), 0);
        h.onModel(() => ({ content: "TEST design HTTP reply" }));
      },
    );
    await t.test(
      "header drift during inference cannot rebind the creator or publish a reply",
      async () => {
        for (const header of ["cookie", "content-type"]) {
          const initial = await start(),
            input = command(initial.id, "TEST-header-drift-" + header);
          h.onModel(() => {
            h.mutateTurnHeader(header, "TEST-forged-header");
            return { content: "TEST withheld reply" };
          });
          const response = await h.request("owner", base + "/turns", input);
          assert.equal(response.status, 403);
          const stored = turn(
            (
              await h.request(
                "owner",
                base + "/turns?" + query(initial.id, input.requestId),
              )
            ).data,
          );
          assert.equal(stored.status, "failed");
          assert.equal(stored.failure, "identity_forbidden");
          assert.equal(stored.reply, null);
          assert.equal(stored.userText, input.text);
        }
        h.onModel(() => ({ content: "TEST design HTTP reply" }));
      },
    );
    await t.test(
      "native HTTP clarification and correction use only design tools and one stored proposal",
      async () => {
        const initial = await start();
        let calls = 0;
        h.onModel(() =>
          ++calls === 1
            ? {
                content: null,
                tool_calls: [
                  {
                    id: "TEST-http-design-tool",
                    type: "function",
                    function: {
                      name: "design_update_proposal",
                      arguments: JSON.stringify({
                        revision: 1,
                        brief: {
                          ...emptyDesignBrief(),
                          purpose: "TEST prepared workflow",
                        },
                        candidate: h.workflow(),
                      }),
                    },
                  },
                ],
              }
            : { content: "TEST workflow prepared for human review" },
        );
        const input = command(initial.id, "TEST-http-structured-proposal");
        const first = await h.request("owner", base + "/turns", input);
        assert.equal(first.status, 200, JSON.stringify(first.data));
        assert.equal(turn(first.data).status, "completed");
        assert.equal(turn(first.data).revision, 2);
        assert.equal(
          turn(first.data).toolReceipts[0]?.name,
          "design_update_proposal",
        );
        const prepared = review(
          (await h.request("owner", base + "?" + query(initial.id))).data,
        );
        assert.equal(prepared.candidate?.name, h.workflow().name);
        h.onModel((body) => {
          assert(
            JSON.stringify(body.messages).includes("TEST prepared workflow"),
          );
          return {
            content: "TEST correction discussed without executing workflow",
          };
        });
        const next = await h.request("owner", base + "/turns", {
          ...input,
          requestId: "TEST-http-correction",
          revision: 2,
          text: "TEST keep the configured lookup and discuss its name",
        });
        assert.equal(next.status, 200, JSON.stringify(next.data));
        assert.equal(turn(next.data).status, "completed");
        assert.equal(turn(next.data).revision, 2);
        const publicRegistry = ProcessListSchema.parse(
          (
            await h.request(
              "owner",
              "api/identity/catalog/processes?" + h.query,
            )
          ).data,
        );
        assert.equal(
          publicRegistry.processes.length,
          1,
          "Only earlier human accept created a registry draft",
        );
        assert.equal(h.businessCount(), 0);
        h.onModel(() => ({ content: "TEST design HTTP reply" }));
      },
    );
    await t.test(
      "sign-out during inference revokes the pinned account session and preserves failure",
      async () => {
        const initial = await start(),
          input = command(initial.id, "TEST-session-revoked");
        h.onModel(async () => {
          assert.equal(
            (await h.request("owner", "auth/sign-out", {})).status,
            200,
          );
          return { content: "TEST revoked-session reply" };
        });
        const response = await h.request("owner", base + "/turns", input);
        assert.equal(response.status, 401);
        const signedIn = await h.request("owner", "auth/sign-in/email", {
          email: "owner@example.test",
          password: "TEST-design-HTTP-password-only-2026",
        });
        assert.equal(signedIn.status, 200);
        const stored = turn(
          (
            await h.request(
              "owner",
              base + "/turns?" + query(initial.id, input.requestId),
            )
          ).data,
        );
        assert.equal(stored.status, "failed");
        assert.equal(stored.failure, "identity_unauthorized");
        assert.equal(stored.reply, null);
        assert.equal(stored.userText, input.text);
        h.onModel(() => ({ content: "TEST design HTTP reply" }));
      },
    );
    await t.test(
      "client abort interrupts tracked native work and preserves the submitted message",
      async () => {
        const initial = await start(),
          input = command(initial.id, "TEST-client-abort");
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const ready = new Promise<void>((r) => {
          entered = r;
        });
        h.onModel(async () => {
          entered();
          await gate;
          return { content: "TEST stopped reply" };
        });
        const abort = new AbortController();
        const pending = h
          .request("owner", base + "/turns", input, { signal: abort.signal })
          .catch(() => undefined);
        await ready;
        abort.abort();
        await pending;
        await delay(30);
        release();
        let result;
        for (let i = 0; i < 100; i++) {
          const current = await h.request(
            "owner",
            base + "/turns?" + query(initial.id, input.requestId),
          );
          assert.equal(current.status, 200);
          result = turn(current.data);
          if (result.status !== "running") break;
          await delay(20);
        }
        assert.equal(result?.status, "interrupted");
        assert.equal(result.failure, "process_design_interrupted");
        assert.equal(result.reply, null);
        assert.equal(result.userText, input.text);
        h.onModel(() => ({ content: "TEST design HTTP reply" }));
      },
    );
    await t.test(
      "shutdown waits tracked cleanup, rejects new admission and keeps stopped outcome on reopen",
      async () => {
        const initial = await start(),
          input = command(initial.id, "TEST-shutdown");
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const ready = new Promise<void>((r) => {
          entered = r;
        });
        h.onModel(async () => {
          entered();
          await gate;
          return { content: "TEST stopped by server" };
        });
        const pending = h.request("owner", base + "/turns", input);
        await ready;
        // Checked while the owner is stopped, not after a pause: a fast
        // machine finishes the whole restart within any fixed delay.
        let refused = 0;
        await h.restart(async () => {
          refused = (
            await h.request("owner", base + "/capabilities?" + h.query)
          ).status;
        });
        assert.equal(refused, 503);
        release();
        await pending;
        const response = await h.request(
          "owner",
          base + "/turns?" + query(initial.id, input.requestId),
        );
        assert.equal(response.status, 200, JSON.stringify(response.data));
        const stored = turn(response.data);
        assert.equal(stored.status, "interrupted");
        assert.equal(stored.reply, null);
        assert.equal(stored.userText, input.text);
        const count = h.modelCount();
        assert.deepEqual(
          turn((await h.request("owner", base + "/turns", input)).data),
          stored,
        );
        assert.equal(h.modelCount(), count);
        assert.equal(h.businessCount(), 0);
      },
    );

    for (const change of ["service", "provider", "budget"] as const)
      await t.test(
        `HTTP withholds the native reply when ${change} changes during inference`,
        async () => {
          const count = h.modelCount();
          const started = await h.request("owner", base + "/start", {
            ...h.target,
            requestId: "TEST-start-pins-" + change,
            serviceId: h.serviceId,
          });
          assert.equal(started.status, 200);
          const initial = DesignReviewSchema.parse(
            h.record(started.data).review,
          );
          const input = {
            ...h.target,
            sessionId: initial.id,
            requestId: "TEST-changed-pin-" + change,
            revision: 1,
            modelId: h.modelId,
            text: "TEST keep the original design settings",
          };
          h.onModel(async () => {
            if (change === "service")
              await h.catalog({
                type: "saveService",
                id: h.serviceId,
                revision: 2,
                settings: {
                  name: "TEST design service",
                  url: "https://services.example.test/v1",
                  protocol: "openapi",
                  icon: "database",
                  auth: { type: "none" },
                  enabled: false,
                },
              });
            else if (change === "provider")
              await h.catalog({
                type: "saveProvider",
                id: h.providerId,
                revision: 1,
                settings: {
                  name: "TEST changed provider",
                  url: "https://models.example.test/v1",
                  enabled: true,
                  dailyRequestLimit: 100,
                },
              });
            else {
              const changed = await h.request(
                "owner",
                "api/identity/catalog/budget",
                {
                  ...h.target,
                  revision: 2,
                  settings: {
                    ...h.budgetSettings,
                    prices: h.budgetSettings.prices.map((price) => ({
                      ...price,
                      providerRevision: 2,
                    })),
                    maxTokens: h.budgetSettings.maxTokens - 1,
                  },
                },
              );
              assert.equal(changed.status, 200, JSON.stringify(changed.data));
            }
            return { content: "TEST stale reply must stay private" };
          });
          const response = await h.request("owner", base + "/turns", input);
          assert.equal(response.status, 200, JSON.stringify(response.data));
          const stored = DesignTurnSchema.parse(h.record(response.data).turn);
          assert.equal(stored.status, "failed");
          const failure =
            change === "service"
              ? "process_design_service_unavailable"
              : change === "provider"
                ? "process_design_model_changed"
                : "catalog_budget_policy_changed";
          assert.equal(stored.failure, failure);
          assert.deepEqual(
            stored.model,
            {
              id: h.modelId,
              revision: 1,
              providerId: h.providerId,
              providerRevision: change === "budget" ? 2 : 1,
            },
            "Recorded history retains the original pin after provider revisions change",
          );
          assert.equal(stored.reply, null);
          assert.equal(stored.userText, input.text);
          const replay = await h.request("owner", base + "/turns", input);
          assert.equal(replay.status, 200);
          assert.deepEqual(h.record(replay.data).turn, stored);
          const next = await h.request("owner", base + "/turns", {
            ...input,
            requestId: "TEST-no-replacement-root-" + change,
          });
          assert.equal(next.status, 409, JSON.stringify(next.data));
          assert.equal(h.record(next.data).error, failure);
          assert.equal(h.modelCount(), count + 1);
          assert.equal(h.businessCount(), 0);
          if (change === "service")
            await h.catalog({
              type: "saveService",
              id: h.serviceId,
              revision: 3,
              settings: {
                name: "TEST design service",
                url: "https://services.example.test/v1",
                protocol: "openapi",
                icon: "database",
                auth: { type: "none" },
                enabled: true,
              },
            });
          if (change === "provider") {
            const updated = await h.request(
              "owner",
              "api/identity/catalog/budget",
              {
                ...h.target,
                revision: 1,
                settings: {
                  ...h.budgetSettings,
                  prices: h.budgetSettings.prices.map((price) => ({
                    ...price,
                    providerRevision: 2,
                  })),
                },
              },
            );
            assert.equal(updated.status, 200, JSON.stringify(updated.data));
          }
          h.onModel(() => ({ content: "TEST design HTTP reply" }));
        },
      );
  } finally {
    await h.close();
  }
});
