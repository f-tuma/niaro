import {
  NativeQuestionSchema,
  WorkItemSchema,
  type DomainEvent,
  type WorkItem,
} from "../packages/protocol";
import {
  QUESTION_OPTIONS_PROFILE,
  eventsWithoutQuestionOptions,
  questionOptionsDeliveryPath,
  snapshotWithoutQuestionOptions,
} from "../packages/protocol/question-options";

const scope = {
  connectionId: "connection-1",
  serverId: "server-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};
const question = {
  runtime: "mastra" as const,
  id: "question-1",
  revision: 1,
  workItemId: "work-1",
  conversationId: "conv-1",
  question: "Which day?",
  status: "open" as const,
  options: ["Monday", "Tuesday"],
  multiple: true as const,
};
const work = WorkItemSchema.parse({
  id: "work-1",
  revision: 2,
  conversationId: "conv-1",
  title: "Meeting",
  context: "Which day?",
  status: "waiting_input",
  inputRequestIds: [],
  actionProposalIds: [],
  operationIds: [],
  demo: false,
  native: { runId: "work-1", revision: 2, question },
  presentation: { type: "workflow.progress", version: 1, variant: "default" },
}) as WorkItem;
/** The question shape every client before offered answers parses strictly. */
const LegacyQuestion = NativeQuestionSchema.omit({
  options: true,
  multiple: true,
});

test("offered answers are optional, short and few", () => {
  expect(NativeQuestionSchema.parse(question).options).toEqual([
    "Monday",
    "Tuesday",
  ]);
  const { options: _o, multiple: _m, ...plain } = question;
  expect(NativeQuestionSchema.parse(plain)).toEqual(plain);
  for (const options of [["Only"], ["x".repeat(81), "y"], Array(7).fill("a")])
    expect(
      NativeQuestionSchema.safeParse({ ...question, options }).success,
    ).toBe(false);
});

test("clients that don't ask for offered answers get the question text only", () => {
  expect(LegacyQuestion.safeParse(question).success).toBe(false);
  const snapshot = snapshotWithoutQuestionOptions({
    profile: "agent-client/0.8-fixture",
    scope,
    cursor: 1,
    conversations: [],
    workItems: [work],
    inputRequests: [],
    actionProposals: [],
    operations: [],
  });
  const { options: _options, multiple: _multiple, ...plain } = question;
  expect(LegacyQuestion.parse(snapshot.workItems[0]!.native!.question)).toEqual(
    plain,
  );
  const events: DomainEvent[] = [
    {
      eventId: "e-1",
      sequence: 1,
      scope,
      type: "work_item.upserted",
      entity: work,
    },
  ];
  const [event] = eventsWithoutQuestionOptions(events);
  expect(
    event!.type === "work_item.upserted" && event!.entity.native?.question,
  ).not.toHaveProperty("options");
  // The original is untouched for clients that do ask.
  expect(work.native?.question?.options).toHaveLength(2);
});

test("the delivery path names the profile", () => {
  expect(questionOptionsDeliveryPath("snapshot?chats=x")).toBe(
    `snapshot?chats=x&questions=${encodeURIComponent(QUESTION_OPTIONS_PROFILE)}`,
  );
  expect(questionOptionsDeliveryPath("events")).toBe(
    `events?questions=${encodeURIComponent(QUESTION_OPTIONS_PROFILE)}`,
  );
});
