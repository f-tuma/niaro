import type { Meta, StoryObj } from "@storybook/react-native";
import { ProcessOutputView } from "./ProcessOutputView";
import { ProcessOutputPageSchema } from "../protocol/process-output";
import { scopeFor } from "../test-fixtures";
const scope = scopeFor("a");
const page = ProcessOutputPageSchema.parse({
  profile: "agent-process-output/1",
  reference: {
    profile: "agent-process-output/1",
    scope,
    parentRunId: "TEST-story-parent",
    nativeRevision: 1,
    provenance: {
      runId: "TEST-story-run",
      processId: "TEST-story-process",
      version: 1,
      artifactDigest: "a".repeat(64),
      actorId: scope.userId,
      conversationId: "conversation-1",
      commandId: "TEST-story-start",
      admissionId: "TEST-story-admission",
    },
    origin: {
      type: "command",
      conversationId: "conversation-1",
      requestId: "TEST-story-menu",
    },
    outputDigest: "b".repeat(64),
    redactionVersion: "process-output-redaction/1",
  },
  path: [],
  cursor: null,
  offset: 0,
  total: 4,
  node: { kind: "object", childCount: 4 },
  children: [
    { index: 0, label: "empty", node: { kind: "string", value: "" } },
    { index: 1, label: "confirmed", node: { kind: "boolean", value: false } },
    { index: 2, label: "count", node: { kind: "number", value: 0 } },
    { index: 3, label: "[redacted field]", node: { kind: "redacted" } },
  ],
  nextCursor: null,
});
const meta = {
  title: "Work/ProcessOutputView",
  component: ProcessOutputView,
  args: { page, language: "en", onOpen: () => {} },
} satisfies Meta<typeof ProcessOutputView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TypedValues: Story = {};
export const TypedValuesCzech: Story = { args: { language: "cs" } };
export const EmptyObject: Story = {
  args: {
    page: {
      ...page,
      total: 0,
      node: { kind: "object", childCount: 0 },
      children: [],
    },
  },
};
export const EmptyArray: Story = {
  args: {
    page: {
      ...page,
      total: 0,
      node: { kind: "array", childCount: 0 },
      children: [],
    },
  },
};
export const LongSelectableText: Story = {
  args: {
    page: {
      ...page,
      total: 0,
      node: {
        kind: "string",
        value: "TEST complete selectable output. ".repeat(100),
      },
      children: [],
    },
  },
};
export const RemainingPage: Story = {
  args: {
    page: {
      ...page,
      total: 20,
      node: { kind: "object", childCount: 20 },
      nextCursor: "4." + "c".repeat(64),
    },
    onNext: () => {},
  },
};
