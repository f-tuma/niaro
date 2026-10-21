import {
  MEETING_RECORD_PROFILE,
  MeetingRecordSchema,
} from "../protocol/meeting-record";
import {
  MEETING_PROFILE,
  MeetingSchema,
  MeetingSegmentSchema,
} from "../protocol/meetings";
export const meetingFixture = MeetingSchema.parse({
  profile: MEETING_PROFILE,
  id: "11111111-1111-4111-8111-111111111111",
  title: "Product planning",
  recordedAt: "2026-10-08T10:00:00.000Z",
  language: "en",
  mimeType: "audio/mp4",
  bytes: 1000,
  scope: {
    connectionId: "TEST-connection",
    serverId: "TEST-server",
    workspaceId: "TEST-workspace",
    userId: "TEST-user",
  },
  status: "ready",
  offset: 1000,
  durationSeconds: 60,
  sourceHash: "a".repeat(64),
  failure: null,
  completedSegments: 1,
  updatedAt: "2026-10-08T10:02:00.000Z",
});
export const meetingSegmentFixture = MeetingSegmentSchema.parse({
  index: 0,
  startSeconds: 0,
  endSeconds: 60,
  text: "Anna will prepare the prototype by Friday. We agreed to test recording recovery before release.",
  reviewReasons: [],
  transcriber: "TEST/transcriber",
  analyzer: "TEST/Mastra-model",
  analysis: {
    summary: [
      {
        text: "The team agreed on a prototype and recovery testing.",
        source: {
          segment: 0,
          quote: "We agreed to test recording recovery before release.",
        },
      },
    ],
    points: [
      {
        text: "Recording recovery is a release requirement.",
        source: { segment: 0, quote: "test recording recovery before release" },
      },
    ],
    tasks: [
      {
        text: "Prepare the prototype",
        assignee: "Anna",
        due: "Friday",
        source: {
          segment: 0,
          quote: "Anna will prepare the prototype by Friday.",
        },
      },
    ],
  },
});

export const meetingRecordFixture = MeetingRecordSchema.parse({
  profile: MEETING_RECORD_PROFILE,
  scope: meetingFixture.scope,
  meeting: meetingFixture,
  transcript: meetingSegmentFixture.text,
  transcriptComplete: true,
  reviewReasons: [],
  analysis: {
    summary: meetingSegmentFixture
      .analysis!.summary.map((s) => s.text)
      .join(" "),
    summarySources: meetingSegmentFixture.analysis!.summary.map(
      (s) => s.source,
    ),
    points: meetingSegmentFixture.analysis!.points.map((s) => ({
      text: s.text,
      sources: [s.source],
    })),
    tasks: meetingSegmentFixture.analysis!.tasks.map((s) => ({
      text: s.text,
      assignee: s.assignee,
      due: s.due,
      sources: [s.source],
    })),
    overflow: false,
  },
  analyzer: "TEST/Mastra-model",
  transcriptDigest: "b".repeat(64),
  recordDigest: "c".repeat(64),
  humanTaskIds: [`meeting:${meetingFixture.id}:0`],
});
