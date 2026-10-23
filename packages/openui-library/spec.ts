import { z } from "zod";
import {
  action,
  createLibrary,
  defineComponent,
  markReactive,
  tagSchemaId,
  type DefinedComponent,
} from "@openuidev/lang-core";

/**
 * The one component vocabulary of generated answers (OpenUI Lang). The
 * server builds the model's instructions and validates programs from it;
 * the web app and the phone render the same names with their own design
 * system. Positional arguments follow the key order of each `props` object.
 */
export const GENERATIVE_UI_LIBRARY_ID = "niaro-ui@1";
export const GENERATIVE_UI_LIMITS = {
  /** Program source, including whitespace. */
  characters: 16000,
  /** Rendered component instances. */
  nodes: 64,
  /** Component nesting below the root. */
  depth: 8,
  actions: 12,
  /** Rows of a table, items of a list or timeline, points of a chart. */
  items: 50,
  columns: 8,
  series: 6,
  text: 2000,
} as const;

const L = GENERATIVE_UI_LIMITS;
const short = z.string().max(200);
const text = z.string().max(L.text);
const tone = z.enum(["neutral", "info", "success", "warning", "danger"]);
const value = z.union([z.string().max(200), z.number()]);
/** A form value: a literal or a `$variable` the person edits. */
const bound = <T extends z.ZodType>(schema: T) => {
  markReactive(schema);
  return schema;
};
const define = <T extends z.ZodObject>(
  name: string,
  description: string,
  props: T,
): DefinedComponent<T, null> =>
  defineComponent({ name, description, props, component: null });

export const Badge = define(
  "Badge",
  "A short state label; tone colours it.",
  z.object({ label: short, tone: tone.optional() }),
);
export const Detail = define(
  "Detail",
  "One label and value. A complete email, phone or https URL becomes a link.",
  z.object({ label: short, value }),
);
export const ListItem = define(
  "ListItem",
  "One record: title, a detail line, a trailing meta (time, amount), an exception badge, an action.",
  z.object({
    title: short,
    detail: text.optional(),
    meta: short.optional(),
    badge: z.optional(Badge.ref),
    action: action().optional(),
  }),
);
export const Series = define(
  "Series",
  "A named row of numbers, one per chart label.",
  z.object({ name: short, values: z.array(z.number()).max(L.items) }),
);
export const TimelineItem = define(
  "TimelineItem",
  "One dated step: time, title, detail, tone.",
  z.object({
    time: short,
    title: short,
    detail: text.optional(),
    tone: tone.optional(),
  }),
);

// Leaf content shared by every container.
export const Heading = define(
  "Heading",
  "A section title; size l only for the first heading.",
  z.object({ text: short, size: z.enum(["l", "m"]).optional() }),
);
export const Text = define(
  "Text",
  "A plain paragraph; muted for secondary notes.",
  z.object({ text, tone: z.enum(["default", "muted"]).optional() }),
);
export const Markdown = define(
  "Markdown",
  "Formatted text (bold, lists, links) when plain Text is not enough.",
  z.object({ text }),
);
export const Metric = define(
  "Metric",
  "One key number: label, value, unit, change versus a baseline (e.g. '+12 % vs last week'), tone.",
  z.object({
    label: short,
    value,
    unit: short.optional(),
    change: short.optional(),
    tone: tone.optional(),
  }),
);
export const Details = define(
  "Details",
  "Label/value pairs of one record.",
  z.object({ items: z.array(Detail.ref).max(L.items) }),
);
export const List = define(
  "List",
  "Records of the same kind, one row each.",
  z.object({ items: z.array(ListItem.ref).max(L.items) }),
);
export const Table = define(
  "Table",
  "Records compared by the same columns. rows holds one array of cells per record. sortable lets the person sort by a column.",
  z.object({
    columns: z.array(short).max(L.columns),
    rows: z
      .array(z.array(z.union([value, z.null()])).max(L.columns))
      .max(L.items),
    sortable: z.boolean().optional(),
  }),
);
export const BarChart = define(
  "BarChart",
  "Compares amounts across categories.",
  z.object({
    labels: z.array(short).max(L.items),
    series: z.array(Series.ref).max(L.series),
    horizontal: z.boolean().optional(),
    stacked: z.boolean().optional(),
  }),
);
export const LineChart = define(
  "LineChart",
  "A trend over time; labels are the points in time.",
  z.object({
    labels: z.array(short).max(L.items),
    series: z.array(Series.ref).max(L.series),
  }),
);
export const PieChart = define(
  "PieChart",
  "Shares of one whole; at most 8 slices.",
  z.object({
    labels: z.array(short).max(12),
    values: z.array(z.number()).max(12),
    donut: z.boolean().optional(),
  }),
);
export const Progress = define(
  "Progress",
  "A real count toward a total (default 100).",
  z.object({ label: short, value: z.number(), max: z.number().optional() }),
);
export const Timeline = define(
  "Timeline",
  "A schedule or history in order.",
  z.object({ items: z.array(TimelineItem.ref).max(L.items) }),
);
export const Callout = define(
  "Callout",
  "A note that needs attention: what happened and what to do.",
  z.object({
    text,
    tone: z.enum(["info", "success", "warning", "danger"]).optional(),
    title: short.optional(),
  }),
);
export const Separator = define(
  "Separator",
  "A divider between groups.",
  z.object({}),
);
export const Link = define(
  "Link",
  "Opens an https web page.",
  z.object({ label: short, url: z.string().max(2000) }),
);
export const Button = define(
  "Button",
  "A next step. Without an action it puts its label in the person's message box.",
  z.object({
    label: short,
    action: action().optional(),
    variant: z.enum(["primary", "secondary"]).optional(),
  }),
);
export const Buttons = define(
  "Buttons",
  "A row of buttons; at most one primary.",
  z.object({ buttons: z.array(Button.ref).max(4) }),
);
export const TextField = define(
  "TextField",
  "A text input in a Form.",
  z.object({
    name: short,
    label: short,
    placeholder: short.optional(),
    value: bound(z.string().max(L.text).optional()),
    required: z.boolean().optional(),
  }),
);
export const Select = define(
  "Select",
  "One choice of a few options in a Form.",
  z.object({
    name: short,
    label: short,
    options: z.array(short).max(20),
    value: bound(short.optional()),
    required: z.boolean().optional(),
  }),
);
export const Checkbox = define(
  "Checkbox",
  "A yes/no answer in a Form.",
  z.object({
    name: short,
    label: short,
    value: bound(z.boolean().optional()),
  }),
);
export const DateField = define(
  "DateField",
  "A date (YYYY-MM-DD) in a Form.",
  z.object({
    name: short,
    label: short,
    value: bound(z.string().max(10).optional()),
    required: z.boolean().optional(),
  }),
);
const field = z.union([TextField.ref, Select.ref, Checkbox.ref, DateField.ref]);
export const Form = define(
  "Form",
  "Questions the person answers; the button's @ToAssistant message is sent with the answers after the person reviews it.",
  z.object({
    name: short,
    fields: z.array(field).max(12),
    buttons: z.union([Buttons.ref, Button.ref]),
  }),
);

