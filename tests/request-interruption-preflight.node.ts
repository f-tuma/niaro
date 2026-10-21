import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrustHarness } from "./agent-trust/harness";
import { messageCommand } from "../packages/client-core/commands";
import { translate } from "../packages/i18n";

function holdDecision(h: ReturnType<typeof createTrustHarness>) {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const transport = h.controller.transport;
  Object.defineProperty(h.controller, "transport", {
    configurable: true,
    value: async (request: Parameters<typeof transport>[0]) => {
      if (request.url.endsWith("/decisions")) {
        await request.beforeDispatch?.(() => {});
        started();
        await new Promise<never>((_, reject) => {
          const stop = () => reject(request.signal!.reason);
          if (request.signal!.aborted) stop();
          else request.signal!.addEventListener("abort", stop, { once: true });
        });
      }
      return transport(request);
    },
  });
  return ready;
}

for (const prior of ["question", "completed-read"] as const) {
  test(
    `interruption during ${prior} continuity inference settles without another inference`,
    { timeout: 20000 },
    async () => {
      const h = createTrustHarness();
      try {
        h.onChat(
          prior === "question"
            ? () => h.call("ask_user", { question: "TEST which contact?" })
            : h.lookupScript,
        );
        await h.send("TEST prepare prior work", { id: "TEST-preflight-A" });
        const ready = holdDecision(h);
        const command = messageCommand(
          "TEST answer Jane",
          "en",
          "TEST-preflight-B",
        );
        const delivery = h.execute(command);
        void delivery.catch(() => {});
        await ready;
        const ack = await h.model.interrupt(h.scope, command, (fn) =>
          Promise.resolve().then(fn),
        );
        assert.equal(ack.status, "settled");
        const result = await delivery;
        assert.equal(result.status, "accepted");
        assert(
          result.snapshot.conversations[0]!.messages.at(-1)!.text.includes(
            translate(command.language)("requestInterrupted"),
          ),
        );
        const count = h.requests.length,
          network = h.network.length;
        assert.deepEqual(
          (await h.execute(command)).snapshot.conversations,
          result.snapshot.conversations,
        );
        assert.equal(h.requests.length, count);
        assert.equal(h.network.length, network);
        assert.equal(
          h.commandState(command.idempotencyKey).trace?.status,
          "cancelled",
        );
        await h.restart();
        assert.deepEqual(
          (await h.execute(command)).snapshot.conversations,
          result.snapshot.conversations,
        );
        assert.equal(h.network.length, network);
        assert.equal(h.requests.length, count);
      } finally {
        await h.close();
      }
    },
  );
}
