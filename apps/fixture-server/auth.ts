import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AUTH_PROFILE,
  PROFILE,
  AuthSessionSchema,
  type AuthSession,
} from "../../packages/protocol";

export const PrincipalSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const GrantSchema = z.strictObject({
  userId: PrincipalSchema,
  workspaceId: z.enum(["a", "b"]),
  expiresAt: z.number().int().positive(),
});
const SessionsSchema = z.record(
  z.string().regex(/^[a-f0-9]{64}$/),
  AuthSessionSchema,
);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const authPath = (directory: string) => join(directory, "auth");
function atomic(file: string, value: unknown) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
/** Operator-only filesystem action. Never exposed through an unauthenticated API. */
export function issuePairingCode(
  directory: string,
  userId: string,
  workspaceId: string,
  now = Date.now(),
) {
  const grant = GrantSchema.parse({
    userId,
    workspaceId,
    expiresAt: now + 5 * 60_000,
  });
  const dir = join(authPath(directory), "pairing");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const code = randomBytes(16).toString("hex");
  writeFileSync(join(dir, `${hash(code)}.json`), JSON.stringify(grant), {
    mode: 0o600,
    flag: "wx",
  });
  return code;
}
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 429,
    readonly code: string,
  ) {
    super(code);
  }
}
export class FixtureAuth {
  private sessions: Record<string, AuthSession>;
  private attempts = new Map<string, { count: number; until: number }>();
  readonly serverId: string;
  private readonly file: string;
  constructor(
    private directory: string,
    private now = () => Date.now(),
    private ttlMs = 30 * 60_000,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 3_600_000)
      throw Error("Invalid session lifetime");
    const dir = authPath(directory);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const idFile = join(dir, "server-id");
    if (!existsSync(idFile))
      writeFileSync(idFile, `fixture-${randomBytes(12).toString("hex")}`, {
        mode: 0o600,
        flag: "wx",
      });
    this.serverId = readFileSync(idFile, "utf8");
    if (!/^fixture-[a-f0-9]{24}$/.test(this.serverId))
      throw Error("Invalid stored server identity");
    this.file = join(dir, "sessions.json");
    this.sessions = existsSync(this.file)
      ? SessionsSchema.parse(
          JSON.parse(readFileSync(this.file, "utf8"), (key, value) =>
            key === "profile" &&
            [
              "agent-client/0.2-fixture",
              "agent-client/0.3-fixture",
              "agent-client/0.4-fixture",
              "agent-client/0.5-fixture",
              "agent-client/0.6-fixture",
              "agent-client/0.7-fixture",
            ].includes(value)
              ? PROFILE
              : value,
          ),
        )
      : {};
  }
  rateLimit(remote: string) {
    const now = this.now();
    for (const [key, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(key);
    if (this.attempts.size >= 1000 && !this.attempts.has(remote))
      throw new AuthError(429, "pairing_rate_limited");
    const state = this.attempts.get(remote) ?? {
      count: 0,
      until: now + 60_000,
    };
    state.count++;
    this.attempts.set(remote, state);
    if (state.count > 10) throw new AuthError(429, "pairing_rate_limited");
  }
  pair(code: string, workspaceId: string) {
    const path = join(
      authPath(this.directory),
      "pairing",
      `${hash(code)}.json`,
    );
    if (!existsSync(path)) throw new AuthError(401, "pairing_invalid");
    const grant = GrantSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (grant.workspaceId !== workspaceId || grant.expiresAt <= this.now())
      throw new AuthError(401, "pairing_invalid");
    const session: AuthSession = {
      authProfile: AUTH_PROFILE,
      profile: PROFILE,
      scope: {
        connectionId: `fixture-${workspaceId}`,
        serverId: this.serverId,
        userId: grant.userId,
        workspaceId,
      },
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      permissions: ["workflow.read", "workflow.write"],
    };
    const accessToken = randomBytes(32).toString("base64url");
    const next = Object.fromEntries(
      Object.entries(this.sessions).filter(
        ([, s]) => Date.parse(s.expiresAt) > this.now(),
      ),
    );
    if (Object.keys(next).length >= 512)
      throw new AuthError(429, "pairing_rate_limited");
    next[hash(accessToken)] = session;
    // Consume before persisting the session: a crash can lose a grant, never reuse it.
    renameSync(path, `${path}.consumed`);
    try {
      atomic(this.file, next);
    } catch (error) {
      renameSync(`${path}.consumed`, path);
      throw error;
    }
    this.sessions = next;
    try {
      unlinkSync(`${path}.consumed`);
    } catch {
      /* Already consumed; not redeemable. */
    }
    return { ...session, accessToken };
  }
  authenticate(header: string | undefined, workspaceId: string) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
    const session = token ? this.sessions[hash(token)] : undefined;
    if (!session || Date.parse(session.expiresAt) <= this.now())
      throw new AuthError(401, "auth_expired");
    if (
      session.scope.serverId !== this.serverId ||
      session.scope.workspaceId !== workspaceId
    )
      throw new AuthError(403, "auth_scope_mismatch");
    return session;
  }
  revoke(header: string) {
    const token = header.slice(7);
    const next = { ...this.sessions };
    delete next[hash(token)];
    atomic(this.file, next);
    this.sessions = next;
  }
}
