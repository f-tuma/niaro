import {
  ProcessFreezeCommandSchema,
  ProcessFreezeReadQuerySchema,
  ProcessVersionListQuerySchema,
} from "../../packages/protocol/process-versions";
import type { CatalogContext } from "./catalog-controller";
import type { ProcessVersionsStore } from "./process-versions-store";
import { IdentityError } from "./error";

const PATH = "/admin/api/identity/catalog/processes/versions";
export function isProcessVersionsPath(path: string) {
  return path === PATH || path.startsWith(PATH + "/");
}

/** Human metadata commands and passive immutable artifact history. */
export async function handleProcessVersions(
  method: string,
  url: URL,
  payload: unknown,
  store: ProcessVersionsStore | undefined,
  context: CatalogContext,
) {
  if (!store) throw new IdentityError(503, "identity_unavailable");
  const path = url.pathname.slice(PATH.length);
  const query: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key))
      throw new IdentityError(400, "identity_invalid_input");
    query[key] = value;
  }
  const input =
    path === "/freeze" && method === "POST"
      ? ProcessFreezeCommandSchema.parse(payload)
      : path === "/freeze" && method === "GET"
        ? ProcessFreezeReadQuerySchema.parse(query)
        : path === "" && method === "GET"
          ? ProcessVersionListQuerySchema.parse(query)
          : undefined;
  if (!input) throw new IdentityError(404, "not_found");
  if (method === "POST" && Object.keys(query).length)
    throw new IdentityError(400, "identity_invalid_input");
  return context.serial(async () => {
    context.validateRequest?.();
    const current = await context.actor(input);
    // Members reach only their own personal processes: the registry decides
    // per process (read, manage) inside the store.
    context.validateRequest?.();
    const actor = {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      userId: current.userId,
      role: current.role,
    };
    if (method === "POST")
      return {
        receipt: store.freeze(actor, ProcessFreezeCommandSchema.parse(input)),
      };
    if (path === "/freeze")
      return {
        receipt: store.read(
          actor,
          ProcessFreezeReadQuerySchema.parse(input).requestId,
        ),
      };
    return store.list(actor, ProcessVersionListQuerySchema.parse(input));
  });
}
