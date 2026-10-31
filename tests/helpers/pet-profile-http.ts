import { coordinatorHttpFixture } from "./process-coordinator-http";
/** Real paired HTTP fixture; all identity/model/service data is synthetic. */
export async function petProfileHttpFixture(
  options: { allowOrdinaryRuntime?: boolean } = {},
) {
  return coordinatorHttpFixture({ testSavedMemory: true, ...options });
}
