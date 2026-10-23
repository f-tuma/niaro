import { z } from "zod";

export const CARD_PROFILE = "agent-card/1" as const;
export const CARD_LIMITS = {
  nodes: 64,
  depth: 6,
  actions: 6,
  characters: 32768,
} as const;
export const CardIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,80}$/)
  .refine(
    (id) => id !== "prototype" && !Object.hasOwn(Object.prototype, id),
    "Reserved dictionary key",
  );
const short = z.string().trim().min(1).max(160);
const content = z.string().trim().min(1).max(4000);
export const CardIconSchema = z.enum([
  "check",
  "chevron",
  "close",
  "clock",
  "calendar",
  "person",
  "mail",
  "phone",
  "info",
  "link",
  "edit",
  "search",
  "send",
  "mic",
  "stop",
  "play",
  "pause",
  "volume",
  "settings",
  "plus",
  "refresh",
  "chat",
  "tasks",
  "more",
  "arrow",
  "speaker",
]);
const node = { id: CardIdSchema };
const children = z.array(CardIdSchema).min(1).max(16);
export const CardValueSchema = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
]);
export const CardValuesSchema = z
  .record(CardIdSchema, CardValueSchema)
  .refine((values) => Object.keys(values).length <= 12);
export type CardValues = z.infer<typeof CardValuesSchema>;
export const CardNodeSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...node, type: z.literal("heading"), text: short }),
  z.strictObject({
    ...node,
    type: z.literal("text"),
    text: content,
    tone: z.enum(["primary", "secondary"]).optional(),
  }),
  z.strictObject({
    ...node,
    type: z.literal("field"),
    label: short,
    value: content,
    icon: CardIconSchema.optional(),
  }),
  z.strictObject({
    ...node,
    type: z.literal("badge"),
    label: short,
    tone: z.enum(["neutral", "info", "success", "warning", "danger"]),
  }),
  z.strictObject({
    ...node,
    type: z.literal("notice"),
    text: content,
    tone: z.enum(["info", "warning", "danger"]),
  }),
  z.strictObject({ ...node, type: z.literal("divider") }),
  z.strictObject({
    ...node,
    type: z.literal("section"),
    title: short.optional(),
    icon: CardIconSchema.optional(),
    children,
  }),
  z.strictObject({ ...node, type: z.literal("stack"), children }),
  z.strictObject({
    ...node,
    type: z.literal("columns"),
    children: z.array(CardIdSchema).min(2).max(3),
  }),
  z.strictObject({
    ...node,
    type: z.literal("disclosure"),
    label: short,
    children,
  }),
  z.strictObject({
    ...node,
    type: z.literal("list"),
    items: z
      .array(
        z.strictObject({
          title: short,
          detail: z.string().trim().min(1).max(1000).optional(),
          icon: CardIconSchema.optional(),
        }),
      )
      .min(1)
      .max(12),
  }),
  z.strictObject({
    ...node,
    type: z.literal("code"),
    text: z.string().min(1).max(12000),
    label: short.optional(),
  }),
  z
    .strictObject({
      ...node,
      type: z.literal("progress"),
      label: short,
      value: z.number().int().nonnegative(),
      total: z.number().int().positive(),
    })
    .refine((n) => n.value <= n.total),
  z.strictObject({
    ...node,
    type: z.literal("button"),
    actionId: CardIdSchema,
  }),
  z.strictObject({
    ...node,
    type: z.literal("input"),
    label: short,
    kind: z.enum(["text", "number", "date", "time", "choice", "toggle"]),
    required: z.boolean().optional(),
    placeholder: short.optional(),
    options: z
      .array(z.strictObject({ id: CardIdSchema, label: short }))
      .min(2)
      .max(12)
      .optional(),
    value: CardValueSchema.optional(),
  }),
]);
export type CardNode = z.infer<typeof CardNodeSchema>;
export const CardActionSchema = z.strictObject({
  id: CardIdSchema,
  label: short,
  kind: z.enum(["reply", "submit"]),
  variant: z.enum(["primary", "secondary", "quiet"]),
  icon: CardIconSchema.optional(),
  fields: z.array(CardIdSchema).min(1).max(12).optional(),
});
export type CardAction = z.infer<typeof CardActionSchema>;
export const CardCompositionShape = {
  title: short,
  subtitle: short.optional(),
  icon: CardIconSchema.optional(),
  nodes: z.array(CardNodeSchema).min(1).max(CARD_LIMITS.nodes),
  root: z.array(CardIdSchema).min(1).max(16),
  actions: z.array(CardActionSchema).max(CARD_LIMITS.actions),
};
function validateGraph(
  doc: { nodes: CardNode[]; root: string[]; actions: CardAction[] },
  ctx: z.RefinementCtx,
) {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (JSON.stringify(doc).length > CARD_LIMITS.characters)
    fail("Card exceeds the character budget");
  const nodes = new Map(doc.nodes.map((n) => [n.id, n])),
    actions = new Map(doc.actions.map((a) => [a.id, a]));
  if (nodes.size !== doc.nodes.length || actions.size !== doc.actions.length)
    fail("Card IDs must be unique");
  if (doc.actions.filter((a) => a.variant === "primary").length > 1)
    fail("Use only one primary action");
  const visited = new Set<string>(),
    buttons = new Set<string>(),
    inputs = new Set<string>();
  const visit = (id: string, depth: number, inDisclosure: boolean) => {
    if (depth > CARD_LIMITS.depth) {
      fail("Card nesting is too deep");
      return;
    }
    if (visited.has(id)) {
      fail("Card must be a tree with unique node references");
      return;
    }
    visited.add(id);
    const n = nodes.get(id);
    if (!n) {
      fail("Unknown card node reference");
      return;
    }
    if (n.type === "button") {
      if (inDisclosure) fail("Action buttons must remain visible");
      if (!actions.has(n.actionId) || buttons.has(n.actionId))
        fail("Unknown or repeated card action");
      buttons.add(n.actionId);
    }
    if (n.type === "input") {
      inputs.add(n.id);
      if (inDisclosure) fail("Form inputs must remain visible");
      if ((n.kind === "choice") !== !!n.options)
        fail("Choices require an options list");
      if (
        n.options &&
        new Set(n.options.map((o) => o.id)).size !== n.options.length
      )
        fail("Choice option IDs must be unique");
      if (n.value !== undefined && !cardFieldValueValid(n, n.value, false))
        fail("Invalid initial field value");
    }
    if ("children" in n)
      for (const child of n.children)
        visit(child, depth + 1, inDisclosure || n.type === "disclosure");
  };
  doc.root.forEach((id) => visit(id, 1, false));
  if (visited.size !== nodes.size) fail("Card contains unreachable nodes");
  const ownedInputs = new Set<string>();
  for (const a of doc.actions) {
    if (!buttons.has(a.id)) fail("Card action needs a visible button");
    if ((a.kind === "submit") !== !!a.fields)
      fail("Only submit actions reference form fields");
    if (a.fields) {
      if (new Set(a.fields).size !== a.fields.length)
        fail("Submit field IDs must be unique");
      for (const id of a.fields) {
        if (!inputs.has(id)) fail("Unknown form field");
        ownedInputs.add(id);
      }
    }
  }
  if ([...inputs].some((id) => !ownedInputs.has(id)))
    fail("Form field needs a submit action");
}
export const CardCompositionSchema = z
  .strictObject(CardCompositionShape)
  .superRefine(validateGraph);
