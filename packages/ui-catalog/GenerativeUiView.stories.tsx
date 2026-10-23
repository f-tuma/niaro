import type { Meta, StoryObj } from "@storybook/react-native";
import { GenerativeUiView } from "./GenerativeUiView";

const overview = `root = Stack([title, kpis, tabs, schedule, next])
title = Heading("Q3 sales", "l")
kpis = Row([Metric("Revenue", "1.2 M", "CZK", "+12 % vs Q2", "success"), Metric("Orders", 340, null, "-3 % vs Q2", "danger")])
tabs = Tabs([Tab("Trend", [bars, line]), Tab("Branches", [table]), Tab("Share", [pie])])
bars = BarChart(["Jul", "Aug", "Sep"], [Series("Prague", [380, 410, 440]), Series("Brno", [210, 190, 230])])
line = LineChart(["Jul", "Aug", "Sep"], [Series("Orders", [102, 118, 120])])
table = Table(["Branch", "Revenue", "Orders"], [["Prague", 520000, 180], ["Brno", 310000, 96], ["Ostrava", 180000, 64]], true)
pie = PieChart(["Prague", "Brno", "Ostrava"], [520, 310, 180])
schedule = Section("Next steps", [Timeline([TimelineItem("1 Oct", "Review", "With the branch leads", "info"), TimelineItem("15 Oct", "Plan Q4")]), Progress("Targets met", 7, 10)])
next = Buttons([Button("Compare with last year", @ToAssistant("Compare Q3 with Q3 last year"), "primary"), Button("Open the report", @OpenUrl("https://example.test/report"))])`;

const contact = `root = Stack([status, details, more, form])
status = Callout("The contract ends this month. Agree on a renewal.", "warning", "Renewal due")
details = Details([Detail("Owner", "Anna Nováková"), Detail("Email", "anna@example.test"), Detail("Phone", "+420 555 010 001"), Detail("Web", "https://example.test")])
more = Accordion([AccordionItem("History", [List([ListItem("Call", "Discussed the price", "2 Sep", Badge("Open", "info")), ListItem("Offer sent", null, "20 Aug")])])])
form = Form("renewal", [Select("length", "Length", ["1 year", "2 years", "3 years"], null, true), DateField("start", "Start"), Checkbox("notify", "Tell the team"), TextField("note", "Note", "Anything else")], Button("Prepare the renewal", @ToAssistant("Prepare the contract renewal")))`;

const meta = {
  title: "Chat/Generated answer",
  component: GenerativeUiView,
  args: {
    program: overview,
    language: "en",
    disabled: false,
    streaming: false,
    onFollowUp: () => {},
    onOpenUrl: () => {},
  },
} satisfies Meta<typeof GenerativeUiView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const RecordAndForm: Story = { args: { program: contact } };
export const ReadOnly: Story = { args: { program: contact, disabled: true } };
export const Streaming: Story = {
  args: { program: overview.slice(0, 420), streaming: true },
};
export const Czech: Story = {
  args: {
    language: "cs",
    program: `root = Stack([h, kpis, t, b])
h = Heading("Tržby za 3. čtvrtletí", "l")
kpis = Row([Metric("Tržby", 1250000, "Kč", "+12 % proti 2. čtvrtletí", "success"), Metric("Objednávky", 340)])
t = Table(["Pobočka", "Tržby"], [["Praha", 520000], ["Brno", 310000]], true)
b = Buttons([Button("Porovnat s loňskem", @ToAssistant("Porovnej 3. čtvrtletí s loňským"), "primary")])`,
  },
};
