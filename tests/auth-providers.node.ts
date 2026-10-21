import { randomBytes, createHash, randomUUID } from "node:crypto";
import { Invitations } from "../apps/server-identity/invitations";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { createKyselyAdapter } from "@better-auth/kysely-adapter";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import type { OAuthProvider } from "@better-auth/core/oauth2";
import { AuthProviderStore } from "../apps/server-identity/auth-providers";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { verifyProviderIdToken } from "@better-auth/core/oauth2";
import {
  createAuthProviderBridge,
  nativeFactory,
  providerCallbackOutcome,
} from "../apps/server-identity/auth-provider-bridge";
import { SaveAuthProviderSchema } from "../packages/protocol/auth-providers";

const baseURL = "https://agent.example.test";
const secret = "synthetic-secret-for-provider-tests-at-least-thirty-two-chars";
const input = {
  kind: "google",
  name: "Company Google",
  enabled: true,
  clientId: "synthetic-client",
  clientSecret: "synthetic-client-secret",
} as const;
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((part) => part.split(";", 1)[0])
    .join("; ");
}
async function harness(
  kind: "google" | "microsoft" | "github" = "google",
  timeoutMs = 1000,
) {
  const db = new DatabaseSync(":memory:");
  const store = new AuthProviderStore(db, secret, baseURL);
  const configInput = {
    ...input,
    kind,
    ...(kind === "microsoft"
      ? { tenantId: "11111111-1111-4111-8111-111111111111" }
      : {}),
  };
  const provider = store.save("company", null, 0, configInput);
  const remote = {
    exchanges: 0,
    infos: 0,
    subject: "provider-alice",
    email: "alice@example.test",
    emailVerified: true,
    wait: false,
    nonce: "",
  };
  const factory = (): OAuthProvider => ({
    id: kind,
    name: kind,
    options: { clientId: input.clientId, clientSecret: input.clientSecret },
    accountSubject: ({ profile }) => String((profile as { sub: string }).sub),
    createAuthorizationURL(data) {
      remote.nonce = data.idTokenNonce ?? "";
      const url = new URL("https://provider.example.test/authorize");
      url.searchParams.set("state", data.state);
      url.searchParams.set("redirect_uri", data.redirectURI);
      return url;
    },
    async validateAuthorizationCode() {
      remote.exchanges++;
      if (remote.wait) await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        accessToken: "synthetic-access-secret",
        refreshToken: "synthetic-refresh-secret",
        idToken: "synthetic-id-secret",
        scopes: ["openid", "profile", "email"],
      };
    },
    idToken: {
      verify: async (token, nonce) =>
        token === "synthetic-id-secret" &&
        nonce === remote.nonce &&
        Boolean(nonce),
    },
    async getUserInfo() {
      remote.infos++;
      return {
        user: {
          email: remote.email,
          emailVerified: remote.emailVerified,
          name: "Alice provider",
        },
        data: { sub: remote.subject },
      };
    },
  });
  const bridge = createAuthProviderBridge(store, { factory, timeoutMs });
  const { kysely } = await createKyselyAdapter({ database: db });
  assert.ok(kysely);
  const auth = betterAuth({
    ...bridge.options,
    baseURL,
    basePath: "/admin/auth",
    secret,
    database: { db: kysely, type: "sqlite", transaction: false },
    emailAndPassword: { enabled: true, autoSignIn: false },
    session: { cookieCache: { enabled: false }, disableSessionRefresh: true },
    advanced: {
      ...bridge.options.advanced,
      cookiePrefix: "test_identity",
      useSecureCookies: true,
      defaultCookieAttributes: {
        path: "/admin",
        httpOnly: true,
        sameSite: "strict",
      },
    },
    plugins: [
      organization({ allowUserToCreateOrganization: false }),
      bridge.plugin,
    ],
    logger: { disabled: true },
  });
  await (await getMigrations(auth.options)).runMigrations();
  const user = await auth.api.signUpEmail({
    body: {
      email: "alice@example.test",
      name: "Alice local",
      password: "synthetic-password",
    },
  });
  db.prepare(
    'INSERT INTO organization(id,name,slug,"createdAt") VALUES(?,?,?,?)',
  ).run("company", "Company", "company", new Date().toISOString());
  db.prepare(
    'INSERT INTO organization(id,name,slug,"createdAt") VALUES(?,?,?,?)',
  ).run("other-company", "Other", "other", new Date().toISOString());
  db.prepare(
    'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES(?,?,?,?,?)',
  ).run(
    "member-alice",
    "company",
    user.user.id,
    "member",
    new Date().toISOString(),
  );
  function request(path: string, body?: unknown, cookies?: string) {
    return auth.handler(
      new Request(`${baseURL}/admin/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: baseURL,
          "content-type": "application/json",
          ...(cookies ? { cookie: cookies } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  const login = await request("/sign-in/email", {
    email: "alice@example.test",
    password: "synthetic-password",
  });
  assert.equal(login.status, 200);
  const cookies = cookie(login);
  const actor = {
    userId: user.user.id,
    sessionId: String(
      db.prepare('SELECT id FROM session WHERE "userId"=?').get(user.user.id)!
        .id,
    ),
  };
  async function start(
    mode: "link" | "sign-in" = "link",
    invitationToken?: string,
  ) {
    const flow = store.begin({
      organizationId: "company",
      providerId: provider.id,
      mode,
      ...(mode === "link" ? { actor } : {}),
      returnPath: invitationToken
        ? `/account/invite#${invitationToken}`
        : "/admin/service-connect#mobile-attempt",
      invitationToken,
    });
    const response = await bridge.runStart(flow, () =>
      request(
        mode === "link" ? "/link-social" : "/sign-in/social",
        { provider: provider.id },
        mode === "link" ? cookies : undefined,
      ),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as { url: string };
    const url = new URL(body.url);
    return {
      flow,
      response,
      url,
      callback: () =>
        request(
          `/callback/${provider.id}?state=${encodeURIComponent(url.searchParams.get("state")!)}&code=synthetic-code`,
          undefined,
          cookie(response),
        ),
    };
  }
  return {
    db,
    store,
    provider,
    configInput,
    bridge,
    auth,
    actor,
    remote,
    request,
    start,
    cookies,
  };
}

