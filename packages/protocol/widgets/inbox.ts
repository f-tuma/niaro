import { z } from "zod";
import {
  defineWidget,
  widgetCount,
  widgetDateTime,
  widgetLine,
  widgetLink,
  widgetSource,
  widgetText,
} from "./define";

export const inboxWidget = defineWidget({
  type: "inbox",
  version: 1,
  fill: "ai",
  name: { cs: "Pošta", en: "Inbox" },
  description: {
    cs: "Výtah důležitých e-mailů a co s nimi udělat.",
    en: "The important emails and what to do with them.",
  },
  data: z.strictObject({
    emails: z
      .array(
        z.strictObject({
          /** The message's id at the source, verbatim; opens it later. */
          id: widgetText(400).optional(),
          from: widgetLine(160),
          subject: widgetText(300),
          receivedAt: widgetDateTime,
          /** One line: what it is about. */
          summary: widgetText(400),
          importance: z.enum(["high", "normal", "low"]),
          suggestedAction: widgetText(160).optional(),
          /** Not read yet, when the source says. */
          unreadFlag: z.boolean().optional(),
          /** Messages in its thread, when more than one. */
          threadCount: z.number().int().min(1).max(999).optional(),
          source: widgetSource.optional(),
          link: widgetLink.optional(),
        }),
      )
      .max(15),
    /** Unread messages in total, when the source says. */
    unread: z.number().int().min(0).max(1_000_000).optional(),
  }),
  config: z.strictObject({
    count: widgetCount(12),
    /** Only what needs the person's attention. */
    importantOnly: z.boolean(),
  }),
  defaultConfig: { count: 6, importantOnly: true },
  size: { w: 6, h: 4, minW: 3, minH: 3 },
  refresh: "hourly",
  brief: {
    cs: "Důležité e-maily, na které mám reagovat: kdo píše, o co jde a co doporučuješ udělat.",
    en: "Important emails I should react to: who wrote, what it is about and what you suggest I do.",
  },
  guide:
    "Read recent messages from the person's mailbox. importance is high when someone waits for the person's answer or a decision, low for newsletters and notifications. summary is one short line in the person's language; suggestedAction a short imperative (e.g. 'Reply with the price'). unreadFlag is true for a message the person has not read yet; threadCount is the number of messages in its thread when there are several. id is the message id exactly as the source returned it (needed to open the message later). Never copy whole message bodies.",
  describeConfig: (config) =>
    `At most ${config.count} emails, newest first.` +
    (config.importantOnly
      ? " Only messages that need the person's attention."
      : " Recent messages, important ones marked."),
  sample: (language) => {
    const hour = (back: number) =>
      new Date(Date.now() - back * 3_600_000).toISOString();
    return language === "cs"
      ? {
          emails: [
            {
              id: "AAMkAGE1-sample-1",
              from: "Jana Nováková",
              subject: "Cenová nabídka – potvrzení",
              receivedAt: hour(1),
              summary: "Čeká na potvrzení ceny do pátku.",
              importance: "high" as const,
              suggestedAction: "Potvrdit cenu",
              unreadFlag: true,
            },
            {
              id: "AAMkAGE1-sample-2",
              from: "Petr Svoboda",
              subject: "Schůzka příští týden",
              receivedAt: hour(3),
              summary: "Navrhuje úterý nebo středu dopoledne.",
              importance: "normal" as const,
              suggestedAction: "Vybrat termín",
              threadCount: 3,
            },
          ],
          unread: 7,
        }
      : {
          emails: [
            {
              id: "AAMkAGE1-sample-1",
              from: "Jane Smith",
              subject: "Quote – confirmation",
              receivedAt: hour(1),
              summary: "Waits for the price to be confirmed by Friday.",
              importance: "high" as const,
              suggestedAction: "Confirm the price",
              unreadFlag: true,
            },
            {
              id: "AAMkAGE1-sample-2",
              from: "Peter Brown",
              subject: "Meeting next week",
              receivedAt: hour(3),
              summary: "Suggests Tuesday or Wednesday morning.",
              importance: "normal" as const,
              suggestedAction: "Pick a time",
              threadCount: 3,
            },
          ],
          unread: 7,
        };
  },
});
