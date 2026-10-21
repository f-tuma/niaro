import React from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { Group, Stack } from "../ui";
import { MeetingProgress, MeetingRow } from "./MeetingView";
import { meetingFixture } from "../test-fixtures/meeting";
import type { Language } from "../protocol";
const rows = [
  meetingFixture,
  {
    ...meetingFixture,
    id: "22222222-2222-4222-8222-222222222222",
    title: "Client call — Novak Ltd",
    status: "analyzing" as const,
    durationSeconds: 1290,
  },
  {
    ...meetingFixture,
    id: "33333333-3333-4333-8333-333333333333",
    title: "Weekly standup",
    status: "failed" as const,
    failure: "meeting_transcription_failed",
    durationSeconds: 610,
  },
  {
    ...meetingFixture,
    id: "44444444-4444-4444-8444-444444444444",
    title: "Retrospektiva sprintu s dlouhým českým názvem",
    status: "sealed" as const,
    durationSeconds: 4320,
  },
];
function List({ language }: { language: Language }) {
  return (
    <Stack style={{ padding: 20, gap: 20 }}>
      <Group>
        {rows.map((meeting) => (
          <MeetingRow
            key={meeting.id}
            meeting={meeting}
            language={language}
            onOpen={() => {}}
          />
        ))}
      </Group>
      <MeetingProgress
        meeting={{
          ...meetingFixture,
          status: "transcribing",
          durationSeconds: 600,
          completedSegments: 4,
        }}
        language={language}
      />
      <MeetingProgress
        meeting={{ ...meetingFixture, status: "sealed" }}
        language={language}
      />
    </Stack>
  );
}
export default {
  title: "Meetings/List",
  component: List,
  args: { language: "en" },
} satisfies Meta<typeof List>;
type Story = StoryObj<typeof List>;
export const English: Story = {};
export const Czech: Story = { args: { language: "cs" } };
