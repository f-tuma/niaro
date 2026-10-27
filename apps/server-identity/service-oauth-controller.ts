import { randomUUID } from "node:crypto";
import {
  CatalogTarget,
  Revision,
  ServiceSettings,
} from "../../packages/protocol/service-catalog";
import { IdentityId } from "../../packages/protocol/identity";
import {
  PersonalApprovalOption,
  PersonalApprovalRequest,
  PersonalPermissionsRequest,
  PersonalPermissionsSave,
  PersonalServicePermissions,
  OAuthScope,
  PersonalSignInList,
  ServiceOAuthClientInput,
  ServiceOAuthFinishInput,
  ServiceOAuthSettings,
  type OAuthMetadata,
  type PersonalSignIn,
  type ServiceOAuthProbe,
} from "../../packages/protocol/service-oauth";
import {
  discoverOAuth,
  exchangeOAuthCode,
  registerOAuthClient,
} from "../server-integrations/service-oauth";
import {
  IntegrationError,
  type IntegrationTransport,
} from "../server-integrations/transport";
import type { CatalogContext } from "./catalog-controller";
import type { CatalogActor, ServiceCatalogStore } from "./service-catalog";
import type { ServiceOAuthTarget } from "./service-oauth";
import { IdentityError } from "./error";
import { decideRoute } from "../server-integrations/decisions";
import { budgetedInferenceTransport } from "./inference-budget";