test("draft callback stays exact through creation without registering or reusing an identity namespace", () => {
  const db = new DatabaseSync(":memory:");
  const store = new AuthProviderStore(db, secret, `${baseURL}/admin/`);
  try {
    const draft = store.draft("company");
    assert.equal(draft.organizationId, "company");
    assert.equal(
      draft.callbackURL,
      `${baseURL}/admin/auth/callback/${draft.providerId}`,
    );
    assert.notEqual(store.draft("company").providerId, draft.providerId);
    assert.deepEqual(store.list("company"), []);
    assert.deepEqual(store.publicChoices(), []);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM agent_auth_provider").get()!.n,
      0,
    );

    const provider = store.save("company", null, 0, input, draft.providerId);
    assert.equal(provider.id, draft.providerId);
    assert.equal(provider.callbackURL, draft.callbackURL);
    // A provider saved before the public address changed shows the current one.
    const moved = new AuthProviderStore(
      db,
      secret,
      "https://moved.example.test",
    );
    assert.equal(
      moved.get("company", provider.id).callbackURL,
      `https://moved.example.test/admin/auth/callback/${provider.id}`,
    );
    assert.equal(
      moved.list("company")[0]!.callbackURL,
      `https://moved.example.test/admin/auth/callback/${provider.id}`,
    );
    assert.throws(() =>
      store.save("company", null, 0, input, draft.providerId),
    );
    assert.throws(() =>
      store.save("other-company", null, 0, input, draft.providerId),
    );
    assert.equal(store.get("company", provider.id).revision, 1);
    assert.equal(store.snapshot()[0]!.clientSecret, input.clientSecret);
    assert.throws(() =>
      store.save(
        "company",
        provider.id,
        1,
        input,
        store.draft("company").providerId,
      ),
    );
    assert.throws(() =>
      store.save("company", null, 1, input, store.draft("company").providerId),
    );
    assert.throws(() => store.save("company", null, 0, input, "invalid-id"));
    assert.throws(() =>
      SaveAuthProviderSchema.parse({
        organizationId: "company",
        providerId: provider.id,
        creationId: provider.id,
        revision: 1,
        input,
      }),
    );

    store.delete("company", provider.id, 1);
    assert.throws(() =>
      store.save("company", null, 0, input, draft.providerId),
    );
    assert.throws(() =>
      store.save("other-company", null, 0, input, draft.providerId),
    );
    assert.deepEqual(store.publicChoices(), []);
    assert.equal(
      db
        .prepare("SELECT secret FROM agent_auth_provider WHERE id=?")
        .get(provider.id)!.secret,
      null,
    );
  } finally {
    db.close();
  }
});

