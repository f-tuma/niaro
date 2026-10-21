import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mobileHttpChildFixture } from "./helpers/process-mobile-http-child";
import { MEETING_PROFILE } from "../packages/protocol/meetings";
import { ClientSession } from "../packages/client-core/session";

test("paired real server exposes scoped meeting upload and truthful missing-service error", async () => {
  const fixture = await mobileHttpChildFixture();
  let client: ClientSession | undefined;
  try {
    const setup = await fixture.configure({ questions: 0, writes: 0 });
    let loseBlockReply = true;
    const requestFetch: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).includes("/blocks?") && loseBlockReply) {
        loseBlockReply = false;
        throw new Error("TEST lost acknowledgement");
      }
      return response;
    };
    client = new ClientSession(
      setup.endpoint,
      { getItem: async () => null, setItem: async () => {} },
      setup.credential,
      requestFetch,
    );
    const anonymous = await fetch(setup.endpoint + "/meetings");
    assert.equal(anonymous.status, 401);
    const request: import("../packages/protocol/meetings").MeetingCreate = {
      profile: MEETING_PROFILE,
      id: randomUUID(),
      title: "TEST meeting",
      recordedAt: new Date().toISOString(),
      language: "cs" as const,
      mimeType: "audio/wav" as const,
      bytes: 8,
    };
    assert.equal((await client.createMeeting(request)).offset, 0);
    await assert.rejects(
      client.uploadMeetingBlock(request.id, 0, new Uint8Array([1, 2, 3, 4])),
      /TEST lost acknowledgement/,
    );
    assert.equal((await client.createMeeting(request)).offset, 4); // Recovery after lost block acknowledgement.
    assert.equal(
      (
        await client.uploadMeetingBlock(
          request.id,
          4,
          new Uint8Array([5, 6, 7, 8]),
        )
      ).offset,
      8,
    );
    assert.equal((await client.sealMeeting(request.id)).status, "sealed");
    await assert.rejects(
      client.processMeeting(request.id),
      /meeting_services_unavailable/,
    );
    assert.equal(
      (await client.readMeeting(request.id)).meeting.status,
      "sealed",
    );
    assert.equal((await client.readMeetings()).meetings.length, 1);
    await fixture.restart();
    assert.equal(
      (await client.readMeeting(request.id)).meeting.status,
      "sealed",
    );
    await fixture.revokeDevice(setup.credential.accessToken);
    await assert.rejects(client.readMeetings());
    assert.equal((await fixture.inspect()).serviceDispatches.length, 0);
  } finally {
    client?.stop();
    await fixture.close();
  }
});

test("real paired human-task API replays lost acknowledgement, keeps current decisions, enforces scope/revocation and exposes full record without inference", async () => {
  const { mobileIntegratedHttpFixture } = await import(
    "./helpers/process-mobile-integrated-http"
  );
  const { HUMAN_TASK_PROFILE } = await import(
    "../packages/protocol/human-tasks"
  );
  const fixture = await mobileIntegratedHttpFixture();
  let client: ClientSession | undefined;
  try {
    const setup = await fixture.configure({ questions: 0, writes: 0 });
    const store = fixture.identity["meetings"];
    const id = randomUUID();
    store.create(setup.credential.scope, {
      profile: MEETING_PROFILE,
      id,
      title: "TEST old ready",
      recordedAt: new Date().toISOString(),
      language: "cs",
      mimeType: "audio/wav",
      bytes: 1,
    });
    store.putSegment(setup.credential.scope, id, {
      index: 0,
      startSeconds: 0,
      endSeconds: 60,
      text: "TEST complete transcript.",
      reviewReasons: [],
      transcriber: "TEST",
      analyzer: null,
      analysis: null,
    });
    store.update(setup.credential.scope, id, {
      durationSeconds: 60,
      status: "ready",
    });
    const human = store.humanTasks.create(
      setup.credential.scope,
      "TEST-human",
      {
        title: "TEST human review",
        detail: "Review the offer",
        assignee: null,
        due: null,
      },
      {
        kind: "agent",
        runId: "TEST-run",
        toolCallId: "TEST-call",
        conversationId: "TEST-chat",
      },
    );
    let lost = true;
    client = new ClientSession(
      setup.endpoint,
      { getItem: async () => null, setItem: async () => {} },
      setup.credential,
      async (url, init) => {
        const response = await fetch(url, init);
        if (
          init?.method === "POST" &&
          String(url).includes("/human-tasks/") &&
          lost
        ) {
          lost = false;
          throw Error("TEST lost human acknowledgement");
        }
        return response;
      },
    );
    assert.equal(
      (await fetch(setup.endpoint + "/human-tasks?tab=open")).status,
      401,
    );
    assert.equal(
      (await client.readMeetingRecord(id)).transcript,
      "TEST complete transcript.",
    );
    assert.equal((await client.readMeetingRecord(id)).analysis, null);
    assert.equal((await client.readHumanTasks("open")).tasks.length, 1);
    const complete = {
      profile: HUMAN_TASK_PROFILE as typeof HUMAN_TASK_PROFILE,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      expectedRevision: human.revision,
      decision: "complete" as const,
    };
    await assert.rejects(
      client.submitHumanTask(human.id, complete),
      /TEST lost human acknowledgement/,
    );
    assert.equal(
      (await client.submitHumanTask(human.id, complete)).status,
      "done",
    );
    assert.equal((await client.readHumanTasks("open")).tasks.length, 0);
    assert.equal((await client.readHumanTasks("done")).counts.done, 1);
    const reopen = {
      ...complete,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      expectedRevision: 2,
      decision: "reopen" as const,
    };
    assert.equal(
      (await client.submitHumanTask(human.id, reopen)).status,
      "open",
    );
    assert.equal(
      (await client.submitHumanTask(human.id, complete)).status,
      "done",
    );
    assert.equal((await client.readHumanTask(human.id)).status, "open");
    await assert.rejects(
      client.submitHumanTask(human.id, { ...complete, decision: "remove" }),
      /human_task_conflict/,
    );
    assert.equal(
      (
        await fetch(setup.endpoint + "/human-tasks?tab=waiting", {
          headers: { authorization: `Bearer ${setup.credential.accessToken}` },
        })
      ).status,
      400,
    );
    await assert.rejects(
      client.readHumanTask("TEST-other"),
      /human_task_not_found/,
    );
    await fixture.restart();
    assert.equal((await client.readHumanTask(human.id)).status, "open");
    assert.equal((await client.readMeetingRecord(id)).analysis, null);
    assert.equal((await fixture.inspect()).serviceDispatches.length, 0);
    await fixture.revokeDevice(setup.credential.accessToken);
    await assert.rejects(client.readHumanTasks("open"));
    await assert.rejects(client.submitHumanTask(human.id, complete));
  } finally {
    client?.stop();
    await fixture.close();
  }
});
