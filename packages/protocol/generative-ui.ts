import { z } from "zod";

/** Clients that render generated UI on assistant messages ask with
 * `ui=agent-openui/1`; the others receive the message text alone. */
export const GENERATIVE_UI_PROFILE = "agent-openui/1" as const;
/**
 * The visual part of an assistant answer: one OpenUI Lang program, already
 * admitted by the server against the shared component library. It is
 * presentation only; it grants no permission and runs nothing on its own.
 */
export const GeneratedUiSchema = z.strictObject({
  type: z.literal("openui.program"),
  version: z.literal(1),
  library: z.literal("niaro-ui@1"),
  program: z.string().min(1).max(16000),
});
export type GeneratedUi = z.infer<typeof GeneratedUiSchema>;
