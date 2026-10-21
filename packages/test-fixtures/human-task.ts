import { HumanTaskSchema } from "../protocol/human-tasks";
import { scopeFor } from ".";
export const humanTaskFixture = HumanTaskSchema.parse({
  id: "TEST-human-task",
  scope: scopeFor(),
  title: "Arrange the follow-up meeting with Anna",
  detail: "Find a time that works for Anna before Friday.",
  assignee: null,
  due: "Friday",
  revision: 1,
  status: "open",
  resolution: null,
  createdAt: "2026-10-08T10:00:00.000Z",
  updatedAt: "2026-10-08T10:00:00.000Z",
  origin: {
    kind: "meeting",
    meetingId: "11111111-1111-4111-8111-111111111111",
    meetingTitle: "Product planning",
    recordDigest: "a".repeat(64),
    sources: [{ segment: 0, quote: "Let's meet again before Friday." }],
  },
});
