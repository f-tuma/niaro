import type { Meta, StoryObj } from "@storybook/react-native";
import React from "react";
import { View } from "react-native";
import { ServiceActionCard } from "./ServiceActionCard";
import type { ServiceResult } from "../protocol/service-result";
import type { ServicePresentation } from "../protocol/service-presentation";
const result: ServiceResult = {
  type: "service.action",
  version: 1,
  operationId: "test-action",
  title: "Create project",
  service: "Project tracker",
  status: "awaiting_approval",
  effect: "write",
  fields: [{ label: "name", value: "TEST Website" }],
  inputJson: '{"name":"TEST Website"}',
  reviewTruncated: false,
  summary: "",
};
const meta = {
  title: "Workflow/Service action",
  component: ServiceActionCard,
  args: { result, language: "en", disabled: false, onDecide: () => {} },
} satisfies Meta<typeof ServiceActionCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Approval: Story = {};
export const Czech: Story = { args: { language: "cs" } };
/** Raw keys, ISO instants and JSON lists read as labels, one time range and chips. */
export const CalendarEvent: Story = {
  args: {
    result: {
      ...result,
      title: "Create event",
      service: "Team Calendar",
      fields: [
        { label: "title", value: "TEST Call with Jana" },
        { label: "start", value: "2026-10-13T10:00:00+02:00" },
        { label: "end", value: "2026-10-13T10:30:00+02:00" },
        { label: "attendees", value: '["Jana","Tomáš"]' },
        { label: "sendInvites", value: "true" },
      ],
    },
  },
};
export const Completed: Story = {
  args: {
    result: {
      ...result,
      status: "succeeded",
      fields: [],
      inputJson: "",
      summary: '{"id":"TEST-123"}',
    },
  },
};
export const Unknown: Story = {
  args: { result: { ...result, status: "unknown", fields: [], inputJson: "" } },
};
export const FullParameters: Story = {
  args: {
    result: {
      ...result,
      reviewTruncated: true,
      inputJson: JSON.stringify({
        name: "TEST Website",
        description: "A long project description. ".repeat(100),
        recipient: "TEST-review@example.test",
      }),
    },
  },
};
export const ProcessReviewNarrow: Story = {
  render: (args) => (
    <View style={{ width: 320, maxWidth: "100%" }}>
      <ServiceActionCard {...args} />
    </View>
  ),
  args: {
    reviewFrame: {
      source: "https://TEST-server.example.test",
      workspace: "TEST-workspace",
      nativeRevision: 7,
      serviceId: "TEST-project-service",
      serviceRevision: 2,
      actionId: "TEST-create-project",
      actionRevision: 4,
    },
    result: {
      ...result,
      reviewTruncated: false,
      inputJson: JSON.stringify({
        name: "TEST Website",
        description: "TEST Original description. ".repeat(60),
        enabled: false,
        cleared: null,
        reviewers: ["first", " second "],
      }),
    },
  },
};
export const ProcessReviewNarrowCzech: Story = {
  ...ProcessReviewNarrow,
  args: { ...ProcessReviewNarrow.args, language: "cs" },
};
export const ProcessReviewIncomplete: Story = {
  ...ProcessReviewNarrow,
  args: {
    ...ProcessReviewNarrow.args,
    reviewFrame: {
      ...ProcessReviewNarrow.args!.reviewFrame!,
      workspace: undefined,
    },
  },
};

function completed(presentation: ServicePresentation): ServiceResult {
  return {
    ...result,
    title: "Search results",
    status: "succeeded",
    effect: "read",
    fields: [],
    inputJson: "",
    summary: '{"source":"Example service","count":4}',
    presentation,
  };
}

export const Contacts: Story = {
  args: {
    result: completed({
      kind: "contacts",
      hasMore: false,
      items: [
        {
          name: "Anna Nováková",
          subtitle: "Product designer",
          email: "anna@example.test",
          phone: "+420 555 010 001",
        },
        { name: "Petr Svoboda", email: "petr@example.test" },
        { name: "Marta Černá", phone: "+420 555 010 003" },
        {
          name: "Alex Miller",
          subtitle: "Project lead",
          email: "alex@example.test",
        },
      ],
    }),
  },
};

export const Contact: Story = {
  args: {
    result: completed({
      kind: "contacts",
      hasMore: false,
      items: [
        {
          name: "Anna Nováková",
          subtitle: "Product designer",
          email: "anna@example.test",
          phone: "+420 555 010 001",
        },
      ],
    }),
  },
};

export const ContactsCzech: Story = {
  args: { ...Contacts.args, language: "cs" },
};

export const Events: Story = {
  args: {
    result: completed({
      kind: "events",
      hasMore: false,
      items: [
        {
          title: "Project review",
          start: "2026-09-29T10:00:00+02:00",
          end: "2026-09-29T10:30:00+02:00",
          location: "Meeting room A",
        },
        { title: "Team planning", start: "2026-09-30T14:00:00Z" },
      ],
    }),
  },
};

