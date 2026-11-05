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

/**
 * The connection failed before a byte of the request left this server, so
 * the provider provably never saw it. Only this error lets a model call fall
 * back to the next model of its role; it keeps the ordinary code.
 */
export class RequestNotSent extends IntegrationError {
  readonly notSent = true;
  constructor() {
    super("integration_unavailable", 502);
  }
}
