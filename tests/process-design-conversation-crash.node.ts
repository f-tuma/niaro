import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ProcessDesignConversation } from "../apps/server-identity/process-design-conversation";
import { designConversationFixture } from "./helpers/process-design-conversation";

const worker = fileURLToPath(
  new URL(
    "./helpers/process-design-conversation-crash-worker.ts",
    import.meta.url,
  ),
);
const sites = {
  created: "durable-turn-before-native-start",
  tool: "proposal-and-receipt-committed-before-native-ack",
  usage: "provider-response-before-budget-settlement",
  candidate: "staged-reply-before-native-retirement",
  retired: "native-retired-before-domain-publication",
};
type Mode = keyof typeof sites;
async function cut(directory: string, mode: Mode) {
  return new Promise<{ signal: NodeJS.Signals | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", worker, directory, mode],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("TEST crash worker timed out: " + stderr));
      }, 20000);
      child.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.on("close", (_code, signal) => {
        clearTimeout(deadline);
        resolve({ signal, stderr });
      });
    },
  );
}
for (const mode of Object.keys(sites) as Mode[]) {
  test(`SIGKILL at design ${mode} cut preserves exact passive outcome across two restarts`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "niaro-design-cut-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const killed = await cut(directory, mode);
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    assert(
      existsSync(join(directory, "cut.json")),
      "Must reach the intended crash cut",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "cut.json"), "utf8")),
      { mode, site: sites[mode] },
    );
    const command = JSON.parse(
      readFileSync(join(directory, "command.json"), "utf8"),
    );
    const h = designConversationFixture(join(directory, "identity.sqlite"), {
      reuseConfiguration: true,
    });
    h.onModel(() => {
      throw Error("TEST passive replay must not dispatch inference");
    });
    try {
      const originalCalls = h.modelCount();
      const expectedCalls =
        mode === "created" ? 0 : mode === "tool" || mode === "usage" ? 1 : 2;
      assert.equal(originalCalls, expectedCalls);
      const expectedRevision = ["tool", "candidate", "retired"].includes(mode)
        ? 2
        : 1;
      let previous;
      for (let restart = 0; restart < 2; restart++) {
        if (restart) await h.reopen();
        const conversation = new ProcessDesignConversation(
          h.db,
          h.store,
          h.registry,
          h.controller,
          h.plugins,
          { serverId: h.scope.serverId },
        );
        const passive = await conversation.get(h.context, {
          ...h.target,
          sessionId: command.sessionId,
          requestId: command.requestId,
        });
        assert.equal(
          passive.status,
          mode === "retired" ? "completed" : "interrupted",
        );
        assert.equal(
          passive.reply,
          mode === "retired" ? "TEST durable assistant reply" : null,
        );
        assert.equal(passive.userText, "TEST durable original message");
        if (previous) assert.deepEqual(passive, previous);
        previous = passive;
        assert.deepEqual(
          await conversation.message(
            h.context,
            command,
            new AbortController().signal,
          ),
          passive,
        );
        assert.equal(
          h.store.get(h.actor, command.sessionId).revision,
          expectedRevision,
        );
        assert.equal(h.modelCount(), originalCalls);
        assert.equal(h.serviceCount(), 0);
        const roots = h.db.prepare("SELECT id FROM agent_inference_run").all();
        assert.equal(roots.length, 1);
        const budget = h.catalog.inferenceBudget.summary(String(roots[0]!.id));
        assert.equal(budget.unknownCalls, mode === "usage" ? 1 : 0);
        assert.equal(
          h.db
            .prepare("SELECT COUNT(*) AS n FROM agent_process_design_tool")
            .get()!.n,
          expectedRevision - 1,
        );
      }
      if (mode === "created") {
        h.onModel(() => ({
          content: "TEST recovered after pre-execution crash",
        }));
        const next = await new ProcessDesignConversation(
          h.db,
          h.store,
          h.registry,
          h.controller,
          h.plugins,
          { serverId: h.scope.serverId },
        ).message(
          h.context,
          {
            ...command,
            requestId: "TEST-after-pre-execution-crash",
            text: "TEST fresh work after reservation-only crash",
          },
          new AbortController().signal,
        );
        assert.equal(next.status, "completed");
        assert.equal(h.modelCount(), 1);
      }
      if (mode === "usage") {
        // The unknown attempt keeps its full reservation instead of blocking
        // the conversation's budget; only the unproved native run keeps new
        // work busy, and nothing is resent.
        const root = String(
          h.db.prepare("SELECT id FROM agent_inference_run").get()!.id,
        );
        const held = h.catalog.inferenceBudget.summary(root);
        assert.equal(held.unknownCalls, 1);
        // Its charge is exactly its reservation: the request's own estimate
        // plus the output ceiling.
        const reserved = h.db
          .prepare(
            "SELECT reserved_tokens FROM agent_inference_attempt WHERE run_id=? AND status='unknown'",
          )
          .get(root)!.reserved_tokens;
        assert(Number(reserved) > 0);
        assert.equal(held.accountedTokens, Number(reserved));
        await assert.rejects(
          () =>
            new ProcessDesignConversation(
              h.db,
              h.store,
              h.registry,
              h.controller,
              h.plugins,
              { serverId: h.scope.serverId },
            ).message(
              h.context,
              {
                ...command,
                requestId: "TEST-explicit-new",
                text: "TEST next explicit work",
              },
              new AbortController().signal,
            ),
          /process_design_busy/,
        );
        assert.equal(h.modelCount(), originalCalls);
        assert.deepEqual(h.catalog.inferenceBudget.summary(root), held);
        assert.equal(
          h.db.prepare("SELECT COUNT(*) AS n FROM agent_inference_run").get()!
            .n,
          1,
        );
      }
    } finally {
      await h.close();
    }
  });
}
