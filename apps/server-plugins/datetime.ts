import {
  DateTimeInput,
  TimeZone,
  type PluginResult,
} from "../../packages/protocol/internal-plugins";
import { resolveDateTime as calculate } from "../../plugins/datetime/index";
export {
  DateTimeInput,
  TimeZone,
  PluginResultSchema,
  type PluginResult,
} from "../../packages/protocol/internal-plugins";
export type PluginClock = { referenceNow: string; timeZone: string };
/** The device's zone when it is a real IANA zone, otherwise the server's default. */
export function localZone(device: string | undefined, fallback: string) {
  return device && TimeZone.safeParse(device).success ? device : fallback;
}
/** The turn's clock with where its timezone came from, for the operator to verify. */
export function turnClock(device: string | undefined, fallback: string) {
  const zone = localZone(device, fallback);
  return {
    referenceNow: new Date().toISOString(),
    timeZone: zone,
    source: zone === device ? ("device" as const) : ("server" as const),
  };
}

/**
 * The built-in calendar arithmetic of the date & time plugin, for server
 * features that calculate dates without the agent (meeting notes, tests).
 * The agent's tool runs the plugin in force, which an operator may replace.
 */
export function resolveDateTime(
  raw: unknown,
  clock: PluginClock,
): PluginResult {
  return calculate(DateTimeInput.parse(raw), clock);
}
