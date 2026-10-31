import type { IncomingMessage } from "node:http";
import type { IdentityService } from "../server-identity/service";
/** Account-only paired route; no model/runtime access and no fixture person fallback. */
export async function petHttp(
  req: IncomingMessage,
  route: string,
  workspace: string,
  serverId: string,
  accountWorkspace: boolean,
  identity: Pick<IdentityService, "mobilePet"> | undefined,
  query: URLSearchParams,
  readBody: () => Promise<unknown>,
) {
  if (!accountWorkspace) return { status: 404, value: { error: "not_found" } };
  if (!identity) return { status: 406, value: { error: "pet_unsupported" } };
  if (req.method !== "GET" && req.method !== "POST")
    return { status: 405, value: { error: "method_not_allowed" } };
  const payload = req.method === "POST" ? await readBody() : undefined;
  return {
    status: 200,
    value: await identity.mobilePet(
      req.headers.authorization,
      workspace,
      serverId,
      route === "pet/memory",
      query,
      payload,
    ),
  };
}
