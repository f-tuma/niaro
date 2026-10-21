import React from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { Group, Stack } from "../ui";
import type { Language } from "../protocol";
import type { HumanTask, HumanTaskCommand } from "../protocol/human-tasks";
import {
  HumanTaskActions,
  HumanTaskCard,
  HumanTaskDetail,
} from "./HumanTaskView";
import { humanTaskFixture } from "../test-fixtures/human-task";
/** The list row, then the task sheet's body and action area. */
function TaskPreview({
  task,
  language,
  disabled,
  pending,
  resolveDisabled,
  onOpenMeeting,
}: {
  task: HumanTask;
  language: Language;
  disabled?: boolean;
  pending?: HumanTaskCommand["decision"];
  resolveDisabled?: boolean;
  onOpenMeeting?(id: string): void;
}) {
  return (
    <Stack style={{ padding: 20, gap: 24 }}>
      <Group>
        <HumanTaskCard
          task={task}
          language={language}
          disabled={disabled}
          pending={pending}
          onMore={() => {}}
        />
      </Group>
      <HumanTaskDetail
        task={task}
        language={language}
        pending={pending}
        onOpenMeeting={onOpenMeeting}
      />
      <HumanTaskActions
        task={task}
        language={language}
        disabled={disabled}
        resolveDisabled={resolveDisabled}
        onResolve={() => {}}
        onDecide={() => {}}
      />
    </Stack>
  );
}
const meta = {
  title: "Tasks/Open items",
  component: TaskPreview,
  args: { task: humanTaskFixture, language: "en" },
} satisfies Meta<typeof TaskPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
export const Czech: Story = { args: { language: "cs" } };
export const FromChat: Story = {
  args: {
    task: {
      ...humanTaskFixture,
      title: "Put the supplier visit in the calendar",
      detail: "The supplier has not confirmed the day yet.",
      due: null,
      origin: {
        kind: "agent",
        runId: "TEST-agent-run",
        toolCallId: "TEST-agent-tool",
        conversationId: "conversation-1",
      },
    },
  },
};
export const ClosedByAssistant: Story = {
  args: {
    task: {
      ...humanTaskFixture,
      revision: 2,
      status: "done",
      resolution: {
        by: "agent",
        reason: "The meeting is in the calendar for Thursday at 10:00.",
        at: "2026-10-08T12:00:00.000Z",
      },
    },
  },
};
export const DoneByPerson: Story = {
  args: {
    task: {
      ...humanTaskFixture,
      revision: 2,
      status: "done",
      resolution: { by: "user", reason: "", at: "2026-10-08T12:00:00.000Z" },
    },
  },
};
export const Removed: Story = {
  args: {
    task: {
      ...humanTaskFixture,
      revision: 2,
      status: "removed",
      resolution: { by: "user", reason: "", at: "2026-10-08T12:00:00.000Z" },
    },
  },
};
export const Saving: Story = { args: { disabled: true, pending: "complete" } };
export const ChatBusy: Story = { args: { resolveDisabled: true } };
export const LinkedMeeting: Story = { args: { onOpenMeeting: () => {} } };