test("company registry is masked, encrypted, revisioned and identity namespaces are immutable", async () => {
  const { db, store, provider } = await harness();
  try {
    assert.ok(
      !JSON.stringify(store.list("company")).includes(input.clientSecret),
    );
    assert.ok(
      !String(
        db
          .prepare("SELECT secret FROM agent_auth_provider WHERE id=?")
          .get(provider.id)!.secret,
      ).includes(input.clientSecret),
    );
    assert.equal(store.snapshot()[0]!.clientSecret, input.clientSecret);
    assert.throws(() => store.get("other-company", provider.id));
    assert.throws(() => store.save("company", provider.id, 0, input));
    assert.throws(() =>
      store.save("company", provider.id, 1, {
        ...input,
        clientId: "other-client",
      }),
    );
    const updated = store.save("company", provider.id, 1, {
      ...input,
      clientSecret: undefined,
      name: "Renamed",
    });
    assert.equal(updated.revision, 2);
    assert.equal(store.snapshot()[0]!.clientSecret, input.clientSecret);
    const second = store.save("other-company", null, 0, input);
    assert.notEqual(provider.id, second.id);
    store.delete("company", provider.id, 2);
    assert.throws(() => store.get("company", provider.id));
    assert.equal(store.publicChoices().length, 1);
    assert.throws(() => store.save("company", provider.id, 3, input));
  } finally {
    db.close();
  }
});

test("explicit native link then sign-in works; cookies, callbacks, pins and credentials are safe", async () => {
  const { db, store, provider, actor, start } = await harness();
  try {
    const link = await start();
    assert.equal(
      link.url.searchParams.get("redirect_uri"),
      provider.callbackURL,
    );
    assert.ok(link.url.searchParams.get("nonce"));
    assert.match(
      link.response.headers.getSetCookie().join("\n"),
      /SameSite=Lax/i,
    );
    assert.equal(
      (await link.callback()).headers.get("location"),
      `${baseURL}/admin/service-connect#mobile-attempt`,
    );
    assert.equal(store.status(link.flow.id).phase, "complete");
    const rows = db
      .prepare('SELECT * FROM account WHERE "providerId"=?')
      .all(provider.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.userId, actor.userId);
    for (const key of ["accessToken", "refreshToken", "idToken"])
      assert.equal(rows[0]![key], null);
    const pin = store.assertLinked("company", actor.userId, provider.id);
    assert.equal(pin.subject, "provider-alice");
    assert.equal(
      store.linkedStatus("company", actor.userId, provider.id).linked,
      true,
    );
    const signIn = await start("sign-in");
    const response = await signIn.callback();
    assert.equal(
      response.headers.get("location"),
      `${baseURL}/admin/service-connect#mobile-attempt`,
    );
    assert.match(response.headers.getSetCookie().join("\n"), /session_token=/);
    assert.equal(store.status(signIn.flow.id).phase, "complete");
    const updatedAccount = db
      .prepare('SELECT * FROM account WHERE "providerId"=?')
      .get(provider.id)!;
    for (const key of ["accessToken", "refreshToken", "idToken"])
      assert.equal(updatedAccount[key], null);
    store.assertLinked("company", actor.userId, provider.id, pin);
    store.save("company", provider.id, 1, { ...input, name: "Changed" });
    assert.throws(() =>
      store.assertLinked("company", actor.userId, provider.id, pin),
    );
  } finally {
    db.close();
  }
});

test("unlinked native sign-in never links a matching email or creates a user", async () => {
  const { db, provider, remote, start } = await harness();
  try {
    const signIn = await start("sign-in");
    const result = await signIn.callback();
    assert.match(result.headers.get("location")!, /error=/);
    assert.equal(remote.exchanges, 1);
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM account WHERE "providerId"=?')
        .get(provider.id)!.n,
      0,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM user").get()!.n, 1);
  } finally {
    db.close();
  }
});

test("revision, browser session and membership changes invalidate pending links before exchange", async () => {
  for (const change of ["revision", "session", "member"] as const) {
    const { db, store, provider, actor, remote, start } = await harness();
    try {
      const link = await start();
      if (change === "revision")
        store.save("company", provider.id, 1, { ...input, name: "Updated" });
      if (change === "session")
        db.prepare("DELETE FROM session WHERE id=?").run(actor.sessionId);
      if (change === "member")
        db.prepare('DELETE FROM member WHERE "userId"=?').run(actor.userId);
      assert.match((await link.callback()).headers.get("location")!, /error=/);
      assert.equal(remote.exchanges, 0);
      assert.equal(
        db
          .prepare('SELECT count(*) AS n FROM account WHERE "providerId"=?')
          .get(provider.id)!.n,
        0,
      );
    } finally {
      db.close();
    }
  }
});

