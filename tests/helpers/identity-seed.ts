/** Isolated regression-fixture setup only. Production enrollment is tested through invitations. */
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import type { IdentityService } from "../../apps/server-identity/service";
import { IdentityCommandSchema } from "../../packages/protocol/identity";
const passwords = new Map<string, string>();
export async function seedIdentityFixture(
  identity: IdentityService,
  raw: unknown,
) {
  const v = IdentityCommandSchema.parse(raw);
  // The private database is deliberately accessed only by test code, never by an HTTP switch.
  const db = identity["db"];
  if (v.type === "createAccount") {
    const id = randomUUID(),
      member = randomUUID(),
      account = randomUUID(),
      now = new Date().toISOString(),
      password = await hashPassword(v.password);
    db.exec("BEGIN");
    try {
      db.prepare(
        'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)',
      ).run(id, v.name, v.email, now, now);
      db.prepare(
        'INSERT INTO account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)',
      ).run(account, id, "credential", id, password, now, now);
      db.prepare(
        'INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES (?,?,?,?,?)',
      ).run(member, v.organizationId, id, v.role, now);
      db.exec("COMMIT");
      passwords.set(`${identity.baseURL}:${v.email}`, v.password);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } else if (v.type === "setWorkspaceMember" && v.allowed) {
    const user = db
      .prepare(
        'SELECT u.email FROM member m JOIN user u ON u.id=m."userId" WHERE m.id=? AND m."organizationId"=?',
      )
      .get(v.memberId, v.organizationId)!;
    const email = String(user.email),
      password = passwords.get(`${identity.baseURL}:${email}`);
    if (!password) throw Error("Missing test fixture password");
    const headers = {
      Origin: identity.baseURL,
      "X-Agent-Admin": "1",
      "Content-Type": "application/json",
    };
    const login = await fetch(`${identity.baseURL}/admin/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) throw Error("Test fixture sign-in failed");
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const inviter = db
      .prepare(
        'SELECT "userId" FROM member WHERE "organizationId"=? AND role=\'owner\'',
      )
      .get(v.organizationId)!;
    const token = randomBytes(32).toString("base64url");
    db.prepare(
      "INSERT INTO agent_workspace_invitation (id,digest,workspace_id,email,inviter_id,expires_at) VALUES (?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      createHash("sha256").update(token).digest("hex"),
      v.workspaceId,
      email,
      inviter.userId!,
      Date.now() + 60000,
    );
    const accepted = await fetch(
      `${identity.baseURL}/admin/api/identity/invitation`,
      {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        body: JSON.stringify({ token, accept: true }),
      },
    );
    if (!accepted.ok)
      throw Error(`Test fixture invitation failed: ${accepted.status}`);
  } else
    throw Error(
      "Only fixture enrollment may bypass the removed legacy enrollment API",
    );
  identity["connections"].changePolicy(v.organizationId);
  return { status: 200, data: { ok: true } };
}
