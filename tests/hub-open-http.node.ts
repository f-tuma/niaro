import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HUB_PROFILE_V3,
  HubDashboardV3Schema,
  HubOpenResultSchema,
} from "../packages/protocol/hub";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

// Its own process: the fixture's sign-ins share one login rate limit per process.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = {
  id: "AAMkAGE1-TEST-1",
  subject: "TEST Cenová nabídka",
  from: {
    emailAddress: { name: "Jana Nováková", address: "jana@example.test" },
  },
  receivedDateTime: "2026-10-17T06:30:00Z",
  webLink: "https://outlook.example.test/mail/1",
  body: {
    contentType: "html",
    content: "<p>Dobrý den,</p><p>potvrďte prosím <b>cenu</b> do pátku.</p>",
  },
};
const second = {
  ...message,
  id: "AAMkAGE1-TEST-2",
  subject: "TEST Schůzka",
  body: { contentType: "text", content: "Hodí se ti úterý?" },
};

test(
  "an inbox email is opened in full over the app API for the signed-in person only, read now under their credential",
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const member = await h.pair("member");
      const admin = await h.pair("admin");
      const hub = (body?: unknown) =>
        h.mobile(
          member,
          `hub?language=cs&profile=${encodeURIComponent(HUB_PROFILE_V3)}`,
          body,
        );
      // The fill's collection discovers and reads once; its assembly answers
      // with one email carrying the source's id. The open's collection does
      // the same read for that id and stops; it never assembles.
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
              emails: [message, second].map((entry) => ({
                id: entry.id,
                from: "Jana Nováková",
                subject: entry.subject,
                receivedAt: entry.receivedDateTime,
                summary: "TEST shrnutí",
                importance: "high",
              })),
              unread: 2,
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
            need: "messages",
          });
        if (outputs.length === 1)
          return call("read", {
            action: outputs[0].actions[0].action,
            input: { name: message.id },
          });
        return { content: "TEST done" };
      });
      h.onService(async () => ({
        status: 200,
        headers: {},
        text: JSON.stringify({ value: [message, second] }),
      }));
      await h.catalog({
        type: "saveRouting",
        routing: { revision: 0, modelId: h.modelId, services: [] },
      });
      const added = await hub({
        profile: HUB_PROFILE_V3,
        type: "add",
        kind: "widget",
        widget: { type: "inbox", brief: "TEST důležité e-maily" },
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
      assert.equal(h.dispatches.length, 1);

      // The person opens the email: one more read, the content as text.
      const opened = await h.mobile(member, "hub/open?language=cs", {
        itemId: id,
        ref: message.id,
      });
      assert.equal(opened.status, 200, JSON.stringify(opened.data));
      const detail = HubOpenResultSchema.parse(opened.data);
      assert.deepEqual(detail, {
        subject: "TEST Cenová nabídka",
        from: "Jana Nováková <jana@example.test>",
        at: "2026-10-17T06:30:00.000Z",
        text: "Dobrý den,\n\npotvrďte prosím cenu do pátku.",
        doc: [
          { t: "el", tag: "p", children: [{ t: "text", v: "Dobrý den," }] },
          {
            t: "el",
            tag: "p",
            children: [
              { t: "text", v: "potvrďte prosím " },
              { t: "el", tag: "strong", children: [{ t: "text", v: "cenu" }] },
              { t: "text", v: " do pátku." },
            ],
          },
        ],
        link: "https://outlook.example.test/mail/1",
        cached: false,
      });
      // The read named the id, so the other row follows into the index in
      // the background: one more read, no model call.
      const models = h.models().length;
      for (let i = 0; i < 100 && h.dispatches.length < 3; i++) await sleep(50);
      assert.deepEqual(h.dispatches, ["GET", "GET", "GET"]);
      assert.equal(h.models().length, models);
      // Both now come from the index at once; nothing is read again.
      const indexed = await h.mobile(member, "hub/open?language=cs", {
        itemId: id,
        ref: second.id,
      });
      assert.equal(indexed.status, 200, JSON.stringify(indexed.data));
      assert.deepEqual(HubOpenResultSchema.parse(indexed.data), {
        subject: "TEST Schůzka",
        from: "Jana Nováková <jana@example.test>",
        at: "2026-10-17T06:30:00.000Z",
        text: "Hodí se ti úterý?",
        link: "https://outlook.example.test/mail/1",
        cached: true,
      });
      const again = await h.mobile(member, "hub/open?language=cs", {
        itemId: id,
        ref: message.id,
      });
      assert.deepEqual(HubOpenResultSchema.parse(again.data), {
        ...detail,
        cached: true,
      });
      assert.deepEqual(h.dispatches, ["GET", "GET", "GET"]);
      assert.equal(h.models().length, models);
      // Nothing was stored on the widget.
      const after = HubDashboardV3Schema.parse((await hub()).data).items.find(
        (item) => item.id === id,
      )!;
      assert.deepEqual(after.widget?.data, card?.widget?.data);
      assert.deepEqual(after.result, card?.result);

      // A row the widget does not hold, a bad body, a wrong method.
      const unknown = await h.mobile(member, "hub/open?language=cs", {
        itemId: id,
        ref: "AAMkAGE1-other",
      });
      assert.equal(unknown.status, 409);
      assert.equal(
        (unknown.data as { error: string }).error,
        "hub_item_unknown",
      );
      assert.equal(
        (await h.mobile(member, "hub/open?language=cs", { itemId: id })).status,
        400,
      );
      assert.equal(
        (
          await h.mobile(member, "hub/open?language=cs&extra=1", {
            itemId: id,
            ref: message.id,
          })
        ).status,
        400,
      );
      assert.equal(
        (await h.mobile(member, "hub/open?language=cs")).status,
        405,
      );
      // Nobody else: another person's widget is not found, no credential is 401.
      const foreign = await h.mobile(admin, "hub/open?language=cs", {
        itemId: id,
        ref: message.id,
      });
      assert.equal(foreign.status, 404);
      assert.equal(
        (
          await h.mobile(undefined, "hub/open?language=cs", {
            itemId: id,
            ref: message.id,
          })
        ).status,
        401,
      );
      assert.deepEqual(h.dispatches, ["GET", "GET", "GET"]);
      // The person may no longer read the source: the index answers no more.
      const store = h.identity["catalog"].store;
      const service = store.service(h.target.workspaceId, h.serviceId);
      const action = service.actions.find((a) => a.id === h.actionId)!;
      const { id: _id, revision: _rev, sourceKey: _key, ...settings } = action;
      await h.catalog({
        type: "saveAction",
        id: h.actionId,
        serviceId: h.serviceId,
        serviceRevision: service.revision,
        revision: action.revision,
        settings: { ...settings, policy: { roles: ["owner"], users: [] } },
      });
      const closed = await h.mobile(member, "hub/open?language=cs", {
        itemId: id,
        ref: second.id,
      });
      assert.notEqual(closed.status, 200, JSON.stringify(closed.data));
      assert.deepEqual(h.dispatches, ["GET", "GET", "GET"]);
    } finally {
      await h.close();
    }
  },
);
