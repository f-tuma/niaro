import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import type { ProcessData } from "../protocol/service-processes";
import type { ProcessInputCard } from "../protocol/process-execution";
import { Button, Notice } from "../ui";
import { ProcessInputCardView } from "./ProcessInputCardView";

const object = (
  properties: Record<string, ProcessData>,
  required = Object.keys(properties),
): Extract<ProcessData, { type: "object" }> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
function fixture(
  schema: Extract<ProcessData, { type: "object" }>,
  version = 1,
): ProcessInputCard {
  const origin = {
    type: "command" as const,
    conversationId: "test-conversation",
    requestId: "test-request",
  };
  const formDigest = String(version).repeat(64);
  return {
    form: {
      profile: "agent-process-input/1",
      scope: {
        connectionId: "test-connection",
        serverId: "test-server",
        userId: "test-user",
        workspaceId: "test-workspace",
      },
      language: "en",
      name: "Prepare a project review",
      description: "Local inputs for a selected process.",
      kind: "workflow",
      processId: "test-process",
      version,
      artifactDigest: "a".repeat(64),
      inputSchema: schema,
      origin,
    },
    formDigest,
    intent: {
      intentId: `test-intent-${version}`,
      processId: "test-process",
      version,
      artifactDigest: "a".repeat(64),
      formDigest,
      inputSchema: schema,
      origin,
      fields: {},
      createdAt: "2026-10-05T10:00:00.000Z",
    },
  };
}
const simple = fixture(
  object({
    title: { type: "string", minLength: 1 },
    duration: { type: "integer", minimum: 5, maximum: 120 },
  }),
);
const meta = {
  title: "Catalog/ProcessInputCardView",
  component: ProcessInputCardView,
  args: { card: simple, language: "en", onSubmit: () => {} },
} satisfies Meta<typeof ProcessInputCardView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Simple: Story = {};
export const Nested: Story = {
  args: {
    card: fixture(
      object(
        {
          project: object({
            title: { type: "string", minLength: 1 },
            contact: object({
              name: { type: "string" },
              confirmed: { type: "boolean" },
            }),
          }),
          notes: { type: "string" },
        },
        ["project"],
      ),
    ),
  },
};
export const Arrays: Story = {
  args: {
    card: fixture(
      object({
        reviewers: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: object({
            name: { type: "string", minLength: 1 },
            attending: { type: "boolean" },
          }),
        },
        batches: {
          type: "array",
          maxItems: 3,
          items: { type: "array", maxItems: 3, items: { type: "string" } },
        },
      }),
    ),
  },
};
export const OptionalAndNull: Story = {
  args: {
    card: fixture(
      object(
        {
          note: { type: "string" },
          enabled: { type: "boolean" },
          cleared: { type: "null" },
          metadata: object({}),
          tags: { type: "array", items: { type: "string" } },
        },
        [],
      ),
    ),
  },
};
export const LiteralEnums: Story = {
  args: {
    card: fixture(
      object({
        location: {
          type: "string",
          enum: ["room / A", "Video call", "", "  "],
        },
        fixed: { type: "string", enum: ["a:b/c?d=e"] },
        disabledFlag: { type: "boolean", enum: [false] },
      }),
    ),
  },
};
export const Ranges: Story = {
  args: {
    card: fixture(
      object({
        count: { type: "integer", minimum: 1, maximum: 5 },
        ratio: { type: "number", minimum: -1, maximum: 1 },
        summary: { type: "string", minLength: 3, maxLength: 12 },
      }),
    ),
  },
};
export const ValidationErrors: Story = {
  args: {
    card: fixture(
      object({
        title: { type: "string", minLength: 3 },
        count: { type: "integer", minimum: 1, maximum: 5 },
        confirmed: { type: "boolean" },
        reviewers: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: { type: "string" },
        },
      }),
    ),
  },
  render: (args) => (
    <>
      <Notice>
        {args.language === "cs"
          ? "Stiskněte Připravit vstupy ke kontrole a zobrazte chyby ověření."
          : "Press Prepare inputs for review to display validation errors."}
      </Notice>
      <ProcessInputCardView {...args} />
    </>
  ),
};
export const EmptyCollections: Story = {
  args: {
    card: fixture(
      object({
        metadata: object({}),
        rows: { type: "array", maxItems: 0, items: { type: "string" } },
      }),
    ),
  },
};
export const ManyFields: Story = {
  args: {
    card: fixture(
      object(
        Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [
            `field${index + 1}`,
            { type: "string" },
          ]),
        ),
      ),
    ),
  },
};
export const Czech: Story = {
  args: { ...OptionalAndNull.args, language: "cs" },
};
export const Disabled: Story = { args: { disabled: true } };
export const NoCoordinator: Story = { args: { onSubmit: undefined } };
export const Malformed: Story = {
  args: { card: { ...simple, formDigest: "b".repeat(64) } },
};
export const Revision: Story = {
  render: (args) => <RevisionExample {...args} />,
};
function RevisionExample(
  args: React.ComponentProps<typeof ProcessInputCardView>,
) {
  const [version, setVersion] = useState(1);
  const [prepared, setPrepared] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        label={
          args.language === "cs"
            ? "Načíst další verzi formuláře"
            : "Load next form version"
        }
        onPress={() => {
          setVersion(2);
          setPrepared(false);
        }}
      />
      <ProcessInputCardView
        {...args}
        card={fixture(simple.form.inputSchema, version)}
        onSubmit={() => setPrepared(true)}
      />
      {prepared ? (
        <Notice>
          {args.language === "cs"
            ? "Vstupy připraveny místně."
            : "Inputs prepared locally."}
        </Notice>
      ) : null}
    </>
  );
}
