import { z } from "zod";
import { ScopeSchema } from "./index";
import { IdentityId } from "./identity";
import { HumanTaskId } from "./human-tasks";
import { hubWidgetDefinition } from "./widgets";

/**
 * The person's overview ("Overview") above the chat: a short list of items the
 * person chose. The built-in Tasks item needs no process; every other item is
 * a process the person can run, refreshed through the ordinary start path.
 */
export const HUB_PROFILE = "agent-hub/1" as const;
export const HUB_ITEM_LIMIT = 12;
export const HUB_TITLE_MAX = 80;
const iso = z.iso.datetime();
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const HubRefreshSchema = z.enum([
  "manual",
  "hourly",
  "daily",
  "on_open",
]);
export type HubRefresh = z.infer<typeof HubRefreshSchema>;
export const HubItemKindSchema = z.enum(["tasks", "process"]);
export const HubTitleSchema = z.string().trim().min(1).max(HUB_TITLE_MAX);

/** A compact, already redacted reading of a process's output, never raw data. */
export const HubOutputSchema = z.strictObject({
  /** Readable text (Markdown) the process returned, e.g. a summary. */
  text: z.string().max(4000).optional(),
  fields: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(160),
        value: z.string().max(1000).optional(),
        items: z.array(z.string().max(500)).max(8).optional(),
        /** Items left out of `items`. */
        more: z.number().int().nonnegative().max(10_000).optional(),
      }),
    )
    .max(12),
  /** Some fields or items did not fit. */
  truncated: z.boolean(),
  /** Sensitive values were hidden. */
  redacted: z.boolean(),
});
export type HubOutput = z.infer<typeof HubOutputSchema>;

export const HubResultSourceSchema = z.enum(["schedule", "open", "manual"]);
export type HubResultSource = z.infer<typeof HubResultSourceSchema>;
export const HubResultSchema = z.strictObject({
  status: z.enum(["running", "waiting", "succeeded", "failed"]),
  startedAt: iso,
  /** When the result was produced; null while running. */
  producedAt: iso.nullable(),
  /** The native parent run; absent until the start is admitted. */
  runId: IdentityId.optional(),
  /** The chat that follows the item's runs (approvals and questions wait there). */
  conversationId: z
    .string()
    .regex(/^[a-zA-Z0-9._:-]{1,160}$/)
    .optional(),
  waiting: z.enum(["approval", "question"]).optional(),
  error: code.optional(),
  output: HubOutputSchema.optional(),
  /** What started the refresh: the server's schedule, opening the hub or the
   * person (the refresh button, an add or a changed request). Clients may ignore it. */
  source: HubResultSourceSchema.optional(),
});
export type HubResult = z.infer<typeof HubResultSchema>;

const hubItemShape = {
  id: IdentityId,
  kind: HubItemKindSchema,
  processId: IdentityId.optional(),
  title: HubTitleSchema,
  refresh: HubRefreshSchema,
  position: z.number().int().nonnegative(),
  createdAt: iso,
  result: HubResultSchema.nullable(),
  /** The server would refresh it on open (never run or older than its policy). */
  stale: z.boolean(),
};
export const HubItemSchema = z
  .strictObject(hubItemShape)
  .refine((item) => (item.kind === "process") === !!item.processId);
export type HubItem = z.infer<typeof HubItemSchema>;

export const HubViewSchema = z.strictObject({
  profile: z.literal(HUB_PROFILE),
  scope: ScopeSchema,
  revision: z.number().int().positive(),
  items: z.array(HubItemSchema).max(HUB_ITEM_LIMIT),
  /** The built-in Tasks item: open items to resolve, newest first. */
  tasks: z.strictObject({
    open: z.number().int().nonnegative(),
    top: z
      .array(z.strictObject({ id: HumanTaskId, title: z.string().max(1000) }))
      .max(3),
  }),
});
export type HubView = z.infer<typeof HubViewSchema>;

