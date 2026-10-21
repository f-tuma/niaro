import { CatalogTarget } from "../../packages/protocol/service-catalog";
import {
  WORKSPACE_DESIGN_PROFILE,
  WorkspaceDesignStartSchema,
  DESIGN_PROFILE,
  DesignReadSchema,
  DesignStartSchema,
  DesignUpdateSchema,
  DesignAcknowledgeSchema,
  DesignAcceptSchema,
  DesignSessionListSchema,
  DesignServiceDraftListSchema,
} from "../../packages/protocol/process-design";
import { IdentityId } from "../../packages/protocol/identity";
import { z } from "zod";
import type { CatalogContext } from "./catalog-controller";
import type { ProcessActor, ServiceProcessStore } from "./service-processes";
import type { ProcessDesignStore } from "./process-design-store";
import type { ProcessDesignConversation } from "./process-design-conversation";
import type { ServiceCatalogStore } from "./service-catalog";
import type { WorkspacePluginStore } from "./workspace-plugins";
import { designCapabilities } from "./process-design-capabilities";
import { IdentityError } from "./error";

export const PROCESS_DESIGN_PATH =
  "/admin/api/identity/catalog/processes/design";
export const isProcessDesignPath = (path: string) =>
  path === PROCESS_DESIGN_PATH || path.startsWith(PROCESS_DESIGN_PATH + "/");
const capabilityQuery = CatalogTarget.extend({
  after: z.string().max(1024).optional(),
});

/** Native turns own their short queue sections; never queue the whole inference. */
export async function handleProcessDesign(
  method: string,
  url: URL,
  payload: unknown,
  input: {
    proposals: ProcessDesignStore;
    conversation?: ProcessDesignConversation;
    registry: ServiceProcessStore;
    catalog: ServiceCatalogStore;
    plugins: WorkspacePluginStore;
  },
  context: CatalogContext,
  signal: AbortSignal,
) {
  if (!isProcessDesignPath(url.pathname))
    throw new IdentityError(404, "not_found");
  const path = url.pathname.slice(PROCESS_DESIGN_PATH.length);
  const workspace =
    url.searchParams.get("profile") === WORKSPACE_DESIGN_PROFILE;
  const profile = workspace ? WORKSPACE_DESIGN_PROFILE : DESIGN_PROFILE;
  const query = () =>
    Object.fromEntries(
      [...url.searchParams].filter(([key]) => key !== "profile"),
    );
  const review = (current: ProcessActor, sessionId: string) =>
    workspace
      ? input.proposals.getWorkspace(current, sessionId)
      : input.proposals.get(current, sessionId);
  if (path === "/capabilities" && method === "GET") {
    const request = capabilityQuery.parse(query());
    return context.serial(async () => ({
      profile,
      capabilities: designCapabilities(
        input.catalog,
        input.plugins,
        await actor(request, context),
        {
          after: request.after,
          limits: input.registry.effectiveLimits(),
        },
      ),
    }));
  }
  if (path === "/sessions/list" && method === "GET") {
    if (workspace) throw new IdentityError(404, "not_found");
    const request = CatalogTarget.extend({
      serviceId: IdentityId,
      after: IdentityId.optional(),
    }).parse(query());
    return context.serial(async () => {
      const current = await actor(request, context);
      input.catalog.service(current.workspaceId, request.serviceId);
      const { sessions, nextAfter } = input.proposals.listServiceSessions(
        current,
        request.serviceId,
        request.after,
      );
      return DesignSessionListSchema.parse({
        profile,
        organizationId: current.organizationId,
        workspaceId: current.workspaceId,
        serviceId: request.serviceId,
        sessions,
        nextAfter,
      });
    });
  }
  if (path === "/drafts/list" && method === "GET") {
    if (workspace) throw new IdentityError(404, "not_found");
    const request = CatalogTarget.extend({
      serviceId: IdentityId,
      after: IdentityId.optional(),
    }).parse(query());
    return context.serial(async () => {
      const current = await actor(request, context);
      input.catalog.service(current.workspaceId, request.serviceId);
      const { drafts, nextAfter } = input.registry.listServiceOwned(
        current,
        request.serviceId,
        request.after,
      );
      return DesignServiceDraftListSchema.parse({
        profile,
        organizationId: current.organizationId,
        workspaceId: current.workspaceId,
        serviceId: request.serviceId,
        drafts,
        nextAfter,
      });
    });
  }
  if (path === "" && method === "GET") {
    const request = DesignReadSchema.parse(query());
    return context.serial(async () => ({
      profile,
      review: review(await actor(request, context), request.sessionId),
    }));
  }
  if (
    method === "POST" &&
    ["/start", "/update", "/acknowledge", "/accept"].includes(path)
  ) {
    const request =
      path === "/start"
        ? (workspace ? WorkspaceDesignStartSchema : DesignStartSchema).parse(
            payload,
          )
        : path === "/update"
          ? DesignUpdateSchema.parse(payload)
          : path === "/acknowledge"
            ? DesignAcknowledgeSchema.parse(payload)
            : DesignAcceptSchema.parse(payload);
    return context.serial(async () => {
      const current = await actor(request, context);
      if (path !== "/start" && "sessionId" in request)
        review(current, request.sessionId);
      const receipt =
        path === "/start"
          ? input.proposals.start(current, request)
          : path === "/update"
            ? input.proposals.update(current, request)
            : path === "/acknowledge"
              ? input.proposals.acknowledge(current, request)
              : input.proposals.accept(current, request);
      return {
        profile,
        receipt,
        review: review(current, receipt.sessionId),
      };
    });
  }
  if (
    (path === "/turns" && ["GET", "POST"].includes(method)) ||
    (path === "/turns/list" && method === "GET")
  ) {
    if (!input.conversation)
      throw new IdentityError(503, "identity_unavailable");
    const sessionId =
      method === "POST"
        ? z.object({ sessionId: z.string() }).parse(payload).sessionId
        : z.object({ sessionId: z.string() }).parse(query()).sessionId;
    await context.serial(async () =>
      review(
        await actor(
          z
            .object({ organizationId: z.string(), workspaceId: z.string() })
            .parse(method === "POST" ? payload : query()),
          context,
        ),
        sessionId,
      ),
    );
    if (path === "/turns/list")
      return {
        profile,
        turns: await input.conversation.list(context, query()),
      };
    return {
      profile,
      turn:
        method === "POST"
          ? await input.conversation.message(context, payload, signal)
          : await input.conversation.get(context, query()),
    };
  }
  throw new IdentityError(404, "not_found");
}
async function actor(
  target: { organizationId: string; workspaceId: string },
  context: CatalogContext,
): Promise<ProcessActor> {
  context.validateRequest?.();
  const current = await context.actor(target);
  context.validateRequest?.();
  // Members may design personal processes only; the proposal store and the
  // registry enforce that per session and per process.
  return {
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    userId: current.userId,
    role: current.role,
  };
}
