import { ClientSession } from "../packages/client-core/session";
import { credential } from "./auth-fixtures";

const attemptId = "a".repeat(43);
const serviceId = "test-crm";
const start = () => ({
  serviceId,
  attemptId,
  authorizationUrl: `https://assistant.example/admin/service-connect#${attemptId}`,
  expiresAt: Date.now() + 300_000,
});
function client(value: unknown, address = "https://assistant.example/v1/a") {
  const request = jest.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(value),
      }) as Response,
  );
  const session = new ClientSession(
    address,
    { getItem: async () => null, setItem: async () => {} },
    credential(),
    request,
  );
  return { session, request };
}

test("start only opens an expiring server-owned path for this service and attempt", async () => {
  const value = start(),
    { session, request } = client(value);
  await expect(
    session.serviceConnection("start", serviceId, new AbortController().signal),
  ).resolves.toEqual(value);
  expect(request).toHaveBeenCalledWith(
    "https://assistant.example/v1/a/services/start",
    expect.objectContaining({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      body: JSON.stringify({ serviceId }),
    }),
  );
});

test.each([
  {
    authorizationUrl: `https://other.example/admin/service-connect#${attemptId}`,
  },
  {
    authorizationUrl: `http://assistant.example/admin/service-connect#${attemptId}`,
  },
  { authorizationUrl: `https://assistant.example/admin#${attemptId}` },
  {
    authorizationUrl: `https://assistant.example/admin/service-connect?next=evil#${attemptId}`,
  },
  {
    authorizationUrl: `https://user@assistant.example/admin/service-connect#${attemptId}`,
  },
  { authorizationUrl: "https://assistant.example/admin/service-connect#wrong" },
  {
    authorizationUrl: `https://assistant.example/admin/service-connect#${"b".repeat(43)}`,
  },
  { serviceId: "other-service" },
  { expiresAt: 1 },
  { expiresAt: Date.now() + 900_000 },
])("rejects a misbound or expired start: %j", async (extra) => {
  const { session } = client({ ...start(), ...extra });
  await expect(
    session.serviceConnection("start", serviceId, new AbortController().signal),
  ).rejects.toThrow();
});

test("a full ten-minute attempt is accepted from a server whose clock runs ahead", async () => {
  // The server grants exactly ten minutes by its clock; this phone is 30 s behind.
  const value = { ...start(), expiresAt: Date.now() + 600_000 + 30_000 };
  const { session } = client(value);
  await expect(
    session.serviceConnection("start", serviceId, new AbortController().signal),
  ).resolves.toEqual(value);
});

test("development HTTP URL must still match the connected server exactly", async () => {
  const value = {
    ...start(),
    authorizationUrl: `http://localhost:8792/admin/service-connect#${attemptId}`,
  };
  const { session } = client(value, "http://localhost:8792/v1/a");
  await expect(
    session.serviceConnection("start", serviceId, new AbortController().signal),
  ).resolves.toEqual(value);
});

test("cancel requires an attempt and sends only that attempt; initial status has none", async () => {
  const value = { serviceId, status: "disconnected", ready: true },
    { session, request } = client(value);
  await expect(
    session.serviceConnection(
      "cancel",
      serviceId,
      new AbortController().signal,
    ),
  ).rejects.toThrow("service_connection_changed");
  expect(request).not.toHaveBeenCalled();
  await session.serviceConnection(
    "status",
    serviceId,
    new AbortController().signal,
  );
  expect(request).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ body: JSON.stringify({ serviceId }) }),
  );
  await session.serviceConnection(
    "cancel",
    serviceId,
    new AbortController().signal,
    attemptId,
  );
  expect(request).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ body: JSON.stringify({ serviceId, attemptId }) }),
  );
});
