import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IdentityError } from "./error";
import type { DeviceIdentity } from "./device-sessions";
const secret = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const hash = (v: string) => createHash("sha256").update(v).digest("base64url");
export class AppLogin {
  constructor(
    private db: DatabaseSync,
    private origin: string,
  ) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS agent_app_login(id TEXT PRIMARY KEY, challenge TEXT NOT NULL, state TEXT NOT NULL, target TEXT NOT NULL, expires INTEGER NOT NULL, code TEXT UNIQUE, grant_json TEXT, parent_session TEXT REFERENCES session(id) ON DELETE CASCADE) STRICT`,
    );
  }
  start(raw: unknown, target: string) {
    const v = z.strictObject({ challenge: secret, state: secret }).parse(raw);
    this.db
      .prepare("DELETE FROM agent_app_login WHERE expires<=?")
      .run(Date.now());
    if (
      Number(
        this.db.prepare("SELECT count(*) AS n FROM agent_app_login").get()!.n,
      ) >= 512
    )
      throw new IdentityError(429, "identity_limit");
    const id = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO agent_app_login VALUES (?,?,?,?,?,NULL,NULL,NULL)")
      .run(id, v.challenge, v.state, target, Date.now() + 300000);
    return { authorizationUrl: `${this.origin}/account/login#${id}` };
  }
  consent(id: string, grant: DeviceIdentity, session: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM agent_app_login WHERE id=? AND expires>? AND code IS NULL",
      )
      .get(id, Date.now());
    if (!row) throw new IdentityError(410, "browser_login_expired");
    const code = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "UPDATE agent_app_login SET code=?,grant_json=?,parent_session=?,expires=? WHERE id=?",
      )
      .run(hash(code), JSON.stringify(grant), session, Date.now() + 60000, id);
    return { code, state: row.state, target: row.target };
  }
  exchange(raw: unknown, issue: (grant: DeviceIdentity) => unknown) {
    const v = z
      .strictObject({ code: secret, verifier: secret, state: secret })
      .parse(raw);
    const row = this.db
      .prepare("SELECT * FROM agent_app_login WHERE code=? AND expires>?")
      .get(hash(v.code), Date.now());
    if (!row || hash(v.verifier) !== row.challenge || v.state !== row.state)
      throw new IdentityError(403, "app_login_invalid");
    const grant = JSON.parse(String(row.grant_json)) as DeviceIdentity;
    const parent = this.db
      .prepare('SELECT "expiresAt" FROM session WHERE id=? AND "userId"=?')
      .get(row.parent_session!, grant.user_id);
    if (!parent || Date.parse(String(parent.expiresAt)) <= Date.now())
      throw new IdentityError(403, "app_login_invalid");
    const credential = issue(grant);
    this.db.prepare("DELETE FROM agent_app_login WHERE id=?").run(row.id!);
    return { address: `${this.origin}/v1/${grant.workspace_id}`, credential };
  }
}
