import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const StoredKey = z.strictObject({
  version: z.literal(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function readKey(file: string) {
  const stats = statSync(file);
  if (
    !stats.isFile() ||
    stats.size > 4096 ||
    stats.mode & 0o077 ||
    (process.getuid && stats.uid !== process.getuid())
  )
    throw Error("Invalid private administrator key file");
  return StoredKey.parse(JSON.parse(readFileSync(file, "utf8"))).hash;
}
/** Local operator action. Raw key is returned once; only its digest is stored. */
export function issueAdminKey(file: string, rotate = false) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = `acadmin_${randomBytes(32).toString("base64url")}`;
  const value = JSON.stringify({ version: 1, hash: digest(key) });
  if (!rotate) writeFileSync(file, value, { flag: "wx", mode: 0o600 });
  else {
    readKey(file);
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(temp, value, { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  }
  return key;
}
export class AdminAuthError extends Error {
  constructor(
    readonly status: 401 | 429,
    readonly code: "admin_unauthorized" | "admin_rate_limited",
  ) {
    super(code);
  }
}
export class AdminAuth {
  private sessions = new Map<string, { keyHash: string; expiresAt: number }>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(
    private file: string,
    readonly sessionSeconds: number,
    private now = Date.now,
  ) {
    readKey(file);
  }
  login(key: string, remote: string) {
    const now = this.now();
    for (const [id, item] of this.attempts)
      if (item.until <= now) this.attempts.delete(id);
    const attempt = this.attempts.get(remote) ?? {
      count: 0,
      until: now + 60_000,
    };
    if (this.attempts.size >= 1000 && !this.attempts.has(remote))
      throw new AdminAuthError(429, "admin_rate_limited");
    this.attempts.set(remote, attempt);
    if (++attempt.count > 10)
      throw new AdminAuthError(429, "admin_rate_limited");
    const keyHash = readKey(this.file);
    if (
      !/^acadmin_[A-Za-z0-9_-]{43}$/.test(key) ||
      !timingSafeEqual(
        Buffer.from(digest(key), "hex"),
        Buffer.from(keyHash, "hex"),
      )
    )
      throw new AdminAuthError(401, "admin_unauthorized");
    for (const [id, session] of this.sessions)
      if (session.expiresAt <= now || session.keyHash !== keyHash)
        this.sessions.delete(id);
    if (this.sessions.size >= 100)
      throw new AdminAuthError(429, "admin_rate_limited");
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(digest(token), {
      keyHash,
      expiresAt: now + this.sessionSeconds * 1000,
    });
    return token;
  }
  authenticate(token: string | undefined) {
    const id = digest(token ?? "");
    const session = this.sessions.get(id);
    if (
      !session ||
      session.expiresAt <= this.now() ||
      session.keyHash !== readKey(this.file)
    ) {
      this.sessions.delete(id);
      throw new AdminAuthError(401, "admin_unauthorized");
    }
    return { expiresAt: new Date(session.expiresAt).toISOString() };
  }
  revoke(token: string | undefined) {
    if (token) this.sessions.delete(digest(token));
  }
}