/** The commands both profiles share; `agent-hub/2` adds widget views and layout. */
const baseCommands = <P extends string>(name: P) => {
  const profile = { profile: z.literal(name) };
  return {
    profile,
    commands: [
      z.strictObject({
        ...profile,
        type: z.literal("remove"),
        itemId: IdentityId,
      }),
      z.strictObject({
        ...profile,
        type: z.literal("rename"),
        itemId: IdentityId,
        title: HubTitleSchema,
      }),
      z.strictObject({
        ...profile,
        type: z.literal("setRefresh"),
        itemId: IdentityId,
        refresh: HubRefreshSchema,
      }),
      z.strictObject({
        ...profile,
        type: z.literal("reorder"),
        itemIds: z.array(IdentityId).max(HUB_ITEM_LIMIT),
      }),
      /** Explicit refresh of the named items; `stale` refreshes what is due on open. */
      z.strictObject({
        ...profile,
        type: z.literal("refresh"),
        itemIds: z.array(IdentityId).max(HUB_ITEM_LIMIT).optional(),
        stale: z.literal(true).optional(),
      }),
    ] as const,
  };
};
const v1 = baseCommands(HUB_PROFILE);
export const HubCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...v1.profile,
    type: z.literal("add"),
    kind: HubItemKindSchema,
    processId: IdentityId.optional(),
    title: HubTitleSchema.optional(),
    refresh: HubRefreshSchema.optional(),
  }),
  ...v1.commands,
]);
export type HubCommand = z.infer<typeof HubCommandSchema>;

/** The chat that follows one hub item's runs; one per item, reused. */
export const hubConversationId = (itemId: string) => `chat-hub-${itemId}`;
/** A process can be on the hub only if it starts without any input. */
export const hubEligibleInput = (schema: {
  type: string;
  required?: readonly string[];
}) => schema.type === "object" && !(schema.required ?? []).length;

/*
 * agent-hub/2: the overview as a personal dashboard. Every item is a widget
 * with a place on a twelve-column grid and a view that says how its
 * process's output is shown. The output schema of the process's active
 * version decides which views fit (`fields`); the server checks every view
 * against it and projects the redacted output into the view's `data`.
 */
export const HUB_PROFILE_V2 = "agent-hub/2" as const;
export const HUB_COLUMNS = 12;
/** The tallest widget, in grid rows. */
export const HUB_MAX_HEIGHT = 10;
/** The lowest row a widget may start on. */
export const HUB_MAX_ROW = 240;
export const HubFieldKeySchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);

export const HubLayoutSchema = z
  .strictObject({
    x: z
      .number()
      .int()
      .min(0)
      .max(HUB_COLUMNS - 1),
    y: z.number().int().min(0).max(HUB_MAX_ROW),
    w: z.number().int().min(1).max(HUB_COLUMNS),
    h: z.number().int().min(1).max(HUB_MAX_HEIGHT),
  })
  .refine((layout) => layout.x + layout.w <= HUB_COLUMNS);
export type HubLayout = z.infer<typeof HubLayoutSchema>;

export const HubChartKindSchema = z.enum(["bar", "line", "area", "pie"]);
export type HubChartKind = z.infer<typeof HubChartKindSchema>;
const viewLabel = z.string().trim().min(1).max(80);
/** How a widget shows its data; `summary` is the overview's original reading. */
export const HubWidgetViewSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("summary") }),
  /** The built-in Tasks widget. */
  z.strictObject({ type: z.literal("tasks") }),
  /** One numeric field, with an optional comparison. */
  z.strictObject({
    type: z.literal("number"),
    field: HubFieldKeySchema,
    label: viewLabel.optional(),
    unit: z.string().trim().min(1).max(16).optional(),
    /** The previous refresh's value, or another numeric field (e.g. a target). */
    compare: z
      .union([
        z.literal("previous"),
        z.strictObject({
          field: HubFieldKeySchema,
          label: viewLabel.optional(),
        }),
      ])
      .optional(),
  }),
  /** An array field as rows; objects show the chosen title and subtitle. */
  z.strictObject({
    type: z.literal("list"),
    field: HubFieldKeySchema,
    title: HubFieldKeySchema.optional(),
    subtitle: HubFieldKeySchema.optional(),
  }),
  /** An array of objects with the chosen columns. */
  z.strictObject({
    type: z.literal("table"),
    field: HubFieldKeySchema,
    columns: z
      .array(
        z.strictObject({ key: HubFieldKeySchema, label: viewLabel.optional() }),
      )
      .min(1)
      .max(6),
  }),
  /** An array of objects as a chart: `x` names each point, `y` is its value. */
  z.strictObject({
    type: z.literal("chart"),
    chart: HubChartKindSchema,
    field: HubFieldKeySchema,
    x: HubFieldKeySchema.optional(),
    y: HubFieldKeySchema.optional(),
  }),
  /** A text (Markdown) field. */
  z.strictObject({ type: z.literal("text"), field: HubFieldKeySchema }),
  /** agent-hub/3: a typed widget from the registry (`widget` says which). */
  z.strictObject({ type: z.literal("widget") }),
]);
export type HubWidgetView = z.infer<typeof HubWidgetViewSchema>;
export type HubWidgetType = HubWidgetView["type"];

