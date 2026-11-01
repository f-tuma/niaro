import {
  addToNewChat,
  readDraft,
  saveDraft,
} from "../apps/server-admin/web/app/chat-store";

test("asking from Overview or a meeting keeps what the new chat already holds", () => {
  const key = "identity-1:draft";
  saveDraft(key, {
    text: "My own words",
    revision: 3,
    mentions: [{ kind: "meeting", id: "m-1", name: "Standup" }],
  });
  expect(
    addToNewChat(key, "What did we decide?", [
      { kind: "meeting", id: "m-1", name: "Standup" },
      { kind: "meeting", id: "m-2", name: "Review" },
    ]),
  ).toBe(true);
  const draft = readDraft(key)!;
  expect(draft.text).toBe("My own words\n\nWhat did we decide?");
  expect(draft.revision).toBe(3);
  expect(draft.mentions?.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  // A question that would overflow the draft leaves it as it was.
  expect(addToNewChat(key, "x".repeat(100_000))).toBe(false);
  expect(readDraft(key)!.text).toBe("My own words\n\nWhat did we decide?");
});

test("an untouched Ask gives way to the next one; a prompt keeps its trailing space", () => {
  const key = "identity-2:draft";
  addToNewChat(key, "K schůzce „Standup“: ", [
    { kind: "meeting", id: "m-1", name: "Standup" },
  ]);
  expect(readDraft(key)!.text).toBe("K schůzce „Standup“: ");
  addToNewChat(key, "K widgetu Kalendář: ");
  expect(readDraft(key)!.text).toBe("K widgetu Kalendář: ");
  expect(readDraft(key)!.mentions).toEqual([]);
  // Once the person writes, their words stay.
  const draft = readDraft(key)!;
  saveDraft(key, { ...draft, text: "K widgetu Kalendář: co mám zítra?" });
  addToNewChat(key, "Další otázka");
  expect(readDraft(key)!.text).toBe(
    "K widgetu Kalendář: co mám zítra?\n\nDalší otázka",
  );
});

test("an overflowing Ask changes nothing", () => {
  const key = "identity-3:draft";
  saveDraft(key, { text: "My own words\n\nWhat did we decide?", revision: 0 });
  expect(addToNewChat(key, "x".repeat(100_000))).toBe(false);
  expect(readDraft(key)!.text).toBe("My own words\n\nWhat did we decide?");
});