test("flow cannot replay, use a different provider, or start without the original browser session", async () => {
  const { db, store, provider, actor, bridge, request, start, remote } =
    await harness();
  try {
    const intent = store.begin({
      organizationId: "company",
      providerId: provider.id,
      mode: "link",
      actor,
    });
    const wrong = await bridge.runStart(intent, () =>
      request("/link-social", { provider: provider.id }),
    );
    assert.equal(wrong.status, 403);
    const direct = await request("/sign-in/social", { provider: provider.id });
    assert.equal(direct.status, 403);
    const link = await start();
    await link.callback();
    const second = await link.callback();
    assert.match(second.headers.get("location")!, /error=/);
    assert.equal(remote.exchanges, 1);
    assert.throws(() => store.claimFlow(link.flow.id, "another-provider", 1));
  } finally {
    db.close();
  }
});

test("Microsoft explicit link accepts its unverified email only with the bound browser session", async () => {
  const { db, start, remote, store } = await harness("microsoft");
  try {
    remote.emailVerified = false;
    const link = await start();
    assert.equal(
      (await link.callback()).headers.get("location"),
      `${baseURL}/admin/service-connect#mobile-attempt`,
    );
    assert.equal(store.status(link.flow.id).phase, "complete");
  } finally {
    db.close();
  }
});

test("different provider email links only to the authenticated user and later sign-in uses its subject", async () => {
  for (const kind of ["google", "microsoft"] as const) {
    const { db, start, remote, store, actor, provider, auth } =
      await harness(kind);
    try {
      const other = await auth.api.signUpEmail({
        body: {
          email: "other@example.test",
          name: "Other local user",
          password: "synthetic-other-password",
        },
      });
      remote.email = "other@example.test";
      remote.emailVerified = kind !== "microsoft";
      const link = await start();
      assert.equal(
        (await link.callback()).headers.get("location"),
        `${baseURL}/admin/service-connect#mobile-attempt`,
      );
      assert.equal(store.status(link.flow.id).phase, "complete");
      assert.equal(
        db
          .prepare('SELECT "userId" FROM account WHERE "providerId"=?')
          .get(provider.id)!.userId,
        actor.userId,
      );
      assert.equal(
        db.prepare("SELECT email FROM user WHERE id=?").get(actor.userId)!
          .email,
        "alice@example.test",
      );
      assert.equal(
        db.prepare("SELECT email FROM user WHERE id=?").get(other.user.id)!
          .email,
        "other@example.test",
      );
      const signIn = await start("sign-in");
      const response = await signIn.callback();
      const session = await auth.api.getSession({
        headers: new Headers({ cookie: cookie(response) }),
      });
      assert.equal(session?.user.id, actor.userId);
      // Email alone still cannot attach a new provider subject to either user.
      remote.subject = "unlinked-subject";
      const unmatched = await start("sign-in");
      assert.match(
        (await unmatched.callback()).headers.get("location")!,
        /error=/,
      );
      assert.equal(
        db
          .prepare('SELECT count(*) AS n FROM account WHERE "providerId"=?')
          .get(provider.id)!.n,
        1,
      );
      assert.equal(db.prepare("SELECT count(*) AS n FROM user").get()!.n, 2);
    } finally {
      db.close();
    }
  }
});