const scalarType = z.enum(["number", "string", "boolean"]);
/**
 * A top-level field of the process output, from its frozen output schema.
 * Arrays name their scalar `items` type or, for objects, their scalar `fields`.
 */
export const HubFieldSchema = z.strictObject({
  key: HubFieldKeySchema,
  label: z.string().min(1).max(160),
  type: z.enum(["number", "string", "boolean", "array", "object"]),
  items: scalarType.optional(),
  fields: z
    .array(
      z.strictObject({
        key: HubFieldKeySchema,
        label: z.string().min(1).max(160),
        type: scalarType,
      }),
    )
    .max(24)
    .optional(),
});
export type HubField = z.infer<typeof HubFieldSchema>;

const cell = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const more = z.number().int().nonnegative().max(1_000_000);
/** The redacted output, already shaped for the widget's view. */
export const HubWidgetDataSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("number"),
    value: z.number().finite().nullable(),
    compare: z.strictObject({ value: z.number().finite() }).optional(),
  }),
  z.strictObject({
    type: z.literal("list"),
    rows: z
      .array(
        z.strictObject({
          title: z.string().max(500),
          subtitle: z.string().max(500).optional(),
        }),
      )
      .max(20),
    more,
  }),
  z.strictObject({
    type: z.literal("table"),
    columns: z
      .array(
        z.strictObject({
          key: HubFieldKeySchema,
          label: z.string().min(1).max(160),
        }),
      )
      .max(6),
    rows: z.array(z.array(cell).max(6)).max(20),
    more,
  }),
  z.strictObject({
    type: z.literal("chart"),
    points: z
      .array(
        z.strictObject({
          label: z.string().max(160),
          value: z.number().finite(),
        }),
      )
      .max(24),
    more,
  }),
  z.strictObject({ type: z.literal("text"), text: z.string().max(4000) }),
]);
export type HubWidgetData = z.infer<typeof HubWidgetDataSchema>;

export const HubWidgetSchema = z
  .strictObject({
    ...hubItemShape,
    layout: HubLayoutSchema,
    view: HubWidgetViewSchema,
    /** The view's data from the latest good output; null without one or when
     * the output does not have the view's fields. */
    data: HubWidgetDataSchema.nullable(),
    /** The output's fields; null while the process cannot be read. */
    fields: z.array(HubFieldSchema).max(24).nullable(),
  })
  .refine((item) => (item.kind === "process") === !!item.processId);
export type HubWidget = z.infer<typeof HubWidgetSchema>;

export const HubDashboardSchema = z.strictObject({
  profile: z.literal(HUB_PROFILE_V2),
  scope: ScopeSchema,
  revision: z.number().int().positive(),
  items: z.array(HubWidgetSchema).max(HUB_ITEM_LIMIT),
  tasks: HubViewSchema.shape.tasks,
});
export type HubDashboard = z.infer<typeof HubDashboardSchema>;

const v2 = baseCommands(HUB_PROFILE_V2);
export const HubDashboardCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...v2.profile,
    type: z.literal("add"),
    kind: HubItemKindSchema,
    processId: IdentityId.optional(),
    title: HubTitleSchema.optional(),
    refresh: HubRefreshSchema.optional(),
    /** Chosen from the output schema when absent. */
    view: HubWidgetViewSchema.optional(),
    /** The first free place when absent. */
    layout: HubLayoutSchema.optional(),
  }),
  ...v2.commands,
  z.strictObject({
    ...v2.profile,
    type: z.literal("setView"),
    itemId: IdentityId,
    view: HubWidgetViewSchema,
  }),
  /** The whole grid at once: every current item exactly once, none overlapping. */
  z.strictObject({
    ...v2.profile,
    type: z.literal("layout"),
    items: z
      .array(z.strictObject({ itemId: IdentityId, layout: HubLayoutSchema }))
      .max(HUB_ITEM_LIMIT),
  }),
]);
export type HubDashboardCommand = z.infer<typeof HubDashboardCommandSchema>;
/** Either profile; the answer comes in the command's own profile. */
export const HubAnyCommandSchema = z.union([
  HubCommandSchema,
  HubDashboardCommandSchema,
]);

