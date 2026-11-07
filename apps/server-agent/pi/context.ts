import {
  BACKGROUND_CONTEXT,
  type Context,
} from "@earendil-works/chord/context";

/** The context of the agent core's own calls: not tied to a request. */
export const ctx: Context = BACKGROUND_CONTEXT;
