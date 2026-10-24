import {
  connectLimit,
  serviceDetailSearchSchema,
  setupCs,
  setupEn,
  signInLine,
} from "../apps/server-admin/web/service-setup-copy";

// The result page of "Add service" says in one line what the automatic OAuth
// probe of an MCP address found; the outcome travels in the detail page's URL.
describe("add service result: automatic OAuth", () => {
  test("a detected service with a registered client", () => {
    expect(signInLine("configured", setupCs)).toBe(
      "Každý se přihlásí do služby · klient zaregistrován",
    );
    expect(signInLine("configured", setupEn)).toBe(
      "Each person signs in to the service · client registered",
    );
  });
  test("metadata without a client still names the sign-in", () => {
    expect(signInLine("metadata", setupCs)).toBe(
      "Každý se přihlásí do služby · klient chybí",
    );
    expect(signInLine("metadata", setupEn)).toBe(
      "Each person signs in to the service · client missing",
    );
  });
  test("no OAuth says so and nothing else", () => {
    expect(signInLine("none", setupCs)).toBe("Přihlášení nenalezeno");
    expect(signInLine("none", setupEn)).toBe("No sign-in found");
  });
  test("the outcome is a detail page search parameter; anything else is refused", () => {
    expect(
      serviceDetailSearchSchema.parse({ tab: "actions", signIn: "configured" }),
    ).toEqual({ tab: "actions", signIn: "configured" });
    expect(serviceDetailSearchSchema.parse({})).toEqual({});
    expect(
      serviceDetailSearchSchema.safeParse({ signIn: "registered" }).success,
    ).toBe(false);
  });
  test("the secondary action is the shared 'Edit'", () => {
    expect(setupCs.edit).toBe("Upravit");
    expect(setupEn.edit).toBe("Edit");
  });
});

describe("who may connect to a personal service", () => {
  const labels = {
    roles: { owner: "Vlastník", admin: "Administrátor", member: "Člen" },
    workspaceRoles: [{ id: "sales", name: "Obchod" }],
  };
  test("a gate never set, or one with every organization role, says nothing", () => {
    expect(connectLimit(undefined, labels, setupCs)).toBeNull();
    expect(
      connectLimit(
        { roles: ["owner", "admin", "member"], workspaceRoles: [] },
        labels,
        setupCs,
      ),
    ).toBeNull();
  });
  test("a narrowed gate names who may connect", () => {
    expect(
      connectLimit({ roles: ["member"], workspaceRoles: [] }, labels, setupCs),
    ).toBe("Připojit se mohou jen: Člen");
    expect(
      connectLimit(
        { roles: ["admin"], workspaceRoles: ["sales", "gone"] },
        {
          ...labels,
          roles: { owner: "Owner", admin: "Admin", member: "Member" },
        },
        setupEn,
      ),
    ).toBe("Only these can connect: Admin, Obchod");
  });
  test("an empty gate says nobody can", () => {
    expect(
      connectLimit({ roles: [], workspaceRoles: [] }, labels, setupCs),
    ).toBe("Připojit se nemůže nikdo");
  });
});
