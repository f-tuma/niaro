import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import type { Language } from "../protocol";
import type {
  ProcessExecutionEntry,
  ProcessInputCard,
} from "../protocol/process-execution";
import {
  ProcessLaunchView,
  type ProcessLaunchViewProps,
} from "./ProcessLaunchView";
import type { ProcessFormInput } from "./process-input-form";

const schema = {
  type: "object" as const,
  properties: {
    title: { type: "string" as const },
    count: { type: "integer" as const, minimum: 0 },
    confirmed: { type: "boolean" as const },
    cleared: { type: "null" as const },
    reviewers: {
      type: "array" as const,
      maxItems: 4,
      items: { type: "string" as const },
    },
  },
  required: ["title", "count", "confirmed", "cleared", "reviewers"],
  additionalProperties: false as const,
};
const ready: ProcessExecutionEntry = {
  processId: "test-review-process",
  name: "TEST Prepare a project review",
  description: "TEST Gather the project details and reviewer list.",
  version: 3,
  kind: "workflow",
  artifactDigest: "a".repeat(64),
  availability: "ready",
  inputSchema: schema,
};
const other: ProcessExecutionEntry = {
  ...ready,
  processId: "test-summary-process",
  name: "TEST Prepare a meeting summary",
  description: "TEST Create a summary from reviewed meeting inputs.",
  kind: "agent",
};
const blocked: ProcessExecutionEntry = {
  processId: "test-blocked-process",
  name: "TEST Review a customer record",
  description: "TEST Read the selected customer record.",
  version: 7,
  kind: "agent",
  artifactDigest: "b".repeat(64),
  availability: "blocked",
  reason: "connection_required",
};
function fixture(entry = ready, language: Language = "en"): ProcessInputCard {
  const origin = {
    type: "command" as const,
    conversationId: "test-original-conversation",
    requestId: "test-request",
  };
  const formDigest = "c".repeat(64);
  return {
    form: {
      profile: "agent-process-input/1",
      scope: {
        connectionId: "test-connection",
        serverId: "test-server",
        userId: "test-user",
        workspaceId: "test-workspace",
      },
      language,
      processId: entry.processId,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      kind: entry.kind,
      artifactDigest: entry.artifactDigest,
      inputSchema: schema,
      origin,
    },
    formDigest,
    intent: {
      intentId: "test-original-intent",
      processId: entry.processId,
      version: entry.version,
      artifactDigest: entry.artifactDigest,
      formDigest,
      inputSchema: schema,
      fields: {},
      origin,
      createdAt: "2026-10-06T10:00:00.000Z",
    },
  };
}
const input: ProcessFormInput = {
  title: "  TEST project review  ",
  count: 0,
  confirmed: false,
  cleared: null,
  reviewers: ["TEST Ada", "", "  TEST Bo  "],
};
const card = fixture();
const recovery: NonNullable<ProcessLaunchViewProps["recovery"]> = {
  name: card.form.name,
  version: card.form.version,
  kind: card.form.kind,
  conversationId: card.form.origin.conversationId,
  language: card.form.language,
  input,
  outcome: "unknown",
  sending: false,
  error: null,
  canRetry: true,
  onRetry: () => {},
};

const meta = {
  title: "Catalog/ProcessLaunchView",
  component: ProcessLaunchView,
  args: {
    language: "en",
    entries: [ready, blocked, other],
    selected: null,
    loading: false,
    phase: "selection",
    card: null,
    reviewedInput: null,
    disabled: false,
    onLoad: () => {},
    onSelect: () => {},
    onPrepare: () => {},
    onReview: () => {},
    onEdit: () => {},
    onStart: () => {},
  },
} satisfies Meta<typeof ProcessLaunchView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MixedSelection: Story = {
  render: (args) => <LocalExample {...args} />,
};
export const MixedSelectionCzech: Story = {
  args: { language: "cs" },
  render: (args) => <LocalExample {...args} />,
};
export const Empty: Story = { args: { entries: [] } };
export const Blocked: Story = { args: { entries: [blocked] } };
export const Loading: Story = { args: { entries: null, loading: true } };
export const Review: Story = {
  args: { phase: "review", selected: ready, card, reviewedInput: input },
};
export const ReviewCzech: Story = {
  args: {
    ...Review.args,
    language: "cs",
    card: fixture(ready, "cs"),
  },
};
export const UnknownDelivery: Story = { args: { recovery, disabled: true } };
export const ExecutionDetailsUnverified: Story = {
  args: {
    recovery: { ...recovery, error: "savedProcessExecutionUnverified" },
    disabled: true,
  },
};
export const ExecutionDetailsUnverifiedCzech: Story = {
  args: {
    language: "cs",
    recovery: { ...recovery, error: "savedProcessExecutionUnverified" },
    disabled: true,
  },
};
export const UnknownDeliveryCzech: Story = {
  args: {
    language: "cs",
    disabled: true,
    recovery: { ...recovery, language: "en" },
  },
};
export const Accepted: Story = {
  args: {
    ...Review.args,
    phase: "accepted",
  },
};
export const Sending: Story = {
  args: { ...Review.args, phase: "sending", disabled: true },
};
export const RetrySavingCzech: Story = {
  args: {
    language: "cs",
    disabled: true,
    recovery: {
      ...recovery,
      outcome: "accepted",
      error: "processesSavingFailed",
    },
  },
};
export const Rejected: Story = {
  args: {
    ...Review.args,
    phase: "rejected",
  },
};
export const LongReviewCzech: Story = {
  args: {
    ...ReviewCzech.args,
    reviewedInput: {
      ...input,
      reviewers: Array.from({ length: 4 }, (_, index) =>
        `TEST ${index} `.repeat(80),
      ),
    },
  },
};

/** Synthetic local state transitions; no server or command coordinator. */
function LocalExample(args: ProcessLaunchViewProps) {
  const [selected, setSelected] = useState<ProcessExecutionEntry | null>(null);
  const [phase, setPhase] =
    useState<ProcessLaunchViewProps["phase"]>("selection");
  const [currentCard, setCurrentCard] = useState<ProcessInputCard | null>(null);
  const [reviewedInput, setReviewedInput] = useState<ProcessFormInput | null>(
    null,
  );
  return (
    <ProcessLaunchView
      {...args}
      selected={selected}
      phase={phase}
      card={currentCard}
      reviewedInput={reviewedInput}
      onSelect={setSelected}
      onPrepare={() => {
        if (!selected) return;
        setCurrentCard(fixture(selected, args.language));
        setPhase("editing");
      }}
      onReview={(value) => {
        setReviewedInput(value);
        setPhase("review");
      }}
      onEdit={() => setPhase("editing")}
      onStart={() => setPhase("sending")}
    />
  );
}
