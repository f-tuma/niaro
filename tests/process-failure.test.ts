import {
  PROCESS_FAILURES,
  PROCESS_FAILURE_ACTIONS,
  processFailure,
} from "../packages/protocol/process-failure";
import { PROCESS_START_REJECTIONS } from "../packages/protocol/process-start";
import { ProcessExecutionEntrySchema } from "../packages/protocol/process-execution";

const blockedReasons = (
  ProcessExecutionEntrySchema.options[1].shape.reason as {
    options: readonly string[];
  }
).options;

test("every failure code has an English and a Czech sentence and at most one known action", () => {
  for (const [code, entry] of Object.entries(PROCESS_FAILURES)) {
    expect([code, entry.en.trim().length > 0]).toEqual([code, true]);
    expect([code, entry.cs.trim().length > 0]).toEqual([code, true]);
    // Fixed copy, never a template or a provider message.
    expect(entry.en).not.toMatch(/\{|\}/);
    expect(entry.cs).not.toMatch(/\{|\}/);
    expect(entry.en).not.toBe(entry.cs);
    if (entry.action !== null)
      expect(PROCESS_FAILURE_ACTIONS).toContain(entry.action);
  }
});

test("the table covers every blocked reason and every start rejection", () => {
  for (const code of [...blockedReasons, ...PROCESS_START_REJECTIONS])
    expect([code, processFailure(code, "en").known]).toEqual([code, true]);
});

test("a known code reads as its sentence and its one action", () => {
  expect(processFailure("connection_required", "en")).toEqual({
    code: "connection_required",
    known: true,
    sentence: "A service it uses needs you to sign in.",
    action: "sign_in",
  });
  expect(processFailure("process_step_limit", "cs")).toMatchObject({
    sentence: "Potřeboval víc kroků, než mu limity dovolí.",
    action: "edit",
  });
  expect(processFailure("source_changed", "en").action).toBe("retest");
  // An unconfirmed write is never answered with "run it again".
  expect(processFailure("process_action_unknown", "en").action).toBeNull();
});

test("an unknown code reads as a generic line naming it, with no action", () => {
  expect(processFailure("crm_quota_hit", "en")).toEqual({
    code: "crm_quota_hit",
    known: false,
    sentence: "It stopped with code crm_quota_hit.",
    action: null,
  });
  expect(processFailure("crm_quota_hit", "cs").sentence).toBe(
    "Zastavil se s kódem crm_quota_hit.",
  );
  // Anything that is not a short code is never echoed.
  expect(processFailure("Bearer secret value", "en").sentence).toBe(
    "It stopped with code unknown.",
  );
  // Inherited names are not table entries.
  expect(processFailure("constructor", "en").known).toBe(false);
});