const leaf = [
  Heading,
  Text,
  Markdown,
  Metric,
  Badge,
  Details,
  List,
  Table,
  BarChart,
  LineChart,
  PieChart,
  Progress,
  Timeline,
  Callout,
  Separator,
  Link,
  Button,
  Buttons,
  Form,
];
type Ref = (typeof leaf)[number]["ref"];
/** Any content, data, chart or action component; its own name in prompts. */
const block = z.union(leaf.map((component) => component.ref) as [Ref, Ref]);
tagSchemaId(block, "Block");
// Containers nest one way only (Stack > Tabs/Accordion > Section > Row/Grid),
// which keeps generated layouts shallow.
const blocks = (...containers: z.core.$ZodType[]) =>
  z.array(z.union([block, ...containers])).max(24);
export const Row = define(
  "Row",
  "Blocks side by side (e.g. Metrics); wraps on a phone.",
  z.object({ children: blocks() }),
);
export const Grid = define(
  "Grid",
  "Equal tiles in 2–4 columns; one column on a phone.",
  z.object({
    children: blocks(),
    columns: z.number().int().min(2).max(4).optional(),
  }),
);
export const Section = define(
  "Section",
  "A titled group.",
  z.object({ title: short, children: blocks(Row.ref, Grid.ref) }),
);
export const Tab = define(
  "Tab",
  "One tab: label and content.",
  z.object({
    label: short,
    children: blocks(Row.ref, Grid.ref, Section.ref),
  }),
);
export const Tabs = define(
  "Tabs",
  "Alternative views of the same answer; 2–5 tabs.",
  z.object({ tabs: z.array(Tab.ref).max(5) }),
);
export const AccordionItem = define(
  "AccordionItem",
  "One collapsible part, closed at first.",
  z.object({
    title: short,
    children: blocks(Row.ref, Grid.ref, Section.ref),
  }),
);
export const Accordion = define(
  "Accordion",
  "Optional detail the person can expand.",
  z.object({ items: z.array(AccordionItem.ref).max(12) }),
);
export const Stack = define(
  "Stack",
  "The root: blocks from top to bottom.",
  z.object({
    children: blocks(Row.ref, Grid.ref, Section.ref, Tabs.ref, Accordion.ref),
  }),
);

export const GENERATIVE_UI_COMPONENTS = [
  Stack,
  Row,
  Grid,
  Section,
  Tabs,
  Tab,
  Accordion,
  AccordionItem,
  ...leaf,
  Detail,
  ListItem,
  Series,
  TimelineItem,
  TextField,
  Select,
  Checkbox,
  DateField,
];
export type GenerativeUiComponentName =
  (typeof GENERATIVE_UI_COMPONENTS)[number]["name"];

export const GENERATIVE_UI_GROUPS = [
  {
    name: "Layout",
    notes: [
      "Block is any component of Content, Data, Charts or Actions and forms.",
    ],
    components: [
      "Stack",
      "Row",
      "Grid",
      "Section",
      "Tabs",
      "Tab",
      "Accordion",
      "AccordionItem",
      "Separator",
    ],
  },
  {
    name: "Content",
    components: ["Heading", "Text", "Markdown", "Callout", "Badge", "Link"],
  },
  {
    name: "Data",
    components: [
      "Metric",
      "Details",
      "Detail",
      "List",
      "ListItem",
      "Table",
      "Progress",
      "Timeline",
      "TimelineItem",
    ],
  },
  {
    name: "Charts",
    components: ["BarChart", "LineChart", "PieChart", "Series"],
  },
  {
    name: "Actions and forms",
    components: [
      "Button",
      "Buttons",
      "Form",
      "TextField",
      "Select",
      "Checkbox",
      "DateField",
    ],
  },
];

/** Renderer-free library: the server's prompt and validator, and the base
 * every client binds its own components to. */
export const generativeUiLibrary = createLibrary({
  id: GENERATIVE_UI_LIBRARY_ID,
  root: "Stack",
  components: GENERATIVE_UI_COMPONENTS,
  componentGroups: GENERATIVE_UI_GROUPS,
});
