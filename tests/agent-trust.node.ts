import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateTrust } from "./agent-trust/runner";
import { trustScenarios } from "./agent-trust/scenarios";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("trust report records failures and gaps distinctly and continues independent scenarios", async () => {
  const report = await evaluateTrust([
    {
      id: "broken",
      title: "Broken assertion",
      run: async (p) => {
        await p.check("effect", "No duplicate effect", () =>
          assert.equal(2, 1),
        );
      },
    },
    {
      id: "gap",
      title: "Missing capability",
      run: async (p) => {
        p.gap("capability", "Unimplemented behavior", { available: false });
      },
    },
    {
      id: "pass",
      title: "Passing behavior",
      run: async (p) => {
        await p.check("effect", "One effect", () => assert.equal(1, 1));
        p.observe("effects", 1);
      },
    },
  ]);
  assert.equal(report.verdict, "failed");
  assert.deepEqual(report.summary, {
    scenarios: 3,
    passed: 1,
    failed: 1,
    gaps: 1,
    checks: 3,
  });
  assert.equal(report.scenarios[0]!.checks[0]!.status, "failed");
  assert.equal(report.scenarios[2]!.observations.effects, 1);
  const incomplete = await evaluateTrust([
    {
      id: "gap",
      title: "Known gap",
      run: async (p) => {
        p.gap("gap", "Not supported", false);
      },
    },
  ]);
  assert.equal(incomplete.verdict, "incomplete");
  await assert.rejects(evaluateTrust([]), /No scenarios/);
  await assert.rejects(
    evaluateTrust([trustScenarios[0]!, trustScenarios[0]!]),
    /Duplicate scenario/,
  );
});

test("trust runner times out a stalled scenario, releases its resources and continues", async () => {
  let released = false,
    signal: AbortSignal | undefined;
  const report = await evaluateTrust(
    [
      {
        id: "stalled",
        title: "Stalled request",
        run: async (p) => {
          signal = p.signal;
          p.defer(() => {
            released = true;
          });
          await new Promise<void>(() => {});
        },
      },
      {
        id: "next",
        title: "Next request",
        run: async (p) => {
          await p.check("released", "The earlier resources were released", () =>
            assert(released),
          );
        },
      },
    ],
    undefined,
    { timeoutMs: 25 },
  );
  assert.equal(signal?.aborted, true);
  assert.equal(report.scenarios[0]!.status, "failed");
  assert.match(
    String(report.scenarios[0]!.checks[0]!.evidence),
    /deadline exceeded/,
  );
  assert.equal(report.scenarios[1]!.status, "passed");
});

for (const scenario of trustScenarios)
  test(`trust scenario: ${scenario.id}`, async () => {
    const report = await evaluateTrust([scenario]);
    assert.equal(
      report.summary.failed,
      0,
      JSON.stringify(report.scenarios, null, 2),
    );
    assert(report.summary.checks > 0);
    assert.equal(report.mode, "scripted-model");
  });

test("trust CLI reports the durable detour scenario as passing and rejects unknown scenarios", () => {
  const directory = mkdtempSync(join(tmpdir(), "trust-cli-"));
  const output = join(directory, "report.json");
  const run = (args: string[]) => {
    const env = { ...process.env };
    // Keep this a standalone CLI; Node otherwise serializes stdout as test events.
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("scripts/evaluate-agent-trust.ts"), ...args],
      { encoding: "utf8", timeout: 15000, env },
    );
  };
  try {
    const incomplete = run([
      "--scenario",
      "loop.topic-detour",
      "--json",
      output,
    ]);
    assert.equal(incomplete.status, 0, incomplete.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.verdict, "passed");
    assert.equal(report.summary.gaps, 0);
    assert.match(incomplete.stdout, /SCRIPTED MODEL/);
    assert.equal(
      run(["--scenario", "loop.topic-detour", "--allow-known-gaps"]).status,
      0,
    );
    assert.equal(run(["--scenario", "missing-scenario"]).status, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
