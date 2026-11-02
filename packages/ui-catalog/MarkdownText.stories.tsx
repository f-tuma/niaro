import type { Meta, StoryObj } from "@storybook/react-native";
import React from "react";
import { MarkdownCopyContext, MarkdownText } from "./MarkdownText";
const meta = {
  title: "Chat/Markdown reply",
  component: MarkdownText,
  args: {
    text: "## Contact found\n\n**Jane Example** is in the CRM.\n\n- Email: [jane@example.test](mailto:jane@example.test)\n- [Open CRM](https://example.test/contact)\n\n> Tasks could not be verified. Ask an administrator to enable the task search action.\n\n| Part | Result |\n| --- | --- |\n| Contact | Verified |\n| Tasks | Unverified |",
  },
} satisfies Meta<typeof MarkdownText>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = {};
export const Czech: Story = {
  args: {
    text: "## Kontakt nalezen\n\n**Jana Příkladová** je v CRM.\n\n- Email: [jana@example.test](mailto:jana@example.test)\n- [Otevřít CRM](https://example.test/contact)\n\n> Úkoly se nepodařilo ověřit. Správce musí zpřístupnit akci pro hledání úkolů.\n\n| Část | Výsledek |\n| --- | --- |\n| Kontakt | Ověřeno |\n| Úkoly | Neověřeno |",
  },
};
export const CodeAndNestedLists: Story = {
  args: {
    text: '1. Review the result\n   - [x] Contact verified\n   - [ ] Tasks unverified\n\n~~~json\n{ "verified": false }\n~~~\n\n~~Unconfirmed assumption~~',
  },
};
export const PassiveUntrustedContent: Story = {
  args: {
    text: "[Unsafe link](javascript:alert%281%29)\n\n<script>TEST</script>\n\n![Image description](https://example.test/private.png)",
  },
};
/** NIAR-266: two heading steps, a header row and Copy code under a block. */
const reading =
  "# Deals this week\n\nThree deals moved.\n\n### Owners\n\n| Deal | Owner | Amount |\n| --- | --- | ---: |\n| TEST Acme | Jana | 1 200 |\n| TEST Beta | Tomáš | 300 |\n\n#### Export\n\n~~~sh\ncurl https://example.test/deals.csv\n~~~";
export const HeadingsTableAndCopyCode: Story = {
  args: { text: reading },
  render: (args) => (
    <MarkdownCopyContext.Provider
      value={{ copy: async () => {}, language: "en" }}
    >
      <MarkdownText {...args} />
    </MarkdownCopyContext.Provider>
  ),
};
export const HeadingsTableAndCopyCodeCzech: Story = {
  args: {
    text: "# Obchody tento týden\n\nPohnuly se tři obchody.\n\n### Vlastníci\n\n| Obchod | Vlastník |\n| --- | --- |\n| TEST Acme | Jana |\n\n~~~sh\ncurl https://example.test/obchody.csv\n~~~",
  },
  render: (args) => (
    <MarkdownCopyContext.Provider
      value={{ copy: async () => {}, language: "cs" }}
    >
      <MarkdownText {...args} />
    </MarkdownCopyContext.Provider>
  ),
};
/** Without a clipboard from the app (a native build today), no action. */
export const CodeWithoutClipboard: Story = {
  args: { text: "~~~\nx = 1\n~~~" },
  render: (args) => (
    <MarkdownCopyContext.Provider value={{ language: "en" }}>
      <MarkdownText {...args} />
    </MarkdownCopyContext.Provider>
  ),
};
