// Isolated synthetic fixture: real SQLite/native checkpoints and actual process death.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ProcessAnswerBinding,
  ProcessQuestion,
} from "../../packages/protocol/process-questions";
import {
  JournalSchema,
  type Journal,
} from "../../apps/server-identity/service-process-journal";
import { questionFixture, askQuestion } from "./process-questions-runtime";
import { signal } from "./service-process-runtime";

export type QuestionCrashMode =
  | "issued"
  | "suspended"
  | "repending"
  | "bound"
  | "published"
  | "output"
  | "terminal";
type Fixture = ReturnType<typeof questionFixture>;
export type QuestionCrashManifest = {
  mode: QuestionCrashMode;
  site: string;
  ids: Fixture["ids"];
  admission: ReturnType<Fixture["admit"]>["admission"];
  question: ProcessQuestion;
  binding?: ProcessAnswerBinding;
  journal: Journal;
  attemptedJournal?: Journal;
  modelCalls: number;
  responseReturned: false;
};

const directory = process.argv[2];
const mode = process.argv[3] as QuestionCrashMode;
if (
  !directory ||
  ![
    "issued",
    "suspended",
    "repending",
    "bound",
    "published",
    "output",
    "terminal",
  ].includes(mode)
)
  throw Error("TEST question crash arguments invalid");

let h: Fixture;
let admission: QuestionCrashManifest["admission"] | undefined;
let issued: ProcessQuestion | undefined;
let binding: ProcessAnswerBinding | undefined;
const kill = (site: string, attemptedJournal?: Journal): never => {
  assert(admission);
  const journal = h.journal(admission.parentRunId);
  const question =
    (attemptedJournal?.pending && "kind" in attemptedJournal.pending
      ? attemptedJournal.pending
      : undefined) ??
    binding?.question ??
    issued;
  assert(question);
  const manifest: QuestionCrashManifest = {
    mode,
    site,
    ids: h.ids,
    admission,
    question,
    ...(binding ? { binding } : {}),
    journal,
    ...(attemptedJournal ? { attemptedJournal } : {}),
    modelCalls: h.models().length,
    responseReturned: false,
  };
  writeFileSync(join(directory!, "cut.json"), JSON.stringify(manifest));
  process.kill(process.pid, "SIGKILL");
  throw Error("TEST SIGKILL failed");
};

h = questionFixture(join(directory, "identity.sqlite"), undefined, (store) => ({
  issue: (question) => {
    const saved = store.issue(question);
    issued = saved;
    if (mode === "issued") kill("issued-before-pending-save");
    return saved;
  },
  question: (id) => store.question(id),
  answer: (id) => store.answer(id),
  consumed: (id, question) => store.consumed(id, question),
  consume: (id, question, commit) => store.consume(id, question, commit),
}));
const saveTurn = h.catalog.saveTurn.bind(h.catalog);
h.catalog.saveTurn = (id, workspaceId, userId, value) => {
  const journal = JournalSchema.parse(value);
  const child = Object.values(journal.agents)[0];
  // invoke() saves child+parent pending before native suspend. The reachable
  // later gap is actual native suspension before parent waiting publication.
  if (mode === "suspended" && journal.status === "waiting")
    kill("native-suspended-before-parent-waiting-save", journal);
  if (
    mode === "repending" &&
    journal.status === "waiting" &&
    journal.pending &&
    "kind" in journal.pending &&
    journal.pending.questionRevision === 2
  )
    kill("native-B-suspended-before-parent-waiting-save", journal);
  if (mode === "terminal" && journal.status === "succeeded")
    kill("native-terminal-before-parent-terminal-save", journal);
  saveTurn(id, workspaceId, userId, value);
  if (
    mode === "published" &&
    journal.status === "waiting" &&
    journal.pending &&
    "kind" in journal.pending &&
    journal.pending.questionRevision === 2
  )
    kill("question-B-published-before-response", journal);
  if (mode === "output" && journal.status === "running" && child?.output)
    kill("child-output-saved-before-native-retirement", journal);
};

void (async () => {
  admission = h.admit().admission;
  let calls = 0;
  h.onModel(() =>
    ++calls === 1
      ? askQuestion()
      : mode === "published" || mode === "repending"
        ? askQuestion("TEST question B?")
        : { content: '{"result":"TEST crash-cut done"}' },
  );
  const waiting = await h.runtime.start(
    admission.processId,
    admission.runId,
    admission.input,
    signal(),
  );
  assert(waiting.question, JSON.stringify(waiting));
  binding = h.bind(
    waiting.question,
    "TEST-answer-A",
    "  TEST exact durable answer A\n",
  ).binding;
  if (mode === "bound") kill("immutable-answer-bound-before-native-resume");
  await h.runtime.resume(admission.runId, h.resume(binding), signal());
  throw Error("TEST intended question cut was not reached");
})().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
