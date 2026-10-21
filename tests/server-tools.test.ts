import { z } from "zod";
import { ToolRegistry, type ToolContext } from "../apps/server-tools/registry";
import { createContactTools } from "../apps/server-tools/contacts";
import { scopeFor } from "../packages/test-fixtures";
const context = (): ToolContext => ({
  scope: scopeFor(),
  permissions: new Set(["contacts.read.test"]),
  signal: new AbortController().signal,
  validateSession: jest.fn(),
});
const person = {
  id: "bfdcd207-4745-4bf1-a732-be096058ab6f",
  name: { firstName: "TEST Jana", lastName: "Nováková" },
  email: "jana@example.test",
};

test.each([1, 2])(
  "abort during async validation %s cannot execute or release a result",
  async (abortAt) => {
    const controller = new AbortController();
    const list = jest.fn(async () => [person]);
    let validations = 0;
    await expect(
      createContactTools({ list }).invoke(
        "crm.contacts.list",
        {},
        {
          ...context(),
          signal: controller.signal,
          validateSession: async () => {
            await Promise.resolve();
            if (++validations === abortAt) controller.abort();
          },
        },
      ),
    ).rejects.toThrow();
    expect(list).toHaveBeenCalledTimes(abortAt - 1);
  },
);

test("registry rejects unknown tools, unauthorized calls and injected arguments before IO", async () => {
  const list = jest.fn(async () => [person]);
  const registry = createContactTools({ list });
  await expect(
    registry.invoke("calendar.create", {}, context()),
  ).rejects.toThrow("tool_unavailable");
  await expect(
    registry.invoke(
      "crm.contacts.list",
      {},
      { ...context(), permissions: new Set() },
    ),
  ).rejects.toThrow("tool_forbidden");
  for (const args of [
    { name: "Jana", scope: scopeFor("b") },
    { url: "https://evil.test" },
    { name: "Jana", id: person.id },
    { name: "" },
  ])
    await expect(
      registry.invoke("crm.contacts.search", args, context()),
    ).rejects.toThrow("tool_invalid_input");
  expect(list).not.toHaveBeenCalled();
});
test("TEST-only search preserves canonical identity, ambiguity and a truncated scan", async () => {
  const scan = jest.fn(async () => ({
    complete: false,
    contacts: [
      person,
      {
        ...person,
        id: "bfdcd207-4745-4bf1-a732-be096058ab60",
        name: { firstName: "Real", lastName: "Person" },
      },
    ],
  }));
  const list = jest.fn(async () => []);
  const registry = createContactTools({ scan, list });
  expect(
    await registry.invoke(
      "crm.contacts.search",
      { name: "Jana Novakova" },
      context(),
    ),
  ).toEqual({
    complete: false,
    contacts: [
      { id: person.id, name: "TEST Jana Nováková", email: person.email },
    ],
  });
  expect(
    await registry.invoke("crm.contacts.search", { id: person.id }, context()),
  ).toMatchObject({ complete: true, contacts: [{ id: person.id }] });
  expect(
    await registry.invoke(
      "crm.contacts.search",
      { name: "Real Person" },
      context(),
    ),
  ).toMatchObject({ contacts: [] });
  expect(list).not.toHaveBeenCalled();
});
test("registry validates output and sanitizes provider errors", async () => {
  const registry = new ToolRegistry();
  registry.register("invalid", {
    permission: "contacts.read.test",
    input: z.strictObject({}),
    output: z.string(),
    execute: async () => 7 as unknown as string,
  });
  await expect(registry.invoke("invalid", {}, context())).rejects.toThrow(
    "tool_failed",
  );
  await expect(
    createContactTools({
      list: async () => {
        throw Error("secret-provider-token");
      },
    }).invoke("crm.contacts.list", {}, context()),
  ).rejects.toThrow(/^tool_failed$/);
  await expect(
    createContactTools({ list: async () => [person, person] }).invoke(
      "crm.contacts.list",
      {},
      context(),
    ),
  ).rejects.toThrow("tool_failed");
});
test.each(["abort", "revoked"])(
  "late %s discards a tool response",
  async (mode) => {
    const abort = new AbortController();
    let revoked = false;
    const registry = createContactTools({
      list: async () => {
        if (mode === "abort") abort.abort();
        else revoked = true;
        return [person];
      },
    });
    await expect(
      registry.invoke(
        "crm.contacts.list",
        {},
        {
          ...context(),
          signal: abort.signal,
          validateSession: () => {
            if (revoked) throw Error("revoked");
          },
        },
      ),
    ).rejects.toThrow();
  },
);
