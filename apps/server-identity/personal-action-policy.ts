import type { DatabaseSync } from "node:sqlite";
import { IdentityError } from "./error";

/** What one person lets the assistant do with one action of a service they
 * signed in to with their own account. */
export type PersonalChoice = {
  enabled: boolean;
  approval: "always" | "never";
};

/**
 * Until the person decides otherwise: reads run, changes run only after they
 * confirm each one. Nothing writes without approval until they choose so.
 */
export function personalDefault(effect: "read" | "write"): PersonalChoice {
  return { enabled: true, approval: effect === "write" ? "always" : "never" };
}

/** Reads never wait for approval under a person's own account. */
function normalized(
  effect: "read" | "write",
  choice: PersonalChoice,
): PersonalChoice {
  return {
    enabled: choice.enabled,
    approval: effect === "read" ? "never" : choice.approval,
  };
}

export type PersonalPolicyKey = {
  organizationId: string;
  workspaceId: string;
  serviceId: string;
  userId: string;
};

/**
 * Per-person overlay on a personal-sign-in service's actions. Only differences
 * from the defaults are stored; the per-service revision is that person's own
 * authority for the service (it never moves the organization policy epoch).
 * Synchronous; callers hold the identity queue/transaction and authorize.
 * Disconnecting the account keeps the overlay, so reconnecting restores it.
 */
export class PersonalActionPolicyStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_personal_action_policy (
      organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, service_id TEXT NOT NULL,
      user_id TEXT NOT NULL, action_id TEXT NOT NULL, enabled INTEGER NOT NULL,
      approval TEXT NOT NULL CHECK(approval IN ('always','never')), updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,service_id,user_id,action_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_personal_action_revision (
      organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL, service_id TEXT NOT NULL,
      user_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,service_id,user_id)
    ) STRICT;`);
  }
  revision(workspaceId: string, serviceId: string, userId: string) {
    return Number(
      this.db
        .prepare(
          "SELECT revision FROM agent_personal_action_revision WHERE workspace_id=? AND service_id=? AND user_id=?",
        )
        .get(workspaceId, serviceId, userId)?.revision ?? 0,
    );
  }
  choice(
    workspaceId: string,
    serviceId: string,
    userId: string,
    action: { id: string; effect: "read" | "write" },
  ): PersonalChoice {
    const row = this.db
      .prepare(
        "SELECT enabled,approval FROM agent_personal_action_policy WHERE workspace_id=? AND service_id=? AND user_id=? AND action_id=?",
      )
      .get(workspaceId, serviceId, userId, action.id);
    return row
      ? normalized(action.effect, {
          enabled: row.enabled === 1,
          approval: row.approval === "never" ? "never" : "always",
        })
      : personalDefault(action.effect);
  }
  /**
   * Applies the person's changes when `expectedRevision` is current. A repeated
   * request whose changes are already in place succeeds without another
   * revision, so a retry after a lost response is harmless.
   */
  save(
    key: PersonalPolicyKey,
    expectedRevision: number,
    changes: {
      action: { id: string; effect: "read" | "write" };
      choice: PersonalChoice;
    }[],
  ) {
    const current = this.revision(key.workspaceId, key.serviceId, key.userId);
    const pending = changes.filter(({ action, choice }) => {
      const before = this.choice(
        key.workspaceId,
        key.serviceId,
        key.userId,
        action,
      );
      const after = normalized(action.effect, choice);
      return (
        before.enabled !== after.enabled || before.approval !== after.approval
      );
    });
    if (!pending.length) return { revision: current, changed: false };
    if (current !== expectedRevision)
      throw new IdentityError(409, "personal_policy_conflict");
    const now = Date.now();
    for (const { action, choice } of pending) {
      const value = normalized(action.effect, choice);
      const fallback = personalDefault(action.effect);
      if (
        value.enabled === fallback.enabled &&
        value.approval === fallback.approval
      )
        this.db
          .prepare(
            "DELETE FROM agent_personal_action_policy WHERE workspace_id=? AND service_id=? AND user_id=? AND action_id=?",
          )
          .run(key.workspaceId, key.serviceId, key.userId, action.id);
      else
        this.db
          .prepare(
            `INSERT INTO agent_personal_action_policy VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(workspace_id,service_id,user_id,action_id) DO UPDATE SET enabled=excluded.enabled,approval=excluded.approval,updated_at=excluded.updated_at`,
          )
          .run(
            key.organizationId,
            key.workspaceId,
            key.serviceId,
            key.userId,
            action.id,
            value.enabled ? 1 : 0,
            value.approval,
            now,
          );
    }
    this.db
      .prepare(
        `INSERT INTO agent_personal_action_revision VALUES (?,?,?,?,1)
        ON CONFLICT(workspace_id,service_id,user_id) DO UPDATE SET revision=revision+1`,
      )
      .run(key.organizationId, key.workspaceId, key.serviceId, key.userId);
    return { revision: current + 1, changed: true };
  }
  /** Forgets everyone's choices for a removed service. */
  removeService(workspaceId: string, serviceId: string) {
    for (const table of [
      "agent_personal_action_policy",
      "agent_personal_action_revision",
    ])
      this.db
        .prepare(`DELETE FROM ${table} WHERE workspace_id=? AND service_id=?`)
        .run(workspaceId, serviceId);
  }
  /** Forgets everyone's choice for a removed action. */
  removeAction(workspaceId: string, serviceId: string, actionId: string) {
    this.db
      .prepare(
        "DELETE FROM agent_personal_action_policy WHERE workspace_id=? AND service_id=? AND action_id=?",
      )
      .run(workspaceId, serviceId, actionId);
  }
}
