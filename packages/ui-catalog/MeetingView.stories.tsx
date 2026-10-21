import type { Meta, StoryObj } from "@storybook/react-native";
import { MeetingDetailView } from "./MeetingView";
import { meetingRecordFixture } from "../test-fixtures/meeting";
const meta = {
  title: "Meetings/Record",
  component: MeetingDetailView,
  args: { record: meetingRecordFixture, language: "en", onSource: () => {} },
} satisfies Meta<typeof MeetingDetailView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const Czech: Story = { args: { language: "cs" } };
export const FailedWithTranscript: Story = {
  args: {
    record: {
      ...meetingRecordFixture,
      analysis: null,
      analyzer: null,
      recordDigest: null,
      humanTaskIds: [],
      meeting: {
        ...meetingRecordFixture.meeting,
        status: "failed",
        failure: "meeting_analysis_failed",
      },
    },
  },
};
export const RecognitionReview: Story = {
  args: { record: { ...meetingRecordFixture, reviewReasons: ["uncertain"] } },
};
export const Silence: Story = {
  args: {
    record: {
      ...meetingRecordFixture,
      transcript: "",
      analysis: {
        summary: "",
        summarySources: [],
        points: [],
        tasks: [],
        overflow: false,
      },
      humanTaskIds: [],
    },
  },
};
export const WithTranscriptReader: Story = {
  args: { onTranscript: () => {}, onTasks: () => {} },
};
