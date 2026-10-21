import {
  NativeTestRequestSchema,
  NativeTestReadQuerySchema,
  NativeTestListQuerySchema,
  NativeTestDetailQuerySchema,
  NativeTestDetailV2QuerySchema,
  PROCESS_NATIVE_TEST_DETAIL_PROFILE,
  NativeTestToolsQuerySchema,
} from "../../packages/protocol/process-native-testing";
import type { CatalogContext } from "./catalog-controller";
import type { createProcessNativeTesting } from "./process-native-testing-controller";
import { IdentityError } from "./error";

const PATH = "/admin/api/identity/catalog/processes/tests/native";
export function isProcessNativeTestPath(path: string) {
  return path === PATH || path.startsWith(PATH + "/");
}

/** Explicit isolated tests; reads never load the runner or resolve live sources. */
export async function handleProcessNativeTest(
  method: string,
  url: URL,
  payload: unknown,
  testing: ReturnType<typeof createProcessNativeTesting> | undefined,
  context: CatalogContext,
  signal: AbortSignal,
) {
  if (!testing) throw new IdentityError(503, "identity_unavailable");
  const path = url.pathname.slice(PATH.length);
  // Duplicate keys are ambiguous authority/identity, even when a value is valid.
  const query: Record<string, string> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key))
      throw new IdentityError(400, "identity_invalid_input");
    query[key] = value;
  }
  if (path === "" && method === "POST") {
    if (Object.keys(query).length)
      throw new IdentityError(400, "identity_invalid_input");
    return {
      job: await testing.start(
        NativeTestRequestSchema.parse(payload),
        context,
        signal,
      ),
    };
  }
  if (path === "" && method === "GET") {
    const input = NativeTestReadQuerySchema.parse(query);
    return { job: await testing.read(context, input, input.testId) };
  }
  if (path === "/list" && method === "GET") {
    const input = NativeTestListQuerySchema.parse(query);
    return testing.list(context, input);
  }
  if (path === "/detail" && method === "GET") {
    return testing.detail(
      context,
      query.profile === PROCESS_NATIVE_TEST_DETAIL_PROFILE
        ? NativeTestDetailV2QuerySchema.parse(query)
        : NativeTestDetailQuerySchema.parse(query),
    );
  }
  if (path === "/tools" && method === "GET") {
    return testing.tools(context, NativeTestToolsQuerySchema.parse(query));
  }
  throw new IdentityError(404, "not_found");
}