test("a different signed-in browser user and mismatched state actor cannot acquire the link", async () => {
  const { db, start, store, actor, provider, auth, request, bridge, remote } =
    await harness();
  try {
    const other = await auth.api.signUpEmail({
      body: {
        email: "other@example.test",
        name: "Other local user",
        password: "synthetic-other-password",
      },
    });
    db.prepare(
      'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES(?,?,?,?,?)',
    ).run(
      "other-member",
      "company",
      other.user.id,
      "member",
      new Date().toISOString(),
    );
    const otherLogin = await request("/sign-in/email", {
      email: "other@example.test",
      password: "synthetic-other-password",
    });
    const intent = store.begin({
      organizationId: "company",
      providerId: provider.id,
      mode: "link",
      actor,
    });
    const wrongBrowser = await bridge.runStart(intent, () =>
      request("/link-social", { provider: provider.id }, cookie(otherLogin)),
    );
    assert.equal(wrongBrowser.status, 403);
    assert.equal(remote.exchanges, 0);
    const link = await start();
    const state = link.url.searchParams.get("state")!;
    const verification = db
      .prepare("SELECT id,value FROM verification WHERE identifier=?")
      .get(state)!;
    const value = JSON.parse(String(verification.value));
    value.link.userId = other.user.id;
    value.link.email = "other@example.test";
    // Even a substituted Better Auth link payload cannot change the separately
    // persisted flow's original session owner.
    db.prepare("UPDATE verification SET value=? WHERE id=?").run(
      JSON.stringify(value),
      verification.id!,
    );
    assert.match((await link.callback()).headers.get("location")!, /error=/);
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM account WHERE "providerId"=?')
        .get(provider.id)!.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("OIDC nonce verification rejects a token from another authorization", async () => {
  const { db, start, remote, provider } = await harness();
  try {
    const link = await start();
    remote.nonce = "different-authorization";
    assert.match((await link.callback()).headers.get("location")!, /error=/);
    assert.equal(remote.infos, 0);
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM account WHERE "providerId"=?')
        .get(provider.id)!.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("bounded provider timeout does not persist a late successful token response", async () => {
  const { db, start, remote, provider } = await harness("github", 5);
  try {
    remote.wait = true;
    const link = await start();
    assert.match((await link.callback()).headers.get("location")!, /error=/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(remote.infos, 0);
    assert.equal(
      db
        .prepare('SELECT count(*) AS n FROM account WHERE "providerId"=?')
        .get(provider.id)!.n,
      0,
    );
  } finally {
    db.close();
  }
});

function invitationFixture(
  h: Awaited<ReturnType<typeof harness>>,
  email = "new@example.test",
) {
  h.db
    .exec(`CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS agent_workspace_member(workspace_id TEXT,member_id TEXT,PRIMARY KEY(workspace_id,member_id));
    INSERT OR IGNORE INTO agent_workspace VALUES('workspace','company','TEST Workspace');
    UPDATE member SET role='owner' WHERE id='member-alice';`);
  const invitations = new Invitations(h.db);
  const token = randomBytes(32).toString("base64url"),
    id = randomUUID();
  h.db
    .prepare("INSERT INTO agent_workspace_invitation (id,digest,workspace_id,email,inviter_id,expires_at) VALUES (?,?,?,?,?,?)")
    .run(
      id,
      createHash("sha256").update(token).digest("hex"),
      "workspace",
      email,
      h.actor.userId,
      Date.now() + 60000,
    );
  return { token, id, invitations };
}
for (const kind of ["google", "microsoft", "github"] as const) {
  test(`${kind}: invitation authenticates a new identity without password or workspace access before acceptance`, async () => {
    const h = await harness(kind);
    try {
      const { token, invitations } = invitationFixture(h);
      h.remote.email = "NEW@example.test";
      h.remote.subject = "new-subject";
      h.remote.emailVerified = false; // Invitation bearer proves the invited mailbox.
      const flow = await h.start("sign-in", token);
      const result = await flow.callback();
      assert.equal(
        result.headers.get("location"),
        `${baseURL}/account/invite#${token}`,
      );
      assert.match(cookie(result), /session_token=/);
      const user = h.db
        .prepare("SELECT id,email FROM user WHERE email=?")
        .get("new@example.test")!;
      assert.ok(user);
      assert.equal(
        h.db
          .prepare('SELECT count(*) AS n FROM member WHERE "userId"=?')
          .get(user.id!)!.n,
        0,
      );
      const account = h.db
        .prepare('SELECT * FROM account WHERE "userId"=?')
        .get(user.id!)!;
      assert.equal(account.providerId, h.provider.id);
      for (const key of ["password", "accessToken", "refreshToken", "idToken"])
        assert.equal(account[key], null);
      assert.equal(invitations.inspect(token).email, "new@example.test");
      const retry = await h.start("sign-in", token);
      assert.match(cookie(await retry.callback()), /session_token=/);
      assert.equal(h.db.prepare("SELECT count(*) AS n FROM user").get()!.n, 2);

      assert.match((await flow.callback()).headers.get("location")!, /error=/);
      // Without accepting the invitation, ordinary provider sign-in cannot grant access.
      assert.match(
        (await (await h.start("sign-in")).callback()).headers.get("location")!,
        /error=/,
      );
    } finally {
      h.db.close();
    }
  });
}
for (const scenario of [
  "wrong-email",
  "existing-email",
  "revoked",
  "expired",
  "demoted",
  "provider-changed",
] as const) {
  test(`Invitation OAuth rejects ${scenario} without creating any identity`, async () => {
    const h = await harness();
    try {
      const { token, id, invitations } = invitationFixture(
        h,
        scenario === "existing-email"
          ? "alice@example.test"
          : "new@example.test",
      );
      h.remote.email =
        scenario === "existing-email"
          ? "ALICE@example.test"
          : "new@example.test";
      h.remote.subject = "new-subject";
      const flow = await h.start("sign-in", token);
      if (scenario === "wrong-email") h.remote.email = "other@example.test";
      if (scenario === "revoked") invitations.revoke("workspace", id);
      if (scenario === "expired")
        h.db
          .prepare(
            "UPDATE agent_workspace_invitation SET expires_at=0 WHERE id=?",
          )
          .run(id);
      if (scenario === "demoted") h.db.exec("UPDATE member SET role='member'");
      if (scenario === "provider-changed")
        h.store.save("company", h.provider.id, 1, {
          ...input,
          name: "Changed",
        });
      const outcome: { reason?: string } = {};
      assert.match(
        (
          await providerCallbackOutcome.run(outcome, () => flow.callback())
        ).headers.get("location")!,
        /error=/,
      );
      // Only reasons the person can act on are named; the rest stay generic.
      assert.equal(
        outcome.reason,
        scenario === "wrong-email"
          ? "invitation_account_mismatch"
          : scenario === "existing-email"
            ? "auth_provider_link_required"
            : undefined,
      );
      assert.equal(h.db.prepare("SELECT count(*) AS n FROM user").get()!.n, 1);
      assert.equal(
        h.db
          .prepare('SELECT count(*) AS n FROM account WHERE "providerId"=?')
          .get(h.provider.id)!.n,
        0,
      );
    } finally {
      h.db.close();
    }
  });
}
test("Invitation cannot be used with another organization's provider", async () => {
  const h = await harness();
  try {
    const { token } = invitationFixture(h);
    const provider = h.store.save("other-company", null, 0, input);
    assert.throws(() =>
      h.store.begin({
        organizationId: "other-company",
        providerId: provider.id,
        mode: "sign-in",
        invitationToken: token,
      }),
    );
  } finally {
    h.db.close();
  }
});

test("Microsoft verifies RSA keys without alg, while rejecting invalid nonce, audience, issuer and signatures", async (t) => {
  const h = await harness("microsoft");
  try {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: "test-key",
      use: "sig",
    };
    assert.equal("alg" in jwk, false);
    const snapshot = h.store.snapshot()[0]!;
    const issuer = `https://login.microsoftonline.com/${snapshot.tenantId}/v2.0`;
    t.mock.method(globalThis, "fetch", async (url: unknown) => {
      assert.equal(
        String(url),
        `https://login.microsoftonline.com/${snapshot.tenantId}/discovery/v2.0/keys`,
      );
      return Response.json({ keys: [jwk] });
    });
    const provider = nativeFactory(snapshot);
    const sign = (claims: Record<string, unknown> = {}, key = privateKey) =>
      new SignJWT({ tid: snapshot.tenantId, nonce: "test-nonce", ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setAudience(snapshot.clientId)
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(key);
    const valid = await sign();
    assert.equal(
      await verifyProviderIdToken(provider, valid, "test-nonce"),
      true,
    );
    assert.equal(
      await verifyProviderIdToken(provider, valid, "other-nonce"),
      false,
    );
    const wrongAudience = {
      ...provider,
      idToken: { ...provider.idToken!, audience: "wrong-client" },
    };
    assert.equal(
      await verifyProviderIdToken(wrongAudience, valid, "test-nonce"),
      false,
    );
    const wrongIssuer = {
      ...provider,
      idToken: { ...provider.idToken!, issuer: "https://other.example.test" },
    };
    assert.equal(
      await verifyProviderIdToken(wrongIssuer, valid, "test-nonce"),
      false,
    );
    assert.equal(
      await verifyProviderIdToken(
        provider,
        await sign({ tid: "other-tenant" }),
        "test-nonce",
      ),
      false,
    );
    const attacker = await generateKeyPair("RS256");
    assert.equal(
      await verifyProviderIdToken(
        provider,
        await sign({}, attacker.privateKey),
        "test-nonce",
      ),
      false,
    );
  } finally {
    h.db.close();
  }
});