/*
 * agent-hub/3: typed widgets. Besides Tasks and process widgets, an item can
 * be a widget of a registered type (`packages/protocol/widgets`): its data
 * has the type's own schema and comes from an AI fill over the person's read
 * actions (`fill: "ai"`), from the server (`server`) or from what the app
 * already has (`client`). The brief is the person's request in their words;
 * the agent decides which services and actions answer it.
 */
export const HUB_PROFILE_V3 = "agent-hub/3" as const;
export const HUB_BRIEF_MAX = 1000;
export const HUB_SOURCES_MAX = 6;
export const HubItemKindV3Schema = z.enum(["tasks", "process", "widget"]);
export const HubWidgetTypeKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}$/);
export const HubBriefSchema = z.string().trim().min(1).max(HUB_BRIEF_MAX);
/** A service the person pointed the widget at; a hint, never a grant. */
export const HubWidgetSourceSchema = z.strictObject({
  id: IdentityId,
  name: z.string().min(1).max(120),
});
export const HubWidgetStateSchema = z.strictObject({
  type: HubWidgetTypeKeySchema,
  version: z.number().int().positive(),
  fill: z.enum(["ai", "server", "client"]),
  /** What the person wants to see, in their words (AI widgets). */
  brief: z.string().max(HUB_BRIEF_MAX),
  config: z.record(z.string().max(40), z.unknown()),
  sources: z.array(HubWidgetSourceSchema).max(HUB_SOURCES_MAX),
  /** The latest good data in the type's schema; null before the first fill. */
  data: z.unknown().nullable(),
  /** What the latest good fill read, for the person. */
  recipe: z
    .strictObject({
      services: z.array(z.string().max(120)).max(HUB_SOURCES_MAX),
      reads: z.number().int().min(0).max(12),
    })
    .nullable(),
  /** A refresh was asked for (e.g. by the assistant); it runs on the next open. */
  requested: z.boolean(),
});
export type HubWidgetState = z.infer<typeof HubWidgetStateSchema>;

export const HubCardSchema = z
  .strictObject({
    ...hubItemShape,
    kind: HubItemKindV3Schema,
    layout: HubLayoutSchema,
    view: HubWidgetViewSchema,
    data: HubWidgetDataSchema.nullable(),
    fields: z.array(HubFieldSchema).max(24).nullable(),
    widget: HubWidgetStateSchema.nullable(),
  })
  .superRefine((item, ctx) => {
    if ((item.kind === "process") !== !!item.processId)
      ctx.addIssue({ code: "custom", message: "hub_item_kind" });
    if (
      (item.kind === "widget") !== !!item.widget ||
      (item.kind === "widget") !== (item.view.type === "widget")
    )
      ctx.addIssue({ code: "custom", message: "hub_item_kind" });
    const widget = item.widget;
    const definition = widget && hubWidgetDefinition(widget.type);
    // A type this build doesn't know is shown as unknown, never parsed.
    if (!widget || !definition || definition.version !== widget.version) return;
    if (!definition.config.safeParse(widget.config).success)
      ctx.addIssue({ code: "custom", message: "hub_widget_config" });
    if (widget.data !== null && !definition.data.safeParse(widget.data).success)
      ctx.addIssue({ code: "custom", message: "hub_widget_data" });
  });
export type HubCard = z.infer<typeof HubCardSchema>;

export const HubDashboardV3Schema = z.strictObject({
  profile: z.literal(HUB_PROFILE_V3),
  scope: ScopeSchema,
  revision: z.number().int().positive(),
  items: z.array(HubCardSchema).max(HUB_ITEM_LIMIT),
  tasks: HubViewSchema.shape.tasks,
});
export type HubDashboardV3 = z.infer<typeof HubDashboardV3Schema>;

