import { createServer } from "node:http";
import { mobileIntegratedHttpFixture } from "../tests/helpers/process-mobile-integrated-http.ts";

// Synthetic providers, real paired HTTP/native execution. Bootstrap stays loopback-only.
const fixture = await mobileIntegratedHttpFixture();
let preview;
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  if (preview) await new Promise((resolve) => preview.close(resolve));
  await fixture.close();
}
try {
  await fixture.configure();
  await fixture.seedMeeting();
  const pairing = await fixture.issuePairing();
  preview = createServer((request, response) => {
    if (request.url !== "/bootstrap" || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify({ pairing }));
  });
  await new Promise((resolve) => preview.listen(0, "127.0.0.1", resolve));
  const bootstrapPort = preview.address().port;
  const fixturePort = new URL(fixture.origin).port;
  console.log("Isolated Niaro emulator QA; no live provider or CRM requests.");
  for (const port of [bootstrapPort, fixturePort, 8087]) {
    console.log(`adb -s emulator-5554 reverse tcp:${port} tcp:${port}`);
  }
  console.log(
    `EXPO_NO_DOTENV=1 AGENT_CLIENT_DEVELOPMENT=1 EXPO_PUBLIC_ALLOW_INSECURE_FIXTURES=1 NATIVE_JOURNEYS_QA=1 EXPO_PUBLIC_QA_BOOTSTRAP=http://127.0.0.1:${bootstrapPort}/bootstrap pnpm exec expo start --dev-client --localhost --port 8087`,
  );
  console.log(
    "Open exp+agent-client://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8087 in the emulator.",
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
} catch (error) {
  await close();
  throw error;
}
