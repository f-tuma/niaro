import React from "react";
import { View } from "react-native";
import type { Meta, StoryObj } from "@storybook/react-native";
import type { MemberService } from "../protocol/member-services";
import { MemberServicesView } from "./MemberServicesView";

const now = Date.UTC(2026, 10, 2, 9, 30);
const services: MemberService[] = [
  {
    serviceId: "svc-mail",
    name: "Mail",
    icon: "mail",
    iconSource: "custom",
    own: false,
    reads: {
      account: "own",
      actions: [{ id: "a1", name: "Find emails", description: "" }],
    },
    changes: {
      account: "own",
      actions: [{ id: "a2", name: "Send email", description: "" }],
    },
    signIn: "connected",
    lastRead: { at: now - 3_600_000 },
    lastFailure: null,
  },
  {
    serviceId: "svc-tracker",
    name: "Tracker",
    icon: "folder",
    iconSource: "custom",
    own: false,
    reads: {
      account: "company",
      actions: [{ id: "a3", name: "List issues", description: "" }],
    },
    changes: {
      account: "own",
      actions: [{ id: "a4", name: "File issue", description: "" }],
    },
    signIn: "disconnected",
    lastRead: null,
    lastFailure: null,
  },
  {
    serviceId: "svc-crm",
    name: "Company CRM",
    icon: "users",
    iconSource: "custom",
    own: false,
    reads: {
      account: "company",
      actions: [
        { id: "a5", name: "Find contact", description: "" },
        { id: "a6", name: "Read deals", description: "" },
      ],
    },
    changes: { account: "company", actions: [] },
    signIn: null,
    lastRead: { at: now - 86_400_000 },
    lastFailure: { at: now - 600_000, kind: "connection" },
  },
];

const meta = {
  title: "Connections/Where Niaro reads",
  component: MemberServicesView,
  args: { language: "en", services },
} satisfies Meta<typeof MemberServicesView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const CompanyOnly: Story = {
  args: { services: services.filter((service) => service.signIn === null) },
};
export const Loading: Story = { args: { services: undefined } };
export const Failed: Story = { args: { failed: true } };
export const Empty: Story = { args: { services: [] } };
export const CzechNarrow: Story = {
  args: { language: "cs" },
  render: (args) => (
    <View style={{ width: 300 }}>
      <MemberServicesView {...args} />
    </View>
  ),
};