const v3 = baseCommands(HUB_PROFILE_V3);
const widgetConfigInput = z.record(z.string().max(40), z.unknown());
export const HubDashboardV3CommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...v3.profile,
    type: z.literal("add"),
    kind: HubItemKindV3Schema,
    processId: IdentityId.optional(),
    title: HubTitleSchema.optional(),
    refresh: HubRefreshSchema.optional(),
    view: HubWidgetViewSchema.optional(),
    layout: HubLayoutSchema.optional(),
    /** kind "widget": the type, and the brief/config/sources (defaults when absent). */
    widget: z
      .strictObject({
        type: HubWidgetTypeKeySchema,
        brief: HubBriefSchema.optional(),
        config: widgetConfigInput.optional(),
        sources: z.array(IdentityId).max(HUB_SOURCES_MAX).optional(),
      })
      .optional(),
  }),
  ...v3.commands,
  z.strictObject({
    ...v3.profile,
    type: z.literal("setView"),
    itemId: IdentityId,
    view: HubWidgetViewSchema,
  }),
  /** A typed widget's request, settings or sources; the next fill starts over. */
  z.strictObject({
    ...v3.profile,
    type: z.literal("setWidget"),
    itemId: IdentityId,
    brief: HubBriefSchema.optional(),
    config: widgetConfigInput.optional(),
    sources: z.array(IdentityId).max(HUB_SOURCES_MAX).optional(),
  }),
  z.strictObject({
    ...v3.profile,
    type: z.literal("layout"),
    items: z
      .array(z.strictObject({ itemId: IdentityId, layout: HubLayoutSchema }))
      .max(HUB_ITEM_LIMIT),
  }),
]);
export type HubDashboardV3Command = z.infer<typeof HubDashboardV3CommandSchema>;
/** Any profile's command; the answer comes in the command's own profile. */
export const HubCommandAnySchema = z.union([
  HubCommandSchema,
  HubDashboardCommandSchema,
  HubDashboardV3CommandSchema,
]);

/*
 * Opening one item of an AI widget in full (`POST /v1/:ws/hub/open`): the
 * widget's row names the message by the id the source gave it (`ref`); the
 * server reads that one message under the person's authority and extracts
 * its content deterministically. The model only finds the read; it never
 * rewrites the content. Nothing is stored.
 */
export const HUB_ITEM_REF_MAX = 400;
export const HUB_ITEM_TEXT_MAX = 20_000;
export const HubOpenRequestSchema = z.strictObject({
  itemId: IdentityId,
  ref: z.string().min(1).max(HUB_ITEM_REF_MAX),
});
export type HubOpenRequest = z.infer<typeof HubOpenRequestSchema>;
/**
 * An HTML body as a bounded, sanitized tree the page renders itself (never
 * as HTML): only these tags, only these attributes, only web and mail links,
 * images over https. Depth, node count and size are bounded on the server.
 */
export const HUB_DOC_TAGS = [
  "p",
  "br",
  "hr",
  "a",
  "strong",
  "em",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "img",
  "div",
  "span",
] as const;
export const HUB_DOC_LIMITS = Object.freeze({
  depth: 20,
  nodes: 5_000,
  bytes: 200_000,
  text: 4_000,
});
const span = z.number().int().min(1).max(20);
export type HubDocNode =
  | { t: "text"; v: string }
  | {
      t: "el";
      tag: (typeof HUB_DOC_TAGS)[number];
      href?: string;
      src?: string;
      alt?: string;
      colspan?: number;
      rowspan?: number;
      children?: HubDocNode[];
    };
export const HubDocNodeSchema: z.ZodType<HubDocNode> = z.lazy(() =>
  z.union([
    z.strictObject({
      t: z.literal("text"),
      v: z.string().max(HUB_DOC_LIMITS.text),
    }),
    z.strictObject({
      t: z.literal("el"),
      tag: z.enum(HUB_DOC_TAGS),
      href: z
        .string()
        .max(2000)
        .regex(/^(?:https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/i)
        .optional(),
      src: z
        .string()
        .max(2000)
        .regex(/^https:\/\/[^\s"'<>]+$/i)
        .optional(),
      alt: z.string().max(300).optional(),
      colspan: span.optional(),
      rowspan: span.optional(),
      children: z.array(HubDocNodeSchema).optional(),
    }),
  ]),
);
export const HubItemDetailSchema = z.strictObject({
  subject: z.string().max(1000),
  from: z.string().max(400),
  to: z.array(z.string().min(1).max(400)).max(10).optional(),
  at: iso.optional(),
  /** Plain text, never HTML. */
  text: z.string().max(HUB_ITEM_TEXT_MAX),
  /** The HTML body as a sanitized tree; absent for a plain-text message. */
  doc: z.array(HubDocNodeSchema).max(HUB_DOC_LIMITS.nodes).optional(),
  truncated: z.literal(true).optional(),
  link: z
    .string()
    .max(500)
    .regex(/^https?:\/\/[^\s"'<>]+$/i)
    .optional(),
});
export type HubItemDetail = z.infer<typeof HubItemDetailSchema>;
/** The open's answer: the detail, and whether it came from the server's index. */
export const HubOpenResultSchema = HubItemDetailSchema.extend({
  cached: z.boolean(),
});
export type HubOpenResult = z.infer<typeof HubOpenResultSchema>;
