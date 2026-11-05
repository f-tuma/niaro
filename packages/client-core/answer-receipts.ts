import type {
  AnswerReceipt,
  AnswerReceiptPage,
  ReceiptItem,
} from "../protocol/answer-receipts";
import type { TranslationKey } from "../i18n";

type Translate = (key: TranslationKey) => string;

/**
 * The quiet line under an answer (NIAR-296), the same on the web and the
 * phone: counts of what the answer read, changed and had in context, then
 * the model that wrote it by the administrator's name. It is built only
 * from the server's receipt; nothing here reads the answer's text.
 */
export function receiptsByCommand(page: AnswerReceiptPage | null | undefined) {
  return new Map(
    (page?.receipts ?? []).map((receipt) => [receipt.commandId, receipt]),
  );
}

const SECTIONS = [
  ["read", "receiptRead"],
  ["changed", "receiptChanged"],
  ["memories", "receiptMemories"],
  ["skills", "receiptSkills"],
  ["meetings", "receiptMeetings"],
  ["files", "receiptFiles"],
] as const satisfies readonly (readonly [
  keyof AnswerReceipt,
  TranslationKey,
])[];

/** Whether the receipt has anything to show; an empty one shows no line. */
export function receiptVisible(receipt: AnswerReceipt | undefined) {
  return (
    !!receipt &&
    (!!receipt.model ||
      !!receipt.preset ||
      SECTIONS.some(([key]) => receipt[key].length > 0))
  );
}

/** "Fast · GPT Luna, fallback model": the preset, the model and why it served. */
export function receiptModelText(receipt: AnswerReceipt, tr: Translate) {
  const reason =
    receipt.model?.reason === "fallback"
      ? tr("receiptFallback")
      : receipt.model?.reason === "escalation"
        ? tr("receiptEscalation")
        : undefined;
  const model = receipt.model
    ? [receipt.model.name, reason].filter(Boolean).join(", ")
    : undefined;
  return [receipt.preset?.name, model].filter(Boolean).join(" · ");
}

/** The one muted line: "Read 2 · Memories 3 · Answered by GPT Luna". */
export function receiptLine(receipt: AnswerReceipt, tr: Translate) {
  const counts = SECTIONS.flatMap(([key, label]) =>
    receipt[key].length ? [`${tr(label)} ${receipt[key].length}`] : [],
  );
  const model = receiptModelText(receipt, tr);
  return [...counts, ...(model ? [`${tr("receiptModel")} ${model}`] : [])].join(
    " · ",
  );
}

const itemText = (item: ReceiptItem) =>
  item.detail ? `${item.title} (${item.detail})` : item.title;

/** The expanded details: one titled list per kind, in the line's order. */
export function receiptSections(receipt: AnswerReceipt, tr: Translate) {
  const sections = SECTIONS.flatMap(([key, label]) =>
    receipt[key].length
      ? [
          {
            key: key as string,
            title: tr(label),
            items: receipt[key].map((item) => ({
              id: `${item.kind}:${item.id}`,
              text: itemText(item),
            })),
          },
        ]
      : [],
  );
  const model = receiptModelText(receipt, tr);
  return model
    ? [
        ...sections,
        {
          key: "model",
          title: tr("receiptModel"),
          items: [{ id: "model", text: model }],
        },
      ]
    : sections;
}
