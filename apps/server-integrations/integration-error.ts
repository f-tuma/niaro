import type { ActionFailure } from "../../packages/protocol/action-failure";

export class IntegrationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly failure?: ActionFailure,
  ) {
    super(code);
  }
}