export const Records: Story = {
  args: {
    result: completed({
      kind: "records",
      hasMore: true,
      items: [
        {
          title: "Website refresh",
          subtitle: "Project",
          fields: [
            { label: "Status", value: "In progress" },
            { label: "Owner", value: "Anna Nováková" },
          ],
        },
        {
          title: "Mobile onboarding",
          subtitle: "Project",
          fields: [
            { label: "Status", value: "Planned" },
            { label: "Owner", value: "Petr Svoboda" },
            {
              label: "Next step",
              value: "Review the prototype with the team.",
            },
          ],
        },
        {
          title: "Customer interviews",
          fields: [{ label: "Status", value: "Scheduled" }],
        },
        {
          title: "Launch checklist",
          fields: [{ label: "Status", value: "Draft" }],
        },
      ],
    }),
  },
};

export const Detail: Story = {
  args: {
    result: completed({
      kind: "detail",
      fields: [
        { label: "Name", value: "Website refresh" },
        { label: "Status", value: "In progress" },
        { label: "Owner", value: "Anna Nováková" },
      ],
    }),
  },
};

export const TextResult: Story = {
  args: {
    result: completed({
      kind: "text",
      text: "The design review is scheduled for Tuesday. The team will review the updated homepage and agree on the remaining changes.",
    }),
  },
};

export const EmptyContacts: Story = {
  args: { result: completed({ kind: "contacts", items: [], hasMore: false }) },
};

export const EmptyEvents: Story = {
  args: {
    result: completed({ kind: "events", items: [], hasMore: false }),
    language: "cs",
  },
};

export const EmptyRecords: Story = {
  args: { result: completed({ kind: "records", items: [], hasMore: false }) },
};

export const LongValues: Story = {
  args: {
    result: completed({
      kind: "records",
      hasMore: false,
      items: [
        {
          title:
            "Website refresh for the international customer support and operations teams",
          subtitle: "Planning and delivery across several teams and time zones",
          fields: [
            {
              label: "Description",
              value:
                "Review the website navigation, accessibility, and translated help content before launch. ".repeat(
                  5,
                ),
            },
            {
              label: "Reference",
              value: "long-unbroken-reference-" + "a".repeat(220),
            },
          ],
        },
      ],
    }),
  },
};

export const LongContact: Story = {
  args: {
    result: completed({
      kind: "contacts",
      hasMore: false,
      items: [
        {
          name: "Alexandra Nováková — International customer success team",
          email: "international-customer-success-and-operations@example.test",
          phone: "+420 555 010 001",
          subtitle: "Customer experience and delivery coordination",
        },
      ],
    }),
  },
};

/** Shapes the server sends for MCP reads: identifiers, empty results and composed cards. */
export const EmptyMailRead: Story = {
  args: {
    language: "cs",
    result: {
      ...result,
      title: "list-mail-messages",
      service: "Microsoft 365",
      status: "succeeded",
      effect: "read",
      fields: [],
      inputJson: "",
      summary: '{"value":[]}',
      card: {
        id: "service-" + "c".repeat(32),
        revision: 1,
        title: "List mail messages",
        subtitle: "Microsoft 365",
        icon: "check",
        nodes: [
          { id: "node-1", type: "badge", label: "Dokončeno", tone: "success" },
        ],
        root: ["node-1"],
        actions: [],
      },
    },
  },
};
export const ComposedMeeting: Story = {
  args: {
    language: "cs",
    result: {
      ...result,
      title: "get-calendar-view",
      service: "Microsoft 365",
      status: "succeeded",
      effect: "read",
      fields: [],
      inputJson: "",
      summary: "",
      card: {
        id: "d".repeat(64),
        revision: 1,
        title: "Schůzka příští pátek",
        subtitle: "Kalendář · pátek 9. října 2026",
        icon: "calendar",
        nodes: [
          {
            id: "meeting",
            type: "section",
            title: "Nalezená schůzka",
            icon: "calendar",
            children: ["subject", "time"],
          },
          {
            id: "subject",
            type: "field",
            label: "Schůzka",
            value: "TEST Porada",
            icon: "calendar",
          },
          {
            id: "time",
            type: "field",
            label: "Čas",
            value: "9:30–11:30 (Europe/Prague)",
            icon: "clock",
          },
        ],
        root: ["meeting"],
        actions: [],
      },
    },
  },
};
export const FailedRead: Story = {
  args: {
    result: {
      ...result,
      title: "search_tasks",
      service: "TEST CRM",
      status: "failed",
      effect: "read",
      inputJson: "",
      fields: [
        { label: "Reason", value: "The service connection failed." },
        { label: "Next step", value: "Try again later." },
        { label: "Error code", value: "TEST_CONNECTION" },
      ],
      summary: "Reason: The service connection failed.",
    },
  },
};