const Target = CatalogTarget.extend({ serviceId: IdentityId });
const ConfigTarget = Target.extend({ revision: Revision });
/** The browser's authenticated session owns consent; payloads cannot select a user. */
export async function handleServiceOAuth(
  action: string,
  payload: unknown,
  ctx: CatalogContext,
  catalog: ServiceCatalogStore,
  transport: IntegrationTransport,
  signal: AbortSignal,
) {
  const store = catalog.oauth;
  if (!store || !ctx.session)
    throw new IdentityError(403, "identity_account_required");
  const session = ctx.session;
  if (action === "finish") {
    const input = ServiceOAuthFinishInput.parse(payload);
    const prepared = await ctx.serial(async () => {
      const user = await session();
      const target = store.pendingTarget(input.state, user);
      const scope = {
        workspaceId: target.workspaceId,
        organizationId: catalog.workspaceOrganization(target.workspaceId),
      };
      const actor = await ctx.actor(scope);
      if (actor.userId !== user.userId)
        throw new IdentityError(403, "identity_forbidden");
      const claim = store.claimFromState(user, input);
      store.assertClaim(
        claim,
        user,
        catalog.oauthTarget(target.workspaceId, target.serviceId),
      );
      return { claim, scope, epoch: ctx.epoch(scope.organizationId) };
    });
    const validate = async () => {
      const user = await session(),
        actor = await ctx.actor(prepared.scope);
      if (
        actor.userId !== user.userId ||
        ctx.epoch(prepared.scope.organizationId) !== prepared.epoch
      )
        throw new IdentityError(403, "identity_forbidden");
      const target = catalog.oauthTarget(
        prepared.claim.target.workspaceId,
        prepared.claim.target.serviceId,
      );
      store.assertClaim(prepared.claim, user, target);
      return { user, target };
    };
    const tokens = await exchangeOAuthCode(transport, prepared.claim, {
      signal,
      beforeDispatch: (start) =>
        ctx.serial(async () => {
          await validate();
          signal.throwIfAborted();
          start();
        }),
    });
    return ctx.serial(async () =>
      ctx.transaction(async () => {
        const { user, target } = await validate();
        signal.throwIfAborted();
        const result = store.commitConnection(
          prepared.claim,
          tokens,
          user,
          target,
          linkedSubject(
            catalog,
            prepared.scope.organizationId,
            user.userId,
            target,
          ),
        );
        ctx.audit({
          ...prepared.scope,
          actorId: user.userId,
          source: "console",
          action: "catalog.service_changed",
          targetId: target.serviceId,
          outcome: "succeeded",
          details: {},
        });
        return { ...result, serviceId: target.serviceId };
      }),
    );
  }
  if (action === "list") {
    // Read-only and personal: every member may see their own sign-ins.
    const target = CatalogTarget.parse(payload);
    return ctx.serial(async () => {
      const actor = await ctx.actor(target),
        user = await session();
      if (actor.userId !== user.userId)
        throw new IdentityError(403, "identity_forbidden");
      return PersonalSignInList.parse({
        ...target,
        services: personalSignIns(catalog, target, actor),
      });
    });
  }
  if (action === "permissions" || action === "permissions/save") {
    // Each person manages only their own choices: the session picks the user.
    const input =
      action === "permissions/save"
        ? PersonalPermissionsSave.parse(payload)
        : undefined;
    const request = input ?? PersonalPermissionsRequest.parse(payload);
    return ctx.serial(async () => {
      const actor = await ctx.actor(request),
        user = await session();
      if (actor.userId !== user.userId)
        throw new IdentityError(403, "identity_forbidden");
      if (!input) return personalPermissions(catalog, request, actor);
      return ctx.transaction(async () => {
        personalPermissions(catalog, input, actor);
        const service = catalog.service(input.workspaceId, input.serviceId);
        const changes = input.actions.map((item) => {
          const action = service.actions.find((a) => a.id === item.actionId);
          if (
            !action?.enabled ||
            !catalog.personalAction(
              input.workspaceId,
              service.id,
              action.effect,
            )
          )
            throw new IdentityError(404, "catalog_not_found");
          return {
            action,
            choice: { enabled: item.enabled, approval: item.approval },
          };
        });
        const saved = catalog.personalPolicy.save(
          { ...input, userId: actor.userId },
          input.revision,
          changes,
        );
        // Only this person's own authority changes; running work rechecks it
        // at dispatch, so the organization epoch stays.
        if (saved.changed)
          ctx.audit({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            actorId: actor.userId,
            source: "console",
            action: "catalog.personal_policy_changed",
            targetId: input.serviceId,
            outcome: "succeeded",
            details: {
              previousRevision: saved.revision - 1,
              revision: saved.revision,
            },
          });
        return personalPermissions(catalog, input, actor);
      });
    });
  }
  if (action === "approval" || action === "approval/remember") {
    const input = PersonalApprovalRequest.parse(payload);
    return ctx.serial(async () => {
      const actor = await ctx.actor(input),
        user = await session();
      if (actor.userId !== user.userId)
        throw new IdentityError(403, "identity_forbidden");
      const found = rememberable(catalog, input, actor);
      if (action === "approval")
        return PersonalApprovalOption.parse({
          available: found?.choice.approval === "always",
        });
      // The person confirmed this change and no longer wants to be asked.
      if (!found || found.status === "rejected")
        throw new IdentityError(409, "personal_policy_unavailable");
      return ctx.transaction(async () => {
        const key = {
          ...input,
          serviceId: found.service.id,
          userId: actor.userId,
        };
        const saved = catalog.personalPolicy.save(
          key,
          catalog.personalPolicy.revision(
            input.workspaceId,
            found.service.id,
            actor.userId,
          ),
          [
            {
              action: found.action,
              choice: { enabled: true, approval: "never" },
            },
          ],
        );
        if (saved.changed)
          ctx.audit({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            actorId: actor.userId,
            source: "chat",
            action: "catalog.personal_policy_changed",
            targetId: found.service.id,
            outcome: "succeeded",
            details: {
              previousRevision: saved.revision - 1,
              revision: saved.revision,
            },
          });
        return { ok: true };
      });
    });
  }
  if (action === "auto") {
    // Re-runs the probe an added MCP service gets, for administrators.
    const input = Target.parse(payload);
    const actorId = await ctx.serial(async () => {
      const actor = await ctx.actor(input),
        user = await session();
      if (actor.userId !== user.userId || actor.role === "member")
        throw new IdentityError(403, "identity_forbidden");
      catalog.oauthTarget(input.workspaceId, input.serviceId);
      return actor.userId;
    });
    await autoConfigureOAuth(ctx, catalog, transport, input, actorId, signal);
    return ctx.serial(async () => ({
      ...store.status(
        catalog.oauthTarget(input.workspaceId, input.serviceId),
        actorId,
      ),
      redirectUri: store.redirectUri,
    }));
  }
  const input =
    action === "save"
      ? ConfigTarget.extend({
          settings: ServiceOAuthSettings,
          client: ServiceOAuthClientInput,
        }).parse(payload)
      : action === "disconnect"
        ? Target.extend({ connectionRevision: Revision }).parse(payload)
        : action === "status"
          ? Target.parse(payload)
          : ConfigTarget.parse(payload);
  const management = ["save", "discover", "register", "suggest"].includes(
    action,
  );
  const authorize = async () => {
    const actor = await ctx.actor(input),
      user = await session();
    if (actor.userId !== user.userId || (management && actor.role === "member"))
      throw new IdentityError(403, "identity_forbidden");
    // A person's own service is signed in to by its owner alone.
    const owner = catalog.service(input.workspaceId, input.serviceId).personal;
    if (owner && owner.userId !== actor.userId && !management)
      throw new IdentityError(404, "catalog_not_found");
    return {
      actor,
      user,
      target: catalog.oauthTarget(input.workspaceId, input.serviceId),
    };
  };
  const initial = await ctx.serial(async () => {
    const auth = await authorize();
    if (
      "revision" in input &&
      store.config(auth.target).revision !== input.revision
    )
      throw new IdentityError(409, "service_oauth_conflict");
    return {
      ...auth,
      epoch: ctx.epoch(input.organizationId),
      config: store.config(auth.target),
    };
  });
  const validate = async () => {
    const fresh = await authorize();
    if (
      fresh.user.sessionId !== initial.user.sessionId ||
      fresh.user.userId !== initial.user.userId ||
      fresh.target.serviceRevision !== initial.target.serviceRevision ||
      ctx.epoch(input.organizationId) !== initial.epoch ||
      store.config(fresh.target).revision !== initial.config.revision
    )
      throw new IdentityError(409, "service_oauth_conflict");
    return fresh;
  };
  const audit = () =>
    ctx.audit({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      actorId: initial.actor.userId,
      source: "console",
      action: "catalog.service_changed",
      targetId: input.serviceId,
      outcome: "succeeded",
      details: {},
    });
  if (action === "status")
    return ctx.serial(async () => {
      await validate();
      return {
        ...store.status(initial.target, initial.user.userId),
        redirectUri: store.redirectUri,
      };
    });
  if (action === "save" && "settings" in input)
    return ctx.serial(async () =>
      ctx.transaction(async () => {
        const value = ConfigTarget.extend({
          settings: ServiceOAuthSettings,
          client: ServiceOAuthClientInput,
        }).parse(payload);
        await validate();
        if (value.settings.authProviderId) {
          const provider = catalog.authProviders?.get(
            input.organizationId,
            value.settings.authProviderId,
          );
          if (
            !provider?.enabled ||
            value.settings.requiredFor === "none" ||
            // Only OpenID Connect sign-in proves which account granted access.
            (value.settings.source === "provider" &&
              provider.kind !== "microsoft" &&
              provider.kind !== "google")
          )
            throw new IdentityError(400, "auth_provider_unavailable");
        }
        const saved = store.save(
          initial.target,
          value.revision,
          value.settings,
          value.client,
        );
        // Only the sign-in hint is cosmetic. When approval mode, sign-in
        // method, scopes, client or discovered endpoints change, someone may
        // lose access, so running work is retired.
        const authority = (
          config: typeof saved,
          settings: typeof value.settings,
        ) =>
          JSON.stringify([
            { ...settings, signInHint: undefined },
            config.hasClientId,
            config.hasClientSecret,
            config.discovery,
          ]);
        if (
          value.client.clientId !== undefined ||
          value.client.clientSecret !== undefined ||
          authority(saved, value.settings) !==
            authority(initial.config, initial.config.settings)
        )
          ctx.change(input.organizationId);
        audit();
        return { ok: true };
      }),
    );
  if (action === "disconnect" && "connectionRevision" in input)
    return ctx.serial(async () =>
      ctx.transaction(async () => {
        const value = Target.extend({ connectionRevision: Revision }).parse(
          payload,
        );
        await validate();
        store.disconnect(
          initial.target,
          initial.user.userId,
          value.connectionRevision,
        );
        audit();
        return { ok: true };
      }),
    );
  if (action === "start")
    return ctx.serial(async () => {
      await validate();
      return store.start(initial.target, initial.user, initial.config.revision);
    });
  const options = {
    signal,
    beforeDispatch: (start: () => void) =>
      ctx.serial(async () => {
        await validate();
        signal.throwIfAborted();
        start();
      }),
  };
  if (action === "suggest") {
    const selected = await ctx.serial(async () => {
      await validate();
      const model = catalog.resolveDecision(
        input.organizationId,
        input.workspaceId,
      );
      if (!model) throw new IdentityError(409, "catalog_model_required");
      if (!initial.config.discovery)
        throw new IdentityError(409, "service_oauth_discovery_required");
      return model;
    });
    const checkModel = () => {
      const current = catalog.resolveDecision(
        input.organizationId,
        input.workspaceId,
      );
      if (
        !current ||
        current.model.id !== selected.model.id ||
        current.model.revision !== selected.model.revision ||
        current.provider.id !== selected.provider.id ||
        current.provider.revision !== selected.provider.revision
      )
        throw new IdentityError(409, "catalog_conflict");
    };
    // The recommendation is an inference call like any other: it reserves and
    // settles in the ledger under its own admin root.
    const budgeted = budgetedInferenceTransport(
      transport,
      catalog.inferenceBudget,
      `oauth-suggest/${input.serviceId}/${initial.config.revision}/${randomUUID()}`,
      {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        userId: initial.actor.userId,
      },
      selected,
      "decision",
      (run) => ctx.serial(run),
      validate,
      () => 0,
      { maxTokens: 10_000_000, maxCostMicros: 1_000_000_000, maxModelCalls: 1 },
    );
    const answer = await decideRoute(
      budgeted,
      selected,
      {
        service: new URL(initial.target.serviceUrl).origin,
        metadata: initial.config.discovery,
        goal: "Actions must use each user's own service account and upstream permissions.",
      },
      {
        twenty:
          "Twenty-compatible OAuth authorization code with PKCE and personal user context; api and profile scopes are available.",
        manual:
          "The available metadata is insufficient to recommend the Twenty adapter; configure the integration manually.",
      },
      signal,
      (start) =>
        ctx.serial(async () => {
          await validate();
          checkModel();
          signal.throwIfAborted();
          catalog.useProvider(
            input.organizationId,
            selected.provider.id,
            selected.provider.revision,
          );
          start();
        }),
      "Recommend a supported authentication adapter from these two choices based on the supplied metadata. OAuth metadata does not identify the upstream SSO provider. Never infer Microsoft, grant access, change role policy, or suggest shared credentials for personal writes. Choose manual when uncertain.",
    );
    return ctx.serial(async () => {
      await validate();
      checkModel();
      return {
        adapter: answer.confidence >= 0.8 ? answer.choice : "manual",
        confidence: answer.confidence,
      };
    });
  }
  if (action === "discover") {
    if (initial.config.settings.source === "provider")
      throw new IdentityError(409, "service_oauth_discovery_unsupported");
    const metadata = await discoverOAuth(
      transport,
      initial.target.serviceUrl,
      options,
    );
    return ctx.serial(async () =>
      ctx.transaction(async () => {
        await validate();
        signal.throwIfAborted();
        store.setDiscovery(initial.target, initial.config.revision, metadata);
        ctx.change(input.organizationId);
        audit();
        return { ok: true };
      }),
    );
  }
  if (action === "register") {
    const snapshot = await ctx.serial(async () => {
      await validate();
      return store.registration(initial.target, initial.config.revision);
    });
    let auditId: number | undefined;
    try {
      const client = await registerOAuthClient(transport, snapshot, {
        signal,
        beforeDispatch: (start) =>
          ctx.serial(async () => {
            await validate();
            signal.throwIfAborted();
            auditId = ctx.audit({
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              actorId: initial.user.userId,
              source: "console",
              action: "catalog.service_changed",
              targetId: input.serviceId,
              outcome: "running",
              details: {},
            });
            start();
          }),
      });
      return await ctx.serial(async () =>
        ctx.transaction(async () => {
          const fresh = await validate();
          signal.throwIfAborted();
          store.commitRegistration(snapshot, client, fresh.target);
          ctx.change(input.organizationId);
          if (auditId) ctx.finish(auditId, "succeeded", {});
          return { ok: true };
        }),
      );
    } catch (error) {
      if (auditId)
        await ctx.serial(async () => {
          ctx.finish(auditId!, "unknown", {});
        });
      throw error;
    }
  }
  throw new IdentityError(404, "not_found");
}

