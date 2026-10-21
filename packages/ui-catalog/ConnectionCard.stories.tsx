import type { Meta, StoryObj } from "@storybook/react-native";
import { AUTH_PROFILE, PROFILE } from "../protocol";
import { scopeFor } from "../test-fixtures";
import { ConnectionCard } from "./ConnectionCard";
const meta = {
  title: "Connection/Pairing",
  component: ConnectionCard,
  args: {
    language: "en",
    address: "https://server.example/v1/a",
    activeAddress: null,
    status: "signed_out",
    identity: null,
    error: null,
    development: false,
    web: false,
    onAddress: () => {},
    onPair: () => {},
    onDisconnect: () => {},
  },
} satisfies Meta<typeof ConnectionCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedOut: Story = {};
export const AccountSignIn: Story = { args: { address: "https://server.example", onBrowserSignIn: () => {} } };
export const BrowserConfirmation: Story = { args: { language: "cs", address: "https://server.example", status: "pairing", onBrowserSignIn: () => {}, onOpenBrowser: () => {}, browserLogin: { userCode: "ABCD1234EF56", verificationUri: "https://server.example/admin/device#ABCD1234EF56", expiresAt: "2099-01-01T00:00:00Z" } } };
export const Czech: Story = { args: { language: "cs" } };
export const Pairing: Story = { args: { status: "pairing" } };
export const InvalidCode: Story = { args: { error: "pairing_invalid" } };
export const Expired: Story = { args: { status: "expired" } };
export const WebPreview: Story = { args: { web: true } };
export const RevocationUnconfirmed: Story = {
  args: { error: "logout_unconfirmed" },
};
export const SignedIn: Story = {
  args: {
    status: "connected",
    activeAddress: "https://server.example/v1/a",
    identity: {
      authProfile: AUTH_PROFILE,
      profile: PROFILE,
      scope: scopeFor(),
      expiresAt: "2026-10-01T12:00:00.000Z",
      permissions: ["workflow.read", "workflow.write"],
    },
  },
};
