import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HUB_PROFILE_V2,
  HUB_PROFILE_V3,
  HubDashboardSchema,
  HubDashboardV3Schema,
  HubViewSchema,
} from "../packages/protocol/hub";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

// Its own process: the fixture's sign-ins share one login rate limit per process.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "an AI widget added over the app API is filled in the background by a read-only agent under the person's credential",
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const member = await h.pair("member");
      const hub = (body?: unknown, profile: string = HUB_PROFILE_V3) =>
        h.mobile(
          member,
          `hub?language=cs&profile=${encodeURIComponent(profile)}`,
          body,
        );
      // The collection step looks the action up and reads once; the
      // assembly answers in the list widget's schema.
      h.onModel((request) => {
        const tools = (request as { tools?: unknown[] }).tools;
        const outputs = (request.messages ?? [])
          .filter((message) => message.role === "tool")
          .map((message) =>
            JSON.parse(String((message as { content: unknown }).content)),
          );
        if (!tools?.length)
          return {
            content: JSON.stringify({
              items: [{ title: "TEST-mobile-result", meta: "TEST" }],
            }),
          };
        const call = (name: string, args: unknown) => ({
          content: null,
          tool_calls: [
            {
              id: `TEST-call-${outputs.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        if (!outputs.length)
          return call("find_actions", {
            service: "TEST design service",
            need: "lookup",
          });
        if (outputs.length === 1)
          return call("read", {
            action: outputs[0].actions[0].action,
            input: { name: "TEST" },
          });
        return { content: "TEST done" };
      });
      // The person's assistant model (the workspace's chat model).
      await h.catalog({
        type: "saveRouting",
        routing: { revision: 0, modelId: h.modelId, services: [] },
      });
      const added = await hub({
        profile: HUB_PROFILE_V3,
        type: "add",
        kind: "widget",
        widget: { type: "list", brief: "TEST výsledky vyhledávání" },
      });
      assert.equal(added.status, 200, JSON.stringify(added.data));
      const id = HubDashboardV3Schema.parse(added.data).items.find(
        (item) => item.kind === "widget",
      )!.id;
      let card;
      for (let i = 0; i < 200; i++) {
        card = HubDashboardV3Schema.parse((await hub()).data).items.find(
          (item) => item.id === id,
        )!;
        if (card.result?.status !== "running") break;
        await sleep(100);
      }
      assert.equal(card?.result?.status, "succeeded", JSON.stringify(card));
      assert.deepEqual(card?.widget?.data, {
        items: [{ title: "TEST-mobile-result", meta: "TEST" }],
      });
      assert.deepEqual(card?.widget?.recipe, {
        services: ["TEST design service"],
        reads: 1,
      });
      // One read went out, nothing else.
      assert.deepEqual(h.dispatches, ["GET"]);
      // Older profiles keep answering without the typed widget.
      const v2 = HubDashboardSchema.parse(
        (await hub(undefined, HUB_PROFILE_V2)).data,
      );
      assert(!v2.items.some((item) => item.id === id));
      const v1 = HubViewSchema.parse(
        (await h.mobile(member, "hub?language=cs")).data,
      );
      assert(!v1.items.some((item) => item.id === id));
    } finally {
      await h.close();
    }
  },
);
