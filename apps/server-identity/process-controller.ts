import {
  WORKSPACE_PROCESS_PROFILE,
  WorkspaceProcessReadQuerySchema,
  WorkspaceProcessListSchema,
  WorkspaceProcessSaveSchema,
  WorkspaceProcessValidateSchema,
  WorkspaceProcessArchiveSchema,
  WorkspaceProcessArchiveResultSchema,
  PROCESS_PROFILE,
  ProcessCommandSchema,
  ProcessReadQuerySchema,
  ProcessValidateRequestSchema,
  ProcessListSchema,
  ProcessValidationSchema,
} from "../../packages/protocol/service-processes";
import type { CatalogContext } from "./catalog-controller";
import { IdentityError } from "./error";
import type { ServiceProcessStore, ProcessActor } from "./service-processes";

/** Authenticated metadata API. It cannot test, activate, start or resume a run. */
export async function handleServiceProcesses(
  method: string,
  url: URL,
  payload: unknown,
  store: ServiceProcessStore,
  context: CatalogContext,
) {
  const path = url.pathname.slice(
    "/admin/api/identity/catalog/processes".length,
  );
  const workspace =
    url.searchParams.get("profile") === WORKSPACE_PROCESS_PROFILE;
  if (path === "" && method === "GET") {
    const query = (
      workspace ? WorkspaceProcessReadQuerySchema : ProcessReadQuerySchema
    ).parse(Object.fromEntries(url.searchParams));
    const target = {
      organizationId: query.organizationId,
      workspaceId: query.workspaceId,
    };
    return context.serial(async () => {
      const actor = await authorized(query, context);
      if (query.id) {
        if (!workspace) store.get(actor, query.id);
        return {
          profile: workspace ? WORKSPACE_PROCESS_PROFILE : PROCESS_PROFILE,
          ...target,
          ...(query.version
            ? { version: store.version(actor, query.id, query.version) }
            : {
                process: workspace
                  ? store.getOwned(actor, query.id)
                  : store.get(actor, query.id),
              }),
        };
      }
      return (workspace ? WorkspaceProcessListSchema : ProcessListSchema).parse(
        {
          profile: workspace ? WORKSPACE_PROCESS_PROFILE : PROCESS_PROFILE,
          ...target,
          ...(workspace
            ? store.listOwned(actor, query.after)
            : store.list(actor, query.after)),
        },
      );
    });
  }
  if (path === "/validate" && method === "POST") {
    if (workspace) {
      const input = WorkspaceProcessValidateSchema.parse(payload);
      return context.serial(async () =>
        ProcessValidationSchema.parse(
          store.validateOwner(
            await authorized(input, context),
            input.owner,
            input.definition,
          ),
        ),
      );
    }
    const input = ProcessValidateRequestSchema.parse(payload);
    return context.serial(async () =>
      ProcessValidationSchema.parse(
        store.validate(
          await authorized(input, context),
          input.serviceId,
          input.definition,
        ),
      ),
    );
  }
  if (path === "/archive" && method === "POST") {
    const input = WorkspaceProcessArchiveSchema.parse(payload);
    return context.serial(async () => {
      const actor = await authorized(input, context);
      return context.transaction(async () =>
        WorkspaceProcessArchiveResultSchema.parse({
          profile: WORKSPACE_PROCESS_PROFILE,
          ...store.archive(actor, input.id, input.revision),
        }),
      );
    });
  }
  if (path === "/command" && method === "POST") {
    if (workspace) {
      const input = WorkspaceProcessSaveSchema.parse(payload);
      return context.serial(async () => {
        const actor = await authorized(input, context);
        return context.transaction(async () => ({
          process: store.saveWorkspaceDraft(actor, input),
        }));
      });
    }
    const input = ProcessCommandSchema.parse(payload);
    return context.serial(async () => {
      const actor = await authorized(input, context);
      if (input.type === "freezeDraft") store.get(actor, input.id);
      return context.transaction(async () =>
        input.type === "saveDraft"
          ? { process: store.saveDraft(actor, input) }
          : {
              version: store.freezeDraft(actor, input.id, input.revision),
              process: store.get(actor, input.id),
            },
      );
    });
  }
  throw new IdentityError(404, "not_found");
}
async function authorized(
  target: { organizationId: string; workspaceId: string },
  context: CatalogContext,
): Promise<ProcessActor> {
  const actor = await context.actor(target);
  // Members may list, read, save and freeze only their own personal processes;
  // ServiceProcessStore decides per process and per owner.
  context.validateRequest?.();
  return {
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    userId: actor.userId,
    role: actor.role,
  };
}
