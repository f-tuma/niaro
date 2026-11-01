import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { petProfileHttpFixture } from "./helpers/pet-profile-http";
import { PetProfileSchema } from "../packages/protocol/work-pet";
import { ClientSession } from "../packages/client-core/session";

test(
  "pet changes reach the person's other devices and console at once",
  { timeout: 120000 },
  async () => {
    const h = await petProfileHttpFixture({ allowOrdinaryRuntime: true });
    const streams = new AbortController();
    try {
      const phone = await h.pair("member"),
        tablet = await h.pair("member"),
        other = await h.pair("admin");
      const follow = (credential: typeof phone) => {
        const events: string[] = [];
        const session = new ClientSession(
          `${h.origin}/v1/${h.target.workspaceId}`,
          { getItem: async () => null, setItem: async () => {} },
          credential,
          fetch,
          undefined,
          undefined,
          false,
          { streamRequest: fetch },
        );
        const ended = session
          .watchPet((type) => events.push(type), streams.signal)
          .catch(() => "aborted");
        return { events, ended };
      };
      const tabletEvents = follow(tablet),
        otherEvents = follow(other);
      // The console follows the same person over its browser session.
      await h.request("member", "api/identity");
      const console = await fetch(
        `${h.origin}/admin/api/identity/pet/events?${new URLSearchParams({ ...h.target, profile: "work-pet/1" })}`,
        {
          headers: { Cookie: h.cookie("member"), Origin: h.origin },
          signal: streams.signal,
        },
      );
      assert.equal(console.status, 200);
      assert.match(console.headers.get("content-type")!, /text\/event-stream/);
      const reader = console.body!.getReader();
      let consoleText = "";
      const consoleRead = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          consoleText += new TextDecoder().decode(value);
        }
      })().catch(() => {});
      const until = async (ready: () => boolean) => {
        for (let i = 0; i < 100 && !ready(); i++)
          await new Promise((r) => setTimeout(r, 50));
        assert(ready());
      };
      await until(
        () =>
          tabletEvents.events.includes("ready") &&
          otherEvents.events.includes("ready") &&
          consoleText.includes('"ready"'),
      );
      const initial = PetProfileSchema.parse(
        (await h.mobile(phone, "pet")).data,
      );
      const saved = await h.mobile(phone, "pet", {
        requestId: randomUUID(),
        revision: initial.revision,
        settings: { ...initial.settings, shape: "heart" },
      });
      assert.equal(saved.status, 200, JSON.stringify(saved.data));
      await until(
        () =>
          tabletEvents.events.includes("pet") && consoleText.includes('"pet"'),
      );
      // Another person's pet is not theirs to follow.
      assert.deepEqual(otherEvents.events, ["ready"]);
      // A memory command from the console reaches the devices too.
      const count = tabletEvents.events.length;
      const remembered = await h.request(
        "member",
        `api/identity/pet/memory?${new URLSearchParams({ ...h.target, profile: "work-pet/1" })}`,
        {
          type: "remember",
          requestId: randomUUID(),
          kind: "fact",
          content: "TEST followed memory",
        },
      );
      assert.equal(remembered.status, 200, JSON.stringify(remembered.data));
      await until(() => tabletEvents.events.length > count);
      assert.equal(
        (await h.mobile(phone, "pet/events?unexpected=1")).status,
        400,
      );
      assert.equal((await h.mobile(undefined, "pet/events")).status, 401);
      streams.abort();
      await Promise.all([tabletEvents.ended, otherEvents.ended, consoleRead]);
    } finally {
      streams.abort();
      await h.close();
    }
  },
);