/** One probe per service at a time; a concurrent caller joins the running one. */
const probes = new WeakMap<ServiceCatalogStore, Map<string, Promise<void>>>();
/**
 * What adding an MCP service by URL does on its own, like a connector flow:
 * looks for the service's OAuth metadata (the same guarded discovery as
 * "Detect OAuth": protected-resource metadata, then the authorization server
 * it names or the service origin), and when it finds some and nobody set up
 * personal sign-in yet, requires the person's own account for every action
 * through the service's own OAuth with the scopes the metadata advertises
 * (Twenty: api profile), registering Agent Server as a client when the
 * metadata has a registration endpoint. Idempotent: an existing client,
 * discovered metadata or settings an administrator already changed stay;
 * a service that is not MCP, or signs in through an organization method, is
 * left alone. Nothing is ever registered at an origin other than the one the
 * administrator typed or the authorization server its protected-resource
 * metadata names (what `discoverOAuth` allows). Failures are silent: the
 * status records `lastProbe` with a short reason. Every run that looked at
 * the network writes one audit entry. The request signal bounds the probe.
 */
export function autoConfigureOAuth(
  ctx: CatalogContext,
  catalog: ServiceCatalogStore,
  transport: IntegrationTransport,
  target: { organizationId: string; workspaceId: string; serviceId: string },
  actorId: string,
  signal: AbortSignal,
) {
  let runs = probes.get(catalog);
  if (!runs) {
    runs = new Map();
    probes.set(catalog, runs);
  }
  const key = `${target.workspaceId}/${target.serviceId}`;
  const running = runs.get(key);
  if (running) return running;
  const run = probeOAuth(ctx, catalog, transport, target, actorId, signal);
  runs.set(key, run);
  return run.finally(() => {
    if (runs.get(key) === run) runs.delete(key);
  });
}
/**
 * Personal sign-in makes the service gate decide who may connect. A gate that
 * was never set becomes an explicit one for every organization role, so
 * owners and administrators see the service under Connections too; a gate an
 * administrator set stays as it is (the console says who it lets in).
 */
