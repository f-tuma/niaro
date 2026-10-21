import { messageCommand } from "../packages/client-core/commands";
import {
  applyEvent,
  fromSnapshot,
  mergeSnapshot,
  selectWorkMessageAnchors,
  selectPresentedWork,
  isTerminalNativeWork,
  selectTasks,
  selectReplyInput,
} from "../packages/client-core/store";
import {
  nativeTaskQuestion,
  nativeTaskApproval,
  openSnapshot,
  scopeFor,
} from "../packages/test-fixtures";
const snapshot = openSnapshot();
const initial = fromSnapshot("url-a", snapshot.scope, snapshot);
test("terminal work remains in Done despite a stale open input, and live waiting work appears in only one filter", () => {
  const state = structuredClone(initial);
  const work = state.workItems["work-1"]!;
  work.status = "running";
  expect(selectTasks(state, "needsInput")).toEqual([work]);
  expect(selectTasks(state, "upcoming")).toEqual([]);
  work.status = "failed";
  expect(selectTasks(state, "completed")).toEqual([work]);
  expect(selectTasks(state, "needsInput")).toEqual([]);
  expect(selectTasks(state, "upcoming")).toEqual([]);
});
test("a service result owns one card, while later text and previous results stay in history", () => {
  const s = structuredClone(snapshot);
  const work = nativeTaskApproval();
  s.workItems = [work];
  s.inputRequests = [];
  s.conversations[0]!.messages = [
    {
      id: "card",
      role: "assistant",
      text: "Review this action",
      result: work.native!.action!,
    },
    {
      id: "follow-up",
      role: "assistant",
      text: "The action is ready",
      workItemId: work.id,
    },
  ];
  const state = fromSnapshot("url-a", s.scope, s);
  expect([
    ...selectPresentedWork(
      state,
      "conversation-1",
      s.conversations[0]!.messages,
    ),
  ]).toEqual([work.id]);
  expect(selectWorkMessageAnchors(state, "conversation-1").size).toBe(0);
  expect(state.conversations["conversation-1"]!.messages).toHaveLength(2);
  expect(selectPresentedWork(state, "conversation-1", []).size).toBe(0);
  work.status = "succeeded";
  work.native!.action!.status = "succeeded";
  const completed = fromSnapshot("url-a", s.scope, s);
  expect(selectWorkMessageAnchors(completed, "conversation-1").size).toBe(0);
});
test.each(["succeeded", "failed", "cancelled"] as const)(
  "a terminal native %s reply stays visible as text instead of a live task card",
  (status) => {
    const s = structuredClone(snapshot);
    const work = nativeTaskQuestion();
    work.status = status;
    work.native!.question = undefined;
    work.result = "TEST final explanation";
    s.workItems = [work];
    s.inputRequests = [];
    s.conversations[0]!.messages = [
      {
        id: "terminal-reply",
        role: "assistant",
        text: work.result,
        workItemId: work.id,
      },
    ];
    const state = fromSnapshot("url-a", s.scope, s);
    expect(isTerminalNativeWork(work)).toBe(true);
    expect(selectWorkMessageAnchors(state, "conversation-1").size).toBe(0);
    expect(state.conversations["conversation-1"]!.messages[0]!.text).toBe(
      work.result,
    );
  },
);
const event = {
  eventId: "event-4",
  sequence: 4,
  scope: snapshot.scope,
  type: "work_item.upserted",
  entity: { ...snapshot.workItems[0], revision: 3, status: "running" },
};
test("scope and transport binding must both match", () => {
  expect(applyEvent(initial, "url-b", event)).toBe(initial);
  expect(applyEvent(initial, "url-a", { ...event, scope: scopeFor("b") })).toBe(
    initial,
  );
  expect(() => fromSnapshot("url-a", scopeFor("b"), snapshot)).toThrow(
    "scope_mismatch",
  );
});

test("a live work card follows the latest linked assistant reply and survives snapshot restoration", () => {
  const s = structuredClone(snapshot);
  s.conversations[0]!.messages = [
    {
      id: "first",
      role: "assistant",
      text: "Proposal ready",
      workItemId: "work-1",
    },
    {
      id: "follow-up",
      role: "user",
      text: "An hour later",
      workItemId: "work-1",
    },
    {
      id: "updated",
      role: "assistant",
      text: "Draft updated",
      workItemId: "work-1",
    },
    { id: "other-topic", role: "assistant", text: "Unrelated reply" },
  ];
  const state = fromSnapshot("url-a", s.scope, s);
  expect([...selectWorkMessageAnchors(state, "conversation-1")]).toEqual([
    ["work-1", "updated"],
  ]);
  expect(selectWorkMessageAnchors(state, "conversation-missing").size).toBe(0);
  expect(s.conversations[0]!.messages[0]!.text).toBe("Proposal ready");
});

test("unavailable work references preserve text without stealing a live card from another conversation", () => {
  const state = structuredClone(initial);
  state.conversations["conversation-1"]!.messages = [
    {
      id: "missing",
      role: "assistant",
      text: "Older result",
      workItemId: "missing-work",
    },
    {
      id: "foreign",
      role: "assistant",
      text: "Another result",
      workItemId: "work-1",
    },
  ];
  state.workItems["work-1"]!.conversationId = "another-conversation";
  expect(selectWorkMessageAnchors(state, "conversation-1").size).toBe(0);
});
test("duplicate and old revisions never roll the UI back", () => {
  const next = applyEvent(initial, "url-a", event);
  expect(applyEvent(next, "url-a", event)).toBe(next);
  const old = applyEvent(next, "url-a", {
    ...event,
    sequence: 5,
    eventId: "event-5",
    entity: snapshot.workItems[0],
  });
  expect(old.workItems["work-1"]?.revision).toBe(3);
  expect(old.cursor).toBe(5);
  expect(mergeSnapshot(old, "url-a", snapshot)).toBe(old);
});
test("missing sequence requests a snapshot instead of guessing state", () => {
  const gap = applyEvent(initial, "url-a", { ...event, sequence: 6 });
  expect(gap.needsSnapshot).toBe(true);
  expect(gap.stale).toBe(true);
  expect(gap.workItems).toBe(initial.workItems);
});

test("native question lookup and Tasks share the canonical binding without calendar fixture entities", () => {
  const work = nativeTaskQuestion();
  const snapshot = { ...openSnapshot(), workItems: [work], inputRequests: [] };
  const state = fromSnapshot("url-a", snapshot.scope, snapshot);
  expect(selectTasks(state, "needsInput").map((task) => task.id)).toEqual([
    work.id,
  ]);
  expect(selectReplyInput(state, work.native!.question)).toEqual(
    work.native!.question,
  );
  expect(
    messageCommand(
      "Tomorrow",
      "en",
      "TEST-bound-answer",
      work.native!.question,
    ),
  ).toMatchObject({
    context: {
      runtime: "mastra",
      workItemId: work.id,
      inputRequestId: work.native!.question!.id,
      expectedInputRevision: 1,
    },
  });
  expect(() =>
    fromSnapshot("url-a", snapshot.scope, {
      ...snapshot,
      workItems: [
        {
          ...work,
          native: {
            ...work.native,
            question: {
              ...work.native!.question,
              workItemId: "TEST-other-work",
            },
          },
        },
      ],
    }),
  ).toThrow();
});
