import { z } from "zod";
import { defineWidget, widgetCount } from "./define";

/**
 * What waits for the person across chats: approvals and questions. Built in
 * and filled by the app from the chat session it already has; no AI.
 */
export const approvalsWidget = defineWidget({
  type: "approvals",
  version: 1,
  fill: "client",
  name: { cs: "Čeká na mě", en: "Waiting for me" },
  description: {
    cs: "Schválení a otázky ze všech chatů na jednom místě.",
    en: "Approvals and questions from every chat in one place.",
  },
  data: z.strictObject({}),
  config: z.strictObject({ count: widgetCount(12) }),
  defaultConfig: { count: 6 },
  size: { w: 4, h: 3, minW: 3, minH: 2 },
  refresh: "on_open",
  sample: () => ({}),
});
