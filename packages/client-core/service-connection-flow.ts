import type { ClientSession } from "./session";

/** What one connection card shows; the card owns copy and controls. */
export type ServiceConnectionPhase =
  | "loading"
  | "disconnected"
  | "starting"
  | "pending"
  | "cancelling"
  | "connected"
  | "expired"
  | "cancelled"
  | "error"
  | "unavailable";
/** How this platform opens the provider's page and hears that it came back. */
export type ConnectionPlatform = {
  open(url: string): Promise<unknown>;
  /** Optional: a signal to check the status at once instead of waiting. */
  onReturn?(listener: () => void): { remove: () => void };
};
export type ConnectionState = {
  phase: ServiceConnectionPhase;
  openFailed?: boolean;
  statusFailed?: boolean;
  cancelFailed?: boolean;
};
type Attempt = {
  attemptId: string;
  authorizationUrl: string;
  expiresAt: number;
};
type ConnectionResponse = Awaited<
  ReturnType<ClientSession["serviceConnection"]>
>;

/** An instance owns one card's requests. Disposal never cancels a remote grant. */
export class ConnectionFlow {
  state: ConnectionState = { phase: "loading" };
  private request = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private attempt?: Attempt;
  private disposed = false;

  private returned?: { remove: () => void };
  constructor(
    readonly session: ClientSession,
    readonly serviceId: string,
    private notify: (state: ConnectionState) => void,
    /** Only a connection completed by this card's own attempt continues the request. */
    private connected?: () => void,
    private platform: ConnectionPlatform = { open: async () => {} },
  ) {}

  private publish(state: ConnectionState) {
    if (this.disposed) return;
    this.state = state;
    this.notify(state);
  }
  private stopRequests() {
    this.request.abort();
    clearTimeout(this.timer);
    clearTimeout(this.expiry);
    this.request = new AbortController();
    return this.request.signal;
  }
  private current(signal: AbortSignal) {
    return !this.disposed && !signal.aborted;
  }
  private terminal(result: ConnectionResponse): ServiceConnectionPhase | null {
    if ("authorizationUrl" in result)
      throw Error("Unexpected connection response");
    if (result.status === "connected") return "connected";
    if (result.flow === "cancelled") return "cancelled";
    if (!result.ready) return "unavailable";
    return null;
  }
  private finish(phase: ServiceConnectionPhase) {
    const own = !!this.attempt;
    this.stopRequests();
    this.attempt = undefined;
    this.returned?.remove();
    this.returned = undefined;
    this.publish({ phase });
    if (own && phase === "connected" && !this.disposed) this.connected?.();
  }
  private expire(signal: AbortSignal) {
    this.expiry = setTimeout(
      () => {
        if (this.current(signal)) this.finish("expired");
      },
      Math.max(0, this.attempt!.expiresAt - Date.now()),
    );
  }
  async load() {
    this.publish({ phase: "loading" });
    const signal = this.request.signal;
    try {
      const result = await this.session.serviceConnection(
        "status",
        this.serviceId,
        signal,
      );
      if (!this.current(signal)) return;
      if ("authorizationUrl" in result)
        throw Error("Unexpected connection response");
      this.publish({ phase: this.terminal(result) ?? result.status });
    } catch {
      if (this.current(signal)) this.publish({ phase: "error" });
    }
  }
  async start() {
    if (
      this.disposed ||
      !["disconnected", "expired", "cancelled", "error"].includes(
        this.state.phase,
      )
    )
      return;
    const signal = this.stopRequests();
    this.publish({ phase: "starting" });
    try {
      const result = await this.session.serviceConnection(
        "start",
        this.serviceId,
        signal,
      );
      if (!this.current(signal)) return;
      if (!("authorizationUrl" in result))
        throw Error("Unexpected connection response");
      this.attempt = result;
      if (result.expiresAt <= Date.now()) return this.finish("expired");
      this.publish({ phase: "pending" });
      this.expire(signal);
      this.schedule(signal);
      // The browser page returns through the app link; check at once instead of waiting.
      this.returned?.remove();
      this.returned = this.platform.onReturn?.(() => {
        if (this.attempt) {
          clearTimeout(this.timer);
          void this.poll(this.request.signal);
        }
      });
      void this.open();
    } catch {
      if (this.current(signal)) this.finish("error");
    }
  }
  async open() {
    if (this.disposed || this.state.phase !== "pending" || !this.attempt)
      return;
    const signal = this.request.signal;
    if (this.attempt.expiresAt <= Date.now()) return this.finish("expired");
    try {
      await this.platform.open(this.attempt.authorizationUrl);
      if (this.current(signal))
        this.publish({ ...this.state, openFailed: false });
    } catch {
      if (this.current(signal))
        this.publish({ ...this.state, openFailed: true });
    }
  }
  private schedule(signal: AbortSignal) {
    this.timer = setTimeout(() => void this.poll(signal), 2500);
  }
  private async poll(signal: AbortSignal) {
    if (!this.current(signal) || !this.attempt) return;
    try {
      const result = await this.session.serviceConnection(
        "status",
        this.serviceId,
        signal,
        this.attempt.attemptId,
      );
      if (!this.current(signal)) return;
      const phase = this.terminal(result);
      if (phase) return this.finish(phase);
      this.publish({ ...this.state, statusFailed: false });
    } catch {
      if (!this.current(signal)) return;
      this.publish({ ...this.state, statusFailed: true });
    }
    this.schedule(signal);
  }
  async cancel() {
    if (this.disposed || this.state.phase !== "pending" || !this.attempt)
      return;
    const signal = this.stopRequests();
    this.publish({ ...this.state, phase: "cancelling", cancelFailed: false });
    this.expire(signal);
    try {
      const result = await this.session.serviceConnection(
        "cancel",
        this.serviceId,
        signal,
        this.attempt.attemptId,
      );
      if (!this.current(signal)) return;
      this.finish(this.terminal(result) ?? "cancelled");
    } catch {
      if (!this.current(signal)) return;
      this.publish({ ...this.state, phase: "pending", cancelFailed: true });
      this.schedule(signal);
    }
  }
  dispose() {
    this.disposed = true;
    this.returned?.remove();
    this.stopRequests();
    this.request.abort();
  }
}