function openGate(
  catalog: ServiceCatalogStore,
  target: { organizationId: string; workspaceId: string; serviceId: string },
) {
  const service = catalog.service(target.workspaceId, target.serviceId);
  if (service.access) return;
  const {
    id,
    revision,
    hasCredential: _credential,
    modelId: _model,
    actions: _actions,
    ...settings
  } = service;
  catalog.command({
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    type: "saveService",
    id,
    revision,
    settings: ServiceSettings.parse({
      ...settings,
      access: { roles: ["owner", "admin", "member"], workspaceRoles: [] },
    }),
  });
}
/** Scopes the metadata advertises, as the settings accept them; none means the defaults. */
function advertisedScopes(metadata: OAuthMetadata) {
  const scopes = metadata.scopes
    .filter((scope) => OAuthScope.safeParse(scope).success)
    .slice(0, 30);
  return scopes.length ? [...new Set(scopes)] : undefined;
}
function probeReason(error: unknown): string {
  const code =
    error instanceof IdentityError || error instanceof IntegrationError
      ? error.code
      : error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "probe_failed";
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "probe_failed";
}
async function probeOAuth(
  ctx: CatalogContext,
  catalog: ServiceCatalogStore,
  transport: IntegrationTransport,
  target: { organizationId: string; workspaceId: string; serviceId: string },
  actorId: string,
  signal: AbortSignal,
) {
  const store = catalog.oauth;
  if (!store) return;
  const initial = await ctx.serial(async () => {
    const service = catalog.service(target.workspaceId, target.serviceId);
    const oauthTarget = catalog.oauthTarget(target.workspaceId, service.id);
    return { service, target: oauthTarget, config: store.config(oauthTarget) };
  });
  const { discovery, hasClientId, settings } = initial.config;
  if (
    initial.service.protocol !== "mcp" ||
    settings.source === "provider" ||
    (discovery && (hasClientId || !discovery.registrationEndpoint))
  )
    return;
  let revision = initial.config.revision;
  // The address is what the probe is about; the service's own revision moves
  // with every imported action and must not cancel it.
  const validate = async () => {
    const current = catalog.oauthTarget(target.workspaceId, target.serviceId);
    if (
      current.serviceUrl !== initial.target.serviceUrl ||
      store.config(current).revision !== revision
    )
      throw new IdentityError(409, "service_oauth_conflict");
    return current;
  };
  const options = {
    signal,
    beforeDispatch: (start: () => void) =>
      ctx.serial(async () => {
        await validate();
        signal.throwIfAborted();
        start();
      }),
  };
  const record = (
    current: ServiceOAuthTarget,
    outcome: ServiceOAuthProbe["outcome"],
    reason?: string,
  ) => {
    store.recordProbe(current, revision, {
      at: Date.now(),
      outcome,
      ...(reason ? { reason } : {}),
    });
    ctx.audit({
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      actorId,
      source: "console",
      action: "catalog.service_changed",
      targetId: target.serviceId,
      outcome: "succeeded",
      details: { oauthProbe: outcome },
    });
  };
  const finish = (outcome: ServiceOAuthProbe["outcome"], reason?: string) =>
    ctx.serial(() =>
      ctx.transaction(async () => {
        record(await validate(), outcome, reason);
      }),
    );
  // A changed address leaves metadata and client of the old origin behind.
  await ctx.serial(() =>
    ctx.transaction(async () => {
      await validate();
      revision = store.rebase(initial.target, revision).revision;
    }),
  );
  let metadata = discovery;
  if (!metadata) {
    let found: OAuthMetadata;
    try {
      found = await discoverOAuth(
        transport,
        initial.target.serviceUrl,
        options,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      await finish("none", probeReason(error));
      return;
    }
    metadata = found;
    await ctx.serial(() =>
      ctx.transaction(async () => {
        await validate();
        revision = store.setDiscovery(initial.target, revision, found).revision;
        const current = store.config(initial.target);
        // Settings only where nobody configured personal sign-in yet and the
        // service has no shared key: one an administrator runs on a key keeps
        // it (and its role grants) until they choose personal sign-in.
        const service = catalog.service(target.workspaceId, target.serviceId);
        if (
          current.settings.requiredFor === "none" &&
          !current.hasClientId &&
          // A shared key needs bearer or header auth; "none" stores none.
          service.auth.type === "none"
        ) {
          // A person's own server is asked for no scope, so it grants its
          // default (Notion advertises an administrative scope next to it);
          // an administrator's takes what it advertises, else Twenty's.
          const scopes = service.personal ? [] : advertisedScopes(found);
          revision = store.save(
            initial.target,
            revision,
            {
              requiredFor: "all",
              source: "service",
              signInHint: "service",
              ...(scopes ? { scopes } : {}),
            },
            {},
          ).revision;
          if (!service.personal) openGate(catalog, target);
        }
        ctx.change(target.organizationId);
      }),
    );
  }
  const current = await ctx.serial(async () => {
    await validate();
    return store.config(initial.target);
  });
  if (current.hasClientId) {
    await finish("configured");
    return;
  }
  if (!metadata.registrationEndpoint) {
    await finish("metadata", "service_oauth_registration_unsupported");
    return;
  }
  const snapshot = await ctx.serial(async () => {
    await validate();
    return store.registration(initial.target, revision);
  });
  let client: Awaited<ReturnType<typeof registerOAuthClient>>;
  try {
    client = await registerOAuthClient(transport, snapshot, options);
  } catch (error) {
    if (signal.aborted) throw error;
    await finish("metadata", probeReason(error));
    return;
  }
  await ctx.serial(() =>
    ctx.transaction(async () => {
      const fresh = await validate();
      revision = store.commitRegistration(snapshot, client, fresh).revision;
      record(fresh, "configured");
      ctx.change(target.organizationId);
    }),
  );
}

/** For a sign-in method source, the account the person linked; otherwise none is needed. */
export function linkedSubject(
  catalog: ServiceCatalogStore,
  organizationId: string,
  userId: string,
  target: ReturnType<ServiceCatalogStore["oauthTarget"]>,
) {
  const settings = catalog.oauth!.config(target).settings;
  if (settings.source !== "provider" || !settings.authProviderId)
    return undefined;
  if (!catalog.authProviders)
    throw new IdentityError(403, "auth_provider_unavailable");
  return catalog.authProviders.assertLinked(
    organizationId,
    userId,
    settings.authProviderId,
  ).subject;
}

/**
 * Services the person may act through that ask for their own account, with the
 * state of that sign-in. Uses the same access rules as their catalog view, so
 * an administrator sees only services whose actions they may run, too.
 */
export function personalSignIns(
  catalog: ServiceCatalogStore,
  target: { organizationId: string; workspaceId: string },
  actor: CatalogActor,
): PersonalSignIn[] {
  const store = catalog.oauth;
  if (!store) return [];
  // The stored catalog, not the person's projection: switching off all their
  // own actions must not hide the service they would switch them back on in.
  return catalog
    .inventory(target.organizationId, target.workspaceId, {
      ...actor,
      role: "owner",
    })
    .services.filter(
      (service) =>
        // A person's own service is signed in to from My services.
        !service.personal &&
        (catalog.mayConnect(target.workspaceId, service, actor) ||
          (service.enabled &&
            service.actions.some(
              (action) => action.enabled && catalog.allowed(action, actor),
            ))),
    )
    .flatMap((service): PersonalSignIn[] => {
      const status = store.status(
        catalog.oauthTarget(target.workspaceId, service.id),
        actor.userId,
      );
      const settings = status.config.settings;
      if (settings.requiredFor === "none") return [];
      let ready = !!status.config.discovery && status.config.hasClientId,
        connection = status.connection.status,
        provider: PersonalSignIn["provider"] = null;
      if (settings.authProviderId) {
        // Like the app's connection status: an unlinked sign-in method means
        // the person still has to sign in, a disabled one that nobody can.
        try {
          const linked = catalog.authProviders!.linkedStatus(
            target.organizationId,
            actor.userId,
            settings.authProviderId,
          );
          provider = { name: linked.name, kind: linked.kind };
          if (!linked.linked) connection = "disconnected";
        } catch {
          ready = false;
          connection = "disconnected";
        }
      }
      const identity = status.connection.identity;
      return [
        {
          serviceId: service.id,
          name: service.name,
          icon: service.icon,
          iconSource: service.iconSource,
          requiredFor: settings.requiredFor,
          ready,
          provider,
          status: connection,
          account:
            identity && "label" in identity ? (identity.label ?? null) : null,
          expiresAt:
            connection === "disconnected" ? null : status.connection.expiresAt,
          configRevision: status.config.revision,
          connectionRevision: status.connection.revision,
        },
      ];
    });
}

/**
 * The personal actions of one service the person may connect to, with their
 * own choices. Hidden (404) when they may not connect: paused service, the
 * service gate, no personal sign-in or every personal action blocked.
 */
export function personalPermissions(
  catalog: ServiceCatalogStore,
  target: { organizationId: string; workspaceId: string; serviceId: string },
  actor: CatalogActor,
) {
  const service = catalog.service(target.workspaceId, target.serviceId);
  // A service the person connected themselves is theirs to manage in full.
  const requiredFor = service.personal
    ? service.personal.userId === actor.userId
      ? ("all" as const)
      : undefined
    : catalog.oauth?.requiredFor(target.workspaceId, service.id);
  if (
    !requiredFor ||
    requiredFor === "none" ||
    (!service.personal &&
      !catalog.mayConnect(target.workspaceId, service, actor))
  )
    throw new IdentityError(404, "catalog_not_found");
  return PersonalServicePermissions.parse({
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    serviceId: service.id,
    name: service.name,
    requiredFor,
    revision: catalog.personalPolicy.revision(
      target.workspaceId,
      service.id,
      actor.userId,
    ),
    // The owner finds, describes and removes the actions of an approved own
    // service, unless administrators keep that to themselves.
    ...(service.personal?.status === "active" &&
    catalog.personalManagement(target.workspaceId) === "owner"
      ? { manage: true, serviceRevision: service.revision }
      : {}),
    actions: service.actions.flatMap((action) => {
      const choice = action.enabled
        ? catalog.personalChoice(
            target.workspaceId,
            service.id,
            action,
            actor.userId,
          )
        : undefined;
      return choice
        ? [
            {
              id: action.id,
              ...(service.personal ? { revision: action.revision } : {}),
              name: action.name,
              description: action.description,
              effect: action.effect,
              ...choice,
            },
          ]
        : [];
    }),
  });
}

/** The personal write behind one of the person's own operations, when they
 * may still change how it is confirmed. */
function rememberable(
  catalog: ServiceCatalogStore,
  target: { organizationId: string; workspaceId: string; operationId: string },
  actor: CatalogActor,
) {
  const receipt = catalog.invocation(
    target.operationId,
    target.workspaceId,
    actor.userId,
  );
  if (
    !receipt ||
    receipt.organizationId !== target.organizationId ||
    receipt.effect !== "write"
  )
    return undefined;
  try {
    const service = catalog.service(target.workspaceId, receipt.serviceId);
    const action = service.actions.find((a) => a.id === receipt.actionId);
    const choice =
      action?.enabled && catalog.mayConnect(target.workspaceId, service, actor)
        ? catalog.personalChoice(
            target.workspaceId,
            service.id,
            action,
            actor.userId,
          )
        : undefined;
    return action && choice?.enabled
      ? { service, action, choice, status: receipt.status }
      : undefined;
  } catch {
    return undefined;
  }
}
