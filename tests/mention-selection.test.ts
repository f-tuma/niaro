import {
  captureMentionIntent,
  applyMentionPick,
  type MentionItem,
} from "../packages/client-core/mentions";
const owner = {
  identityKey: "TEST-actor-A",
  conversationId: "TEST-chat-A",
  revision: 3,
};
const item: MentionItem = {
  kind: "skill",
  id: "TEST-skill",
  name: "Krátký e-mail",
};
const current = (text: string) => ({
  ...owner,
  text,
  picked: [] as MentionItem[],
  directory: [item],
});
test("a picked reference replaces only the owned caret occurrence, never submits", () => {
  const text = "A @kra a později @jiné";
  const intent = captureMentionIntent(owner, text, 6)!;
  expect(applyMentionPick(intent, current(text), item)).toMatchObject({
    text: "A @Krátký e-mail a později @jiné",
    caret: 17,
    picked: [item],
  });
});
test.each([
  { identityKey: "TEST-B" },
  { conversationId: "TEST-B" },
  { revision: 4 },
  { text: "changed @kra" },
])("stale owner or draft rejects selection %j", (patch) => {
  const intent = captureMentionIntent(owner, "A @kra", 6)!;
  expect(
    applyMentionPick(intent, { ...current("A @kra"), ...patch }, item),
  ).toBeNull();
});
test("explicit picker cancellation leaves draft unchanged; selection inserts at captured caret", () => {
  const text = "A B";
  const intent = captureMentionIntent(owner, text, 1, true)!;
  expect(intent.text).toBe(text);
  expect(applyMentionPick(intent, current(text), item)?.text).toBe(
    "A @Krátký e-mail B",
  );
});
test("directory revocation and maximum text/reference limits preserve the draft", () => {
  const text = "@kra";
  const intent = captureMentionIntent(owner, text, 4)!;
  expect(
    applyMentionPick(intent, { ...current(text), directory: [] }, item),
  ).toBeNull();
  const full = "x".repeat(3995) + " @kra";
  const large = captureMentionIntent(owner, full, full.length)!;
  expect(applyMentionPick(large, current(full), item)).toBeNull();
  const picked = Array.from({ length: 10 }, (_, i) => ({
    kind: "process" as const,
    id: `TEST-${i}`,
    name: `Item${i}`,
  }));
  const ten = picked.map((x) => "@" + x.name).join(" ") + " @kra";
  const many = captureMentionIntent(owner, ten, ten.length)!;
  expect(applyMentionPick(many, { ...current(ten), picked }, item)).toBeNull();
});
test("a reference cannot become an email-address trigger", () => {
  expect(captureMentionIntent(owner, "a@b.cz", 6)).toBeNull();
});
