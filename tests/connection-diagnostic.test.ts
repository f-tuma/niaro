import { z } from "zod";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { ClientSession } from "../packages/client-core/session";
import { connectionDiagnostic } from "../packages/client-core/connection-diagnostic";
import { PROFILE } from "../packages/protocol";
import { credential, authInfo } from "./auth-fixtures";
import { refreshCredential } from "../packages/client-core/auth";
import { DEVICE_SESSION_PROFILE } from "../packages/protocol";

const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
function fixture(read: typeof fetch, outputs = false) {
  const storage = { getItem: async () => null, setItem: async () => {} };
  return new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    async (url, init) =>
      String(url).endsWith("/auth/session")
        ? response(authInfo())
        : read(url, init),
    undefined,
    undefined,
    false,
    { processOutputs: outputs },
  );
}
test("snapshot profile mismatch reports exact bounded versions and clears on successful recovery", async () => {
  const engine = new FixtureEngine();
  let compatible = false;
  const s = fixture(async () =>
    response(
      compatible
        ? engine.snapshot()
        : { ...engine.snapshot(), profile: "agent-client/0.6-fixture" },
    ),
  );
  try {
    await s.start(false);
    expect(s.getSnapshot()).toMatchObject({
      status: "offline",
      error: "connection_failed",
      connectionDiagnostic: {
        phase: "snapshot",
        reason: "protocol",
        httpStatus: 200,
        expectedProfile: PROFILE,
        receivedProfile: "agent-client/0.6-fixture",
      },
    });
    compatible = true;
    await s.refresh();
    expect(s.getSnapshot().status).toBe("online");
    expect(s.getSnapshot().connectionDiagnostic).toBeUndefined();
  } finally {
    s.stop();
  }
});
test("a non-JSON proxy failure retains its HTTP status without its body", async () => {
  const s = fixture(
    async () =>
      ({
        ok: false,
        status: 502,
        text: async () => "<html>PRIVATE proxy diagnostics</html>",
      }) as Response,
  );
  try {
    await s.start(false);
    expect(s.getSnapshot().connectionDiagnostic).toEqual({
      phase: "snapshot",
      reason: "http",
      httpStatus: 502,
    });
    expect(JSON.stringify(s.getSnapshot())).not.toContain("PRIVATE");
  } finally {
    s.stop();
  }
});
test("capability HTTP failure identifies its phase; unsupported optional capabilities do not block data", async () => {
  const engine = new FixtureEngine();
  let status = 503;
  const s = fixture(
    async (url) =>
      String(url).includes("output/capabilities")
        ? response({ error: "PRIVATE" }, status)
        : response(engine.snapshot()),
    true,
  );
  try {
    await s.start(false);
    expect(s.getSnapshot().connectionDiagnostic).toEqual({
      phase: "capabilities",
      reason: "http",
      httpStatus: 503,
    });
    status = 404;
    await s.refresh();
    expect(s.getSnapshot().status).toBe("online");
    expect(s.getSnapshot().connectionDiagnostic).toBeUndefined();
  } finally {
    s.stop();
  }
});
test("network failures preserve the authenticated session and name the failing data phase", async () => {
  const s = fixture(async () => {
    throw new TypeError("Network request failed");
  });
  try {
    await s.start(false);
    expect(s.getSnapshot()).toMatchObject({
      status: "offline",
      error: "connection_failed",
      connectionDiagnostic: { phase: "snapshot", reason: "network" },
    });
    expect(JSON.stringify(s.getSnapshot())).not.toContain("PRIVATE");
  } finally {
    s.stop();
  }
});
test("authentication HTTP failures preserve their status instead of claiming the network is unreachable", async () => {
  const s = new ClientSession(
    "https://fixture/v1/a",
    { getItem: async () => null, setItem: async () => {} },
    credential(),
    async () => response({ error: "PRIVATE upstream" }, 503),
  );
  try {
    await s.start(false);
    expect(s.getSnapshot().connectionDiagnostic).toEqual({
      phase: "authentication",
      reason: "http",
      httpStatus: 503,
    });
    expect(s.getSnapshot().status).toBe("offline");
    expect(JSON.stringify(s.getSnapshot())).not.toContain("PRIVATE");
  } finally {
    s.stop();
  }
});
test.each([429, 500, 503])(
  "transient renewal HTTP %i preserves the device grant and reports an HTTP failure",
  async (status) => {
    const c = {
      ...credential(),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      refresh: {
        profile: DEVICE_SESSION_PROFILE,
        token: "R".repeat(43),
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    const invalidated = jest.fn();
    const address = "https://fixture/v1/a";
    const s = new ClientSession(
      address,
      { getItem: async () => null, setItem: async () => {} },
      c,
      async () => response(authInfo(c)),
      invalidated,
      (current) =>
        refreshCredential(address, current, "TEST-refresh-request", async () =>
          response({ error: "PRIVATE upstream" }, status),
        ),
    );
    try {
      await s.start(false);
      expect(s.getSnapshot().status).toBe("offline");
      expect(s.getSnapshot().connectionDiagnostic).toEqual({
        phase: "authentication",
        reason: "http",
        httpStatus: status,
      });
      expect(invalidated).not.toHaveBeenCalled();
    } finally {
      s.stop();
    }
  },
);
test("schema diagnostics do not echo private map keys, messages, response values or unknown profiles", () => {
  const result = z
    .object({
      conversations: z.record(
        z.string(),
        z.object({ messages: z.array(z.object({ text: z.string() })) }),
      ),
    })
    .safeParse({
      conversations: { "PRIVATE person": { messages: [{ text: 123 }] } },
    });
  if (result.success) throw Error("Expected malformed fixture");
  const diagnostic = connectionDiagnostic(result.error, "snapshot", 200, {
    profile: "PRIVATE token",
  });
  expect(diagnostic).toMatchObject({
    reason: "schema",
    fields: ["conversations.[item].messages.[].text"],
  });
  expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
});
test("unknown exceptions are not presented as a proven network or version failure", () => {
  const d = connectionDiagnostic(
    new Error("PRIVATE local exception"),
    "snapshot",
  );
  expect(d).toEqual({ phase: "snapshot", reason: "unknown" });
  expect(JSON.stringify(d)).not.toContain("PRIVATE");
});
