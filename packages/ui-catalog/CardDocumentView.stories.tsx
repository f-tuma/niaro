import type { Meta, StoryObj } from "@storybook/react-native";
import type { CardDocument } from "../protocol/card-document";
import { CardDocumentView } from "./CardDocumentView";

const document: CardDocument = {
  id: "project-review",
  revision: 1,
  title: "Website launch review",
  subtitle: "A clear view of the next decision",
  icon: "calendar",
  root: ["status", "summary", "facts", "people", "progress", "details"],
  nodes: [
    { id: "status", type: "badge", label: "Ready to review", tone: "info" },
    {
      id: "summary",
      type: "text",
      text: "The prototype is ready. Agree on the review time before preparing a calendar event.",
    },
    { id: "facts", type: "columns", children: ["owner", "due"] },
    {
      id: "owner",
      type: "field",
      label: "Owner",
      value: "Anna Nováková",
      icon: "person",
    },
    {
      id: "due",
      type: "field",
      label: "Suggested time",
      value: "1 October · 14:30 CEST",
      icon: "clock",
    },
    {
      id: "people",
      type: "section",
      title: "Review with",
      icon: "person",
      children: ["reviewers"],
    },
    {
      id: "reviewers",
      type: "list",
      items: [
        { title: "Anna Nováková", detail: "Product designer", icon: "person" },
        { title: "Petr Svoboda", detail: "Project lead", icon: "person" },
      ],
    },
    {
      id: "progress",
      type: "progress",
      label: "Preparation",
      value: 3,
      total: 4,
    },
    {
      id: "details",
      type: "disclosure",
      label: "Review notes",
      children: ["note"],
    },
    {
      id: "note",
      type: "text",
      text: "Check navigation, accessibility and Czech copy. Calendar changes will require a separate confirmation.",
    },
  ],
  actions: [],
};
const meta = {
  title: "Workflow/Composable card",
  component: CardDocumentView,
  args: { document, language: "en" },
} satisfies Meta<typeof CardDocumentView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const Czech: Story = {
  args: {
    language: "cs",
    document: {
      ...document,
      title: "Kontrola před spuštěním webu",
      subtitle: "Přehled dalšího rozhodnutí",
      nodes: [
        {
          id: "status",
          type: "badge",
          label: "Připraveno ke kontrole",
          tone: "info",
        },
        {
          id: "summary",
          type: "text",
          text: "Prototyp je připravený. Vyber termín kontroly, než připravíme událost v kalendáři.",
        },
        { id: "facts", type: "columns", children: ["owner", "due"] },
        {
          id: "owner",
          type: "field",
          label: "Odpovídá",
          value: "Anna Nováková",
          icon: "person",
        },
        {
          id: "due",
          type: "field",
          label: "Navržený termín",
          value: "1. října · 14:30 SELČ",
          icon: "clock",
        },
        {
          id: "people",
          type: "section",
          title: "Účastníci kontroly",
          icon: "person",
          children: ["reviewers"],
        },
        {
          id: "reviewers",
          type: "list",
          items: [
            {
              title: "Anna Nováková",
              detail: "Produktová designérka",
              icon: "person",
            },
            {
              title: "Petr Svoboda",
              detail: "Vedoucí projektu",
              icon: "person",
            },
          ],
        },
        {
          id: "progress",
          type: "progress",
          label: "Příprava",
          value: 3,
          total: 4,
        },
        {
          id: "details",
          type: "disclosure",
          label: "Poznámky ke kontrole",
          children: ["note"],
        },
        {
          id: "note",
          type: "text",
          text: "Zkontrolovat navigaci, přístupnost a české texty. Změny v kalendáři budou vyžadovat samostatné potvrzení.",
        },
      ],
    },
  },
};
export const LongContent: Story = {
  args: {
    document: {
      id: "long-content",
      revision: 1,
      title:
        "Website refresh for the international customer support and operations teams",
      subtitle: "Planning and delivery across several teams and time zones",
      root: ["reference", "warning", "notes"],
      nodes: [
        {
          id: "reference",
          type: "field",
          label: "Reference",
          value: "long-unbroken-reference-" + "a".repeat(220),
          icon: "link",
        },
        {
          id: "warning",
          type: "notice",
          tone: "warning",
          text: "The outcome has not been verified. Check the service before attempting the action again.",
        },
        {
          id: "notes",
          type: "text",
          tone: "secondary",
          text: "Review navigation, accessibility and translated help content before launch. ".repeat(
            6,
          ),
        },
      ],
      actions: [],
    },
  },
};
export const InvalidDocument: Story = {
  args: { document: { ...document, root: ["missing"] } },
};

const contactLinks = (language: "en" | "cs"): CardDocument => ({
  id: "TEST-contact-links",
  revision: 1,
  title: language === "cs" ? "TEST Anna Nováková" : "TEST Anna Novak",
  subtitle:
    language === "cs" ? "Projektová koordinátorka" : "Project coordinator",
  icon: "person",
  root: ["phone", "email", "meeting", "reference"],
  actions: [],
  nodes: [
    {
      id: "phone",
      type: "field",
      label: language === "cs" ? "Telefon" : "Phone",
      value: "+420 555 010 001",
      icon: "phone",
    },
    {
      id: "email",
      type: "field",
      label: language === "cs" ? "E-mail" : "Email",
      value: "anna@example.test",
      icon: "mail",
    },
    {
      id: "meeting",
      type: "field",
      label: language === "cs" ? "Odkaz na schůzku" : "Meeting link",
      value: "https://example.test/meetings/project-review",
      icon: "link",
    },
    {
      id: "reference",
      type: "field",
      label: language === "cs" ? "Číslo projektu" : "Project number",
      value: "555010001",
    },
  ],
});
export const ContactLinks: Story = {
  args: { document: contactLinks("en") },
};
export const ContactLinksCzech: Story = {
  args: { document: contactLinks("cs"), language: "cs" },
};
