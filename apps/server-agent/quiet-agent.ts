import type { Agent } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";

/**
 * A standalone agent logs a failed call to the console with the model's whole
 * answer, such as a cut-off calendar with its attendees. Its callers report
 * failures themselves, without content.
 */
export function quiet<T extends Agent>(agent: T): T {
  agent.__setLogger(noopLogger);
  return agent;
}
