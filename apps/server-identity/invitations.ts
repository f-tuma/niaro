import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";
import { z } from "zod";
import { IdentityError } from "./error";
export const MailSettings = z
  .strictObject({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    /** Implicit TLS from the first byte (usually port 465). */
    secure: z.boolean().default(true),
    /** Upgrade a plain connection with STARTTLS (usually port 587) and fail
     * instead of sending unencrypted when the server does not offer it. */
    starttls: z.boolean().default(false),
    from: z.email(),
    user: z.string().optional(),
    password: z.string().optional(),
  })
  .refine(
    (v) =>
      v.secure ||
      v.starttls ||
      ["localhost", "127.0.0.1", "::1"].includes(v.host),
    "Unencrypted SMTP is allowed only on loopback",
  )
  .refine((v) => !(v.secure && v.starttls), "Use either TLS or STARTTLS");
export type Mail = z.infer<typeof MailSettings>;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
/** Invitation and password-reset links share this lifetime. */
export const LINK_TTL_MS = 48 * 3600000;
/** One bounded SMTP delivery; the caller decides what a failure means. */
export async function sendMail(
  mail: Mail,
  message: { to: string; subject: string; text: string },
) {
  const transport = nodemailer.createTransport({
    host: mail.host,
    port: mail.port,
    secure: mail.secure,
    requireTLS: mail.starttls,
    auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
    connectionTimeout: 5000,
    socketTimeout: 8000,
    greetingTimeout: 5000,
  });
  try {
    await transport.sendMail({ from: mail.from, ...message });
  } finally {
    transport.close();
  }
}
/** Why a link cannot be used, as the person should hear it. */
export type InvitationProblem =
  | "invitation_invalid"
  | "invitation_expired"
  | "invitation_used"
  | "invitation_revoked";
export class Invitations {
  constructor(
    private db: DatabaseSync,
    private mail?: Mail,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_workspace_invitation (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      email TEXT NOT NULL, inviter_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, accepted_at INTEGER
    ) STRICT`);
    // Revoked invitations stay so their link can say "revoked" instead of
    // "invalid"; delivery tells the administrator how the link left the server.
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(agent_workspace_invitation)")
        .all()
        .map((c) => String(c.name)),
    );
    if (!columns.has("revoked_at"))
      db.exec(
        "ALTER TABLE agent_workspace_invitation ADD COLUMN revoked_at INTEGER",
      );
    if (!columns.has("delivery"))
      db.exec(
        "ALTER TABLE agent_workspace_invitation ADD COLUMN delivery TEXT",
      );
  }
  get mailConfigured() {
    return !!this.mail;
  }
  list(workspace: string) {
    return this.db
      .prepare(
        "SELECT id,email,expires_at AS expiresAt,coalesce(delivery,'email') AS delivery FROM agent_workspace_invitation WHERE workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>? ORDER BY expires_at DESC",
      )
      .all(workspace, Date.now()) as {
      id: string;
      email: string;
      expiresAt: number;
      delivery: "email" | "link";
    }[];
  }
  /**
   * Creates a 48 h single-use invitation. With SMTP it is emailed; without it
   * the administrator copies the link. Either way the link is returned once,
   * so it can also be passed on by hand; only its digest is stored.
   */
  async send(
    workspace: string,
    email: string,
    inviter: string,
    origin: string,
  ) {
    const row = this.db
      .prepare("SELECT name FROM agent_workspace WHERE id=?")
      .get(workspace);
    if (!row) throw new IdentityError(404, "identity_not_found");
    if (this.list(workspace).length >= 100)
      throw new IdentityError(429, "identity_limit");
    if (
      Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM agent_workspace_invitation WHERE inviter_id=? AND expires_at>?",
          )
          .get(inviter, Date.now() + LINK_TTL_MS - 3600000)!.n,
      ) >= 30
    )
      throw new IdentityError(429, "invitation_rate_limited");
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID(),
      expiresAt = Date.now() + LINK_TTL_MS,
      delivery = this.mail ? "email" : "link";
    const link = `${origin}/account/invite#${token}`;
    // A new invitation replaces an earlier pending one for the same person.
    const replaced = this.db
      .prepare(
        "SELECT id FROM agent_workspace_invitation WHERE workspace_id=? AND email=? AND accepted_at IS NULL AND revoked_at IS NULL",
      )
      .all(workspace, email)
      .map((r) => String(r.id));
    for (const old of replaced) this.revoke(workspace, old);
    this.db
      .prepare(
        "INSERT INTO agent_workspace_invitation (id,digest,workspace_id,email,inviter_id,expires_at,accepted_at,revoked_at,delivery) VALUES (?,?,?,?,?,?,NULL,NULL,?)",
      )
      .run(id, digest(token), workspace, email, inviter, expiresAt, delivery);
    if (this.mail)
      try {
        await sendMail(this.mail, {
          to: email,
          subject: `Pozvánka do ${row.name}`,
          text: `Byl/a jsi pozván/a do workspace ${row.name}.\n\nPřijmout pozvánku: ${link}\n\nPlatí 48 hodin. Pokud pozvánku nečekáš, ignoruj ji.`,
        });
      } catch {
        this.db
          .prepare("DELETE FROM agent_workspace_invitation WHERE id=?")
          .run(id);
        for (const old of replaced)
          this.db
            .prepare(
              "UPDATE agent_workspace_invitation SET revoked_at=NULL WHERE id=?",
            )
            .run(old);
        throw new IdentityError(502, "mail_delivery_failed");
      }
    return {
      ok: true as const,
      id,
      delivery,
      link,
      expiresAt,
    };
  }
  inspect(token: string) {
    return this.inspectKey("digest", digest(token));
  }
  inspectId(id: string) {
    return this.inspectKey("id", id);
  }
  private inspectKey(key: "digest" | "id", value: string) {
    const row = this.db
      .prepare(
        `SELECT i.*,w.name,w.organization_id FROM agent_workspace_invitation i JOIN agent_workspace w ON w.id=i.workspace_id WHERE i.${key}=?`,
      )
      .get(value);
    const problem = (code: InvitationProblem) => new IdentityError(410, code);
    if (!row) throw problem("invitation_invalid");
    if (row.revoked_at !== null) throw problem("invitation_revoked");
    if (row.accepted_at !== null) throw problem("invitation_used");
    if (Number(row.expires_at) <= Date.now())
      throw problem("invitation_expired");
    // A removed/demoted inviter cannot leave usable invitations behind.
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM member WHERE \"userId\"=? AND \"organizationId\"=? AND role IN ('owner','admin')",
        )
        .get(row.inviter_id!, row.organization_id!)
    )
      throw problem("invitation_revoked");
    return row as unknown as {
      id: string;
      email: string;
      workspace_id: string;
      organization_id: string;
      name: string;
      /** "link" when an administrator copied it; older rows were emailed. */
      delivery: "email" | "link" | null;
    };
  }
  accept(id: string) {
    const result = this.db
      .prepare(
        "UPDATE agent_workspace_invitation SET accepted_at=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?",
      )
      .run(Date.now(), id, Date.now());
    if (result.changes !== 1) throw new IdentityError(410, "invitation_used");
  }
  revoke(workspace: string, id: string) {
    return (
      this.db
        .prepare(
          "UPDATE agent_workspace_invitation SET revoked_at=? WHERE workspace_id=? AND id=? AND accepted_at IS NULL AND revoked_at IS NULL",
        )
        .run(Date.now(), workspace, id).changes === 1
    );
  }
}
