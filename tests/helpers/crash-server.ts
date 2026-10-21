// Separate process, real HTTP/SQLite, test-only crash injection. Never imported by the app.
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../../apps/fixture-server/http";
import { loadCalendarConfig } from "../../apps/fixture-server/calendar";

const server = createFixtureServer(process.env.TEST_DATA_DIR!, undefined, {
  now: () => Number(process.env.TEST_NOW),
  calendar: process.env.TEST_CALENDAR_CONFIG
    ? loadCalendarConfig(process.env.TEST_CALENDAR_CONFIG)
    : undefined,
  calendarTransport: async (url, options) => {
    const response = await fetch(url, options);
    if (
      process.env.TEST_CRASH_AFTER_PUT === "1" &&
      options?.method === "PUT" &&
      response.status === 201
    )
      process.kill(process.pid, "SIGKILL");
    return response;
  },
  checkpoint: (stage, change) => {
    if (
      stage === process.env.TEST_CRASH_STAGE &&
      change === process.env.TEST_CRASH_CHANGE
    )
      process.kill(process.pid, "SIGKILL");
  },
});
server.listen(0, "127.0.0.1", () => {
  process.send?.({ port: (server.address() as AddressInfo).port });
});
process.on("SIGTERM", () => server.close(() => process.disconnect?.()));
