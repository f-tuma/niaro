import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  questionFixture,
  askQuestion,
} from "./helpers/process-questions-runtime";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { signal } from "./helpers/service-process-runtime";

/** A floor call: 2,048 input tokens plus the price's 1,000 output tokens
 * (one micro per token in this fixture, so tokens and cost are equal). */
const FLOOR = 2048 + 1000;

/** Ask a question with unknown usage, so the first call is charged exactly
 * its reservation; `limits` narrows the frozen caps. */
async function asked(root: string, limits: object = {}) {
  const h = questionFixture(join(root, "identity.sqlite"));
  const definition = h.definition();
  const { admission } = h.admit(
    ProcessDefinitionSchema.parse({
      ...definition,
      limits: { ...definition.limits, ...limits },
    }),
  );
  h.setModelUsage(undefined);
  h.onModel(() => askQuestion());
  const waiting = await h.runtime.start(
    admission.processId,
    admission.runId,
    admission.input,
    signal(),
  );
  assert(waiting.question, JSON.stringify(waiting));
  const held = Number(
    h.db
      .prepare(
        "SELECT reserved_tokens FROM agent_inference_attempt WHERE run_id=?",
      )
      .get(admission.parentRunId)!.reserved_tokens,
  );
  return { h, admission, waiting, held };
}

test("a floor-sized next reservation must fit remaining tokens and cost before a question answer is consumed", async () => {
  // The first call's reservation is its own request estimate plus output.
  const calibration = mkdtempSync(join(tmpdir(), "niaro-question-budget-"));
  let held: number;
  try {
    const first = await asked(calibration);
    held = first.held;
    await first.h.close();
  } finally {
    rmSync(calibration, { recursive: true, force: true });
  }
  assert(held > FLOOR && held < 51_000, String(held));
  for (const limit of ["maxTokens", "maxCostMicros"] as const)
    for (const exhausted of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "niaro-question-budget-"));
      // One token or micro short of a floor call after the first hold, or exactly enough.
      const run = await asked(root, {
        [limit]: held + FLOOR - (exhausted ? 1 : 0),
      });
      const { h, admission, waiting } = run;
      try {
        assert.equal(run.held, held);
        const { binding } = h.bind(waiting.question!);
        const before = h.controller.store.inferenceBudget.summary(
          admission.parentRunId,
        );
        assert.equal(before.overrun, false);
        assert.equal(before.calls, 1);
        assert.equal(before.accountedTokens, held);
        let result: Awaited<ReturnType<typeof h.runtime.resume>> | undefined;
        try {
          result = await h.runtime.resume(
            admission.runId,
            h.resume(binding),
            signal(),
          );
          if (exhausted)
            assert.equal(
              result.failure?.code,
              "catalog_budget_exhausted",
              JSON.stringify(result),
            );
        } catch (error) {
          assert(exhausted, String(error));
          assert(
            error instanceof Error &&
              error.message === "catalog_budget_exhausted",
            String(error),
          );
        }
        // Enough room for a floor call: the answer is consumed; the next
        // request then reserves its own size within what remains.
        assert.equal(
          h.questions.consumed(binding.bindingId, waiting.question!),
          !exhausted,
          JSON.stringify(result),
        );
        if (!exhausted) continue;
        assert.equal(
          h.journal(admission.parentRunId).agents.agent?.answers?.length ?? 0,
          0,
        );
        assert.equal(h.models().length, 1);
        assert.deepEqual(h.counts(), []);
        assert.deepEqual(
          h.controller.store.inferenceBudget.summary(admission.parentRunId),
          before,
        );
      } finally {
        await h.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
});
