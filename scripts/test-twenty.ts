import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  loadTwentyConfig,
  TwentyTestDirectory,
} from "../apps/fixture-server/twenty";
import { limitedJson } from "../apps/fixture-server/openrouter";

// Explicit provisioning command, deliberately separate from the read-only runtime adapter.
// No PATCH/PUT/DELETE/upsert. Never retries a POST, even after an uncertain response.
async function main() {
  const file = process.env.TWENTY_CONFIG ?? ".twenty/config.json";
  const config = loadTwentyConfig(file);
  const directory = new TwentyTestDirectory(config);
  const firstName = "TEST Agent Client";
  const lastName = "2026-09-24";
  let records = await directory.list();
  let matches = records.filter(
    (p) => p.name.firstName === firstName && p.name.lastName === lastName,
  );
  if (!matches.length && process.argv.includes("--create-test")) {
    if (Date.now() >= Date.parse(config.expiresAt))
      throw Error("twenty_expired");
    const response = await fetch(new URL("/rest/people", config.baseUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: { firstName, lastName },
        jobTitle: "TEST: synthetic assistant integration check",
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("test_person_create_failed_check_before_retry");
    }
    await limitedJson(response, 1024 * 1024);
    records = await directory.list();
    matches = records.filter(
      (p) => p.name.firstName === firstName && p.name.lastName === lastName,
    );
  }
  const result = {
    origin: config.baseUrl,
    checkedAt: new Date().toISOString(),
    testRecords: records.length,
    matchingTestRecords: matches.map((p) => ({
      id: p.id,
      name: `${p.name.firstName} ${p.name.lastName}`,
    })),
    existingRecordsModified: false,
  };
  writeFileSync(
    join(dirname(file), "test-result.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
  if (process.argv.includes("--create-test") && matches.length !== 1)
    throw Error("test_person_verification_failed");
}
main().catch(() => {
  console.error(
    "Twenty check failed. No existing record was changed; inspect the TEST record before any retry.",
  );
  process.exitCode = 1;
});