export const CardDocumentSchema = z
  .strictObject({
    id: CardIdSchema,
    revision: z.number().int().positive(),
    ...CardCompositionShape,
  })
  .superRefine(validateGraph);
export type CardDocument = z.infer<typeof CardDocumentSchema>;
export const PassiveCardDocumentSchema = CardDocumentSchema.refine(
  (doc) =>
    !doc.actions.length &&
    !doc.nodes.some((n) => n.type === "input" || n.type === "button"),
  "Action and work supplements must be passive",
);
export const CardResultSchema = z.strictObject({
  type: z.literal("card.document"),
  version: z.literal(1),
  document: CardDocumentSchema,
});
export type CardResult = z.infer<typeof CardResultSchema>;
export type CardInput = Extract<CardNode, { type: "input" }>;
/** Form values are user data, not commands or executable properties. */
export function cardFieldValueValid(
  field: CardInput,
  value: unknown,
  enforceRequired = true,
): boolean {
  if (value === undefined || (typeof value === "string" && !value.trim()))
    return !(enforceRequired && field.required);
  if (field.kind === "toggle") return typeof value === "boolean";
  if (field.kind === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (typeof value !== "string" || value.length > 4000) return false;
  if (field.kind === "choice")
    return !!field.options?.some((o) => o.id === value);
  if (field.kind === "date")
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
    );
  if (field.kind === "time") return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  return true;
}
/**
 * The readable content of a stored model-composed card, in reading order:
 * the title, then each heading, text and value. Answers no longer carry
 * cards; history shows this text in place of the old card.
 */
export function cardDocumentText(document: {
  title: string;
  subtitle?: string;
  nodes: CardNode[];
  root: string[];
}): string {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const lines = [document.title, document.subtitle].filter(
    (line): line is string => !!line,
  );
  const seen = new Set<string>();
  const visit = (id: string) => {
    const node = nodes.get(id);
    if (!node || seen.has(id) || lines.length > 200) return;
    seen.add(id);
    switch (node.type) {
      case "heading":
      case "text":
      case "notice":
      case "code":
        lines.push(node.text);
        break;
      case "field":
        lines.push(`${node.label}: ${node.value}`);
        break;
      case "badge":
        lines.push(node.label);
        break;
      case "progress":
        lines.push(`${node.label}: ${node.value}/${node.total}`);
        break;
      case "list":
        for (const item of node.items)
          lines.push(
            item.detail ? `${item.title}: ${item.detail}` : item.title,
          );
        break;
      case "section":
        if (node.title) lines.push(node.title);
        break;
      case "disclosure":
        lines.push(node.label);
        break;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  document.root.forEach(visit);
  return lines.join("\n");
}
