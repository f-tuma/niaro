import {
  ProcessActivationCommandSchema,
  ProcessActivationReadQuerySchema,
  ProcessActivationReviewQuerySchema,
} from "../../packages/protocol/process-activation";
import type { CatalogContext } from "./catalog-controller";
import type { ProcessActivationStore } from "./process-activation-store";
import { IdentityError } from "./error";

const PATH = "/admin/api/identity/catalog/processes/activation";
export function isProcessActivationPath(path: string) {
  return path === PATH || path.startsWith(PATH + "/");
}

/** Human account metadata decisions. Never exported as Agent/Domain tools. */
export async function handleProcessActivation(
  method: string,
  url: URL,
  payload: unknown,
  store: ProcessActivationStore | undefined,
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
    path === "" && method === "POST"
      ? ProcessActivationCommandSchema.parse(payload)
      : path === "" && method === "GET"
        ? ProcessActivationReadQuerySchema.parse(query)
        : path === "/review" && method === "GET"
          ? ProcessActivationReviewQuerySchema.parse(query)
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
    // All freshness checks and the metadata transaction are synchronous after
    // this authorization boundary; no inference or transport can yield here.
    if (method === "POST")
      return {
        receipt: store.decide(
          actor,
          ProcessActivationCommandSchema.parse(input),
        ),
      };
    if (path === "/review")
      return {
        review: store.review(
          actor,
          ProcessActivationReviewQuerySchema.parse(input),
        ),
      };
    return {
      receipt: store.read(
        actor,
        ProcessActivationReadQuerySchema.parse(input).requestId,
      ),
    };
  });
}
