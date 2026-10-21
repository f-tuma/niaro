import { z } from "zod";
import {
  CredentialSchema,
  type AuthSession,
  type Credential,
} from "../protocol";
import type { KeyValueStorage } from "./preferences";
import { authRequest, refreshCredential } from "./auth";
import { normalizeAddress } from "./connection";
import { ClientSession, type ClientSessionOptions } from "./session";
import { isAccountScope } from "../protocol/mobile-access";
import { migrateStoredWorkflowProfile } from "./migrate";
import {
  browserLoginRequest,
  loginOrigin,
  validateLoginChallenge,
  validateLoginPoll,
} from "./browser-login";
const VAULT_KEY = "agent-client.active-credential.v1";
const Stored = z.strictObject({
  address: z.string(),
  credential: z.preprocess(migrateStoredWorkflowProfile, CredentialSchema),
  pendingRefreshId: z.string().min(16).max(100).optional(),
});
export type ConnectionState = {
  status: "loading" | "signed_out" | "pairing" | "connected" | "expired";
  session: ClientSession | null;
  identity: AuthSession | null;
  address: string | null;
  error: string | null;
  generation: number;
  renewable: boolean;
  browserLogin: {
    userCode: string;
    verificationUri: string;
    expiresAt: string;
  } | null;
};
/** Owns one active identity. Vault writes and late network results cannot retarget it. */
export class Connections {
  private state: ConnectionState = {
    status: "loading",
    session: null,
    identity: null,
    address: null,
    error: null,
    generation: 0,
    renewable: false,
    browserLogin: null,
  };
  private listeners = new Set<() => void>();
  private credential: Credential | null = null;
  private pendingRefreshId?: string;
  private writes: Promise<void> = Promise.resolve();
  private epoch = 0;
  private pendingBrowser: {
    origin: string;
    deviceCode: string;
    controller: AbortController;
  } | null = null;
  private appLoginController: AbortController | null = null;
  private loginAttempt = 0;
  private cancelBrowser() {
    this.appLoginController?.abort();
    this.appLoginController = null;
    const pending = this.pendingBrowser;
    this.pendingBrowser = null;
    pending?.controller.abort();
    if (pending)
      void browserLoginRequest(
        pending.origin,
        "cancel",
        this.request,
        pending.deviceCode,
      ).catch(() => {});
    this.publish({ browserLogin: null });
  }
  constructor(
    private storage: KeyValueStorage,
    private vault: KeyValueStorage,
    private allowHttp = false,
    private request: typeof fetch = (url, init) => fetch(url, init),
    private newRequestId: () => string = () =>
      `refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    /** What this app negotiates for every session it opens. */
    private sessionOptions: ClientSessionOptions = { processOutputs: true },
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<ConnectionState>) {
    if (update.session === null) update.renewable = false;
    this.state = { ...this.state, ...update };
    for (const fn of this.listeners) fn();
  }
  private save(value: z.infer<typeof Stored> | null, epoch: number) {
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        if (epoch === this.epoch)
          await this.vault.setItem(VAULT_KEY, JSON.stringify(value));
      });
    return this.writes;
  }
  private activate(address: string, credential: Credential, epoch: number) {
    const { accessToken: _token, refresh: _refresh, ...identity } = credential;
    const session = new ClientSession(
      address,
      this.storage,
      credential,
      this.request,
      () => {
        if (epoch !== this.epoch) return;
        const next = ++this.epoch;
        session.stop();
        this.credential = null;
        this.publish({
          status: "expired",
          session: null,
          identity: null,
          error: "auth_expired",
          generation: next,
        });
        void this.save(null, next).catch(() => {
          if (next === this.epoch)
            this.publish({ error: "credential_storage_error" });
        });
      },
      async (current) => {
        if (epoch !== this.epoch) throw new Error("session_stopped");
        // Persist the rotation intent with the old secret before sending it.
        const requestId = this.pendingRefreshId ?? this.newRequestId();
        this.pendingRefreshId = requestId;
        await this.save(
          { address, credential: current, pendingRefreshId: requestId },
          epoch,
        );
        if (epoch !== this.epoch) throw new Error("session_stopped");
        const renewed = await refreshCredential(
          address,
          current,
          requestId,
          this.request,
        );
        // Closing the app must keep its grant. The saved rotation intent recovers a
        // late response next time; explicit logout revokes via either refresh token.
        if (epoch !== this.epoch) throw new Error("session_stopped");
        await this.save({ address, credential: renewed }, epoch);
        if (epoch !== this.epoch) throw new Error("session_stopped");
        this.pendingRefreshId = undefined;
        this.credential = renewed;
        const {
          accessToken: _access,
          refresh: _renewal,
          ...identity
        } = renewed;
        this.publish({ identity });
        return renewed;
      },
      !!this.pendingRefreshId,
      this.sessionOptions,
    );
    this.credential = credential;
    this.publish({
      status: "connected",
      session,
      identity,
      address,
      error: null,
      generation: epoch,
      renewable: !!credential.refresh,
    });
  }
  async restore() {
    const epoch = ++this.epoch;
    try {
      const raw = await this.vault.getItem(VAULT_KEY);
      if (epoch !== this.epoch) return;
      if (!raw || raw === "null") {
        this.publish({ status: "signed_out" });
        return;
      }
      const record = Stored.parse(JSON.parse(raw));
      const address = normalizeAddress(record.address, this.allowHttp);
      if (
        !record.credential.refresh &&
        Date.parse(record.credential.expiresAt) <= Date.now()
      ) {
        await this.save(null, epoch);
        if (epoch === this.epoch)
          this.publish({ status: "expired", address, error: "auth_expired" });
        return;
      }
      // ClientSession validates the server session before loading any scoped cache.
      this.pendingRefreshId = record.pendingRefreshId;
      this.activate(address, record.credential, epoch);
    } catch {
      if (epoch === this.epoch)
        this.publish({
          status: "signed_out",
          error: "credential_storage_error",
        });
    }
  }
  async pair(rawAddress: string, rawCode: string) {
    if (this.state.status === "pairing" || this.state.status === "loading")
      return;
    let address: string;
    try {
      address = normalizeAddress(rawAddress, this.allowHttp);
    } catch {
      this.publish({ error: "addressError" });
      return;
    }
    const code = rawCode.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) {
      this.publish({ error: "pairing_invalid" });
      return;
    }
    const previous = this.credential,
      previousAddress = this.state.address;
    const epoch = ++this.epoch;
    this.pendingRefreshId = undefined;
    this.state.session?.stop();
    this.credential = null;
    this.publish({
      status: "pairing",
      session: null,
      identity: null,
      error: null,
      address,
      generation: epoch,
    });
    let issued: Credential | null = null;
    let vaultCleared = false;
    try {
      await this.save(null, epoch);
      vaultCleared = true;
      if (epoch !== this.epoch) return;
      if (previous && previousAddress)
        await authRequest(
          previousAddress,
          "session",
          this.request,
          previous,
          undefined,
          true,
        ).catch(() => {});
      if (epoch !== this.epoch) return;
      issued = await authRequest(
        address,
        "pair",
        this.request,
        undefined,
        code,
        false,
        true,
      );
      if (!issued || Date.parse(issued.expiresAt) <= Date.now())
        throw Error("pairing_invalid");
      if (epoch !== this.epoch) {
        await authRequest(
          address,
          "session",
          this.request,
          issued,
          undefined,
          true,
        ).catch(() => {});
        return;
      }
      await this.save({ address, credential: issued }, epoch);
      if (epoch !== this.epoch) {
        await authRequest(
          address,
          "session",
          this.request,
          issued,
          undefined,
          true,
        ).catch(() => {});
        return;
      }
      this.activate(address, issued, epoch);
      return true;
    } catch (error) {
      if (issued)
        await authRequest(
          address,
          "session",
          this.request,
          issued,
          undefined,
          true,
        ).catch(() => {});
      if (epoch === this.epoch)
        this.publish({
          status: "signed_out",
          error:
            issued || !vaultCleared
              ? "credential_storage_error"
              : error instanceof Error &&
                  [
                    "pairing_invalid",
                    "pairing_rate_limited",
                    "connection_failed",
                  ].includes(error.message)
                ? error.message
                : "connection_failed",
        });
    }
  }
  async signInWithApp(
    rawAddress: string,
    proof: { challenge: string; verifier: string; state: string },
    authorize: (url: string, signal: AbortSignal) => Promise<string>,
  ) {
    if (this.state.status === "loading" || this.state.status === "pairing")
      return;
    let origin: string;
    try {
      origin = loginOrigin(rawAddress, this.allowHttp);
    } catch {
      this.publish({ error: "addressError" });
      return;
    }
    // The current session keeps working until the new sign-in succeeds; a
    // cancelled or failed attempt leaves the person signed in as before.
    const prior = this.state,
      previous = this.credential,
      previousAddress = this.state.address;
    const controller = new AbortController();
    let issued: Credential | null = null,
      issuedAddress: string | null = null,
      saved = false,
      switched = false;
    const start = this.epoch,
      attempt = ++this.loginAttempt;
    const current = () => start === this.epoch && attempt === this.loginAttempt;
    try {
      this.cancelBrowser();
      this.appLoginController?.abort();
      this.appLoginController = controller;
      this.publish({ status: "pairing", error: null });
      const send = async (action: string, body: unknown) => {
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await this.request(
            `${origin}/v1/auth/app/${action}`,
            {
              method: "POST",
              credentials: "omit",
              redirect: "error",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: controller.signal,
            },
          );
          const text = await response.text();
          if (text.length > 16384) throw Error("connection_failed");
          if (!response.ok) {
            // The one refusal the person can fix: too many signed-in devices.
            const refused = z
              .object({ error: z.literal("mobile_device_limit") })
              .safeParse(JSON.parse(text || "{}"));
            throw Error(
              refused.success ? refused.data.error : "connection_failed",
            );
          }
          return JSON.parse(text) as unknown;
        } finally {
          clearTimeout(timeout);
        }
      };
      const started = z.object({ authorizationUrl: z.url() }).parse(
        await send("start", {
          challenge: proof.challenge,
          state: proof.state,
        }),
      );
      const target = new URL(started.authorizationUrl);
      if (target.origin !== origin || target.pathname !== "/account/login")
        throw Error("connection_failed");
      const code = await authorize(started.authorizationUrl, controller.signal);
      if (!current()) return;
      const result = z
        .object({ address: z.string(), credential: CredentialSchema })
        .parse(
          await send("exchange", {
            code,
            state: proof.state,
            verifier: proof.verifier,
          }),
        );
      issued = result.credential;
      if (!isAccountScope(issued.scope)) throw Error("auth_scope_mismatch");
      // Cleanup may only contact the requested server, never a rejected address
      // supplied in a malformed response.
      issuedAddress = `${origin}/v1/${issued.scope.workspaceId}`;
      if (result.address !== issuedAddress) throw Error("auth_scope_mismatch");
      if (!issued.refresh) throw Error("auth_session_incompatible");
      if (Date.parse(issued.expiresAt) <= Date.now())
        throw Error("auth_expired");
      if (!current()) return;
      // Switch: the old session stops first so its renewal cannot overwrite
      // the stored credential, then the new one is saved and activated.
      const epoch = ++this.epoch;
      switched = true;
      this.pendingRefreshId = undefined;
      prior.session?.stop();
      this.credential = null;
      await this.save({ address: result.address, credential: issued }, epoch);
      if (epoch !== this.epoch) return;
      this.activate(result.address, issued, epoch);
      saved = true;
      if (previous && previousAddress)
        void authRequest(
          previousAddress,
          "session",
          this.request,
          previous,
          undefined,
          true,
        ).catch(() => {});
      return true;
    } catch (error) {
      const code =
        error instanceof Error &&
        [
          "auth_scope_mismatch",
          "auth_session_incompatible",
          "auth_expired",
          "mobile_device_limit",
        ].includes(error.message)
          ? error.message
          : switched
            ? "credential_storage_error"
            : "connection_failed";
      if (switched && this.epoch === start + 1)
        this.publish({
          status: "signed_out",
          session: null,
          identity: null,
          error: code,
        });
      else if (!switched && current())
        this.publish({ status: prior.status, error: code });
    } finally {
      if (this.appLoginController === controller)
        this.appLoginController = null;
      if (issued && issuedAddress && !saved)
        await authRequest(
          issuedAddress,
          "session",
          this.request,
          issued,
          undefined,
          true,
        ).catch(() => {});
    }
  }
  async signInWithBrowser(rawAddress: string) {
    if (this.state.status === "loading" || this.state.status === "pairing")
      return;
    let origin: string;
    try {
      origin = loginOrigin(rawAddress, this.allowHttp);
    } catch {
      this.publish({ error: "addressError" });
      return;
    }
    const previous = this.credential,
      previousAddress = this.state.address;
    const epoch = ++this.epoch;
    this.pendingRefreshId = undefined;
    this.cancelBrowser();
    this.state.session?.stop();
    this.credential = null;
    this.publish({
      status: "pairing",
      session: null,
      identity: null,
      error: null,
      generation: epoch,
    });
    let issued: Credential | null = null,
      issuedAddress: string | null = null;
    let saved = false;
    try {
      await this.save(null, epoch);
      if (previous && previousAddress)
        await authRequest(
          previousAddress,
          "session",
          this.request,
          previous,
          undefined,
          true,
        ).catch(() => {});
      if (epoch !== this.epoch) return;
      const challenge = validateLoginChallenge(
        await browserLoginRequest(
          origin,
          "start",
          this.request,
          undefined,
          undefined,
          true,
        ),
        origin,
      );
      if (epoch !== this.epoch) {
        await browserLoginRequest(
          origin,
          "cancel",
          this.request,
          challenge.deviceCode,
        ).catch(() => {});
        return;
      }
      const controller = new AbortController();
      this.pendingBrowser = {
        origin,
        deviceCode: challenge.deviceCode,
        controller,
      };
      this.publish({
        browserLogin: {
          userCode: challenge.userCode,
          verificationUri: challenge.verificationUri,
          expiresAt: challenge.expiresAt,
        },
      });
      let interval = challenge.interval;
      while (
        epoch === this.epoch &&
        Date.now() < Date.parse(challenge.expiresAt)
      ) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, interval * 1000);
          controller.signal.addEventListener("abort", done, { once: true });
        });
        if (epoch !== this.epoch) return;
        let value: unknown;
        try {
          value = await browserLoginRequest(
            origin,
            "poll",
            this.request,
            challenge.deviceCode,
            controller.signal,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "browser_login_slow_down"
          ) {
            interval = Math.min(30, interval + 5);
            continue;
          }
          throw error;
        }
        const result = validateLoginPoll(value, origin, challenge.serverId);
        if (result.status === "pending") {
          interval = result.interval;
          continue;
        }
        issued = result.credential;
        issuedAddress = result.address;
        if (epoch !== this.epoch) return;
        await this.save({ address: result.address, credential: issued }, epoch);
        if (epoch !== this.epoch) return;
        this.pendingBrowser = null;
        this.publish({ browserLogin: null });
        this.activate(result.address, issued, epoch);
        saved = true;
        return true;
      }
      if (epoch === this.epoch) throw Error("browser_login_expired");
    } catch (error) {
      if (epoch === this.epoch) {
        this.cancelBrowser();
        this.publish({
          status: "signed_out",
          error: issued
            ? "credential_storage_error"
            : error instanceof Error &&
                [
                  "browser_login_expired",
                  "browser_login_denied",
                  "pairing_rate_limited",
                  "auth_scope_mismatch",
                ].includes(error.message)
              ? error.message
              : "connection_failed",
        });
      }
    } finally {
      if (issued && issuedAddress && !saved)
        await authRequest(
          issuedAddress,
          "session",
          this.request,
          issued,
          undefined,
          true,
        ).catch(() => {});
    }
  }
  async disconnect() {
    const credential = this.credential,
      address = this.state.address;
    const epoch = ++this.epoch;
    this.pendingRefreshId = undefined;
    this.cancelBrowser();
    this.state.session?.stop();
    this.credential = null;
    this.publish({
      status: "signed_out",
      session: null,
      identity: null,
      error: null,
      generation: epoch,
    });
    const results = await Promise.allSettled([
      this.save(null, epoch),
      credential && address
        ? authRequest(
            address,
            "session",
            this.request,
            credential,
            undefined,
            true,
          )
        : Promise.resolve(),
    ]);
    if (epoch !== this.epoch) return;
    if (results[0]?.status === "rejected")
      this.publish({ error: "credential_storage_error" });
    else if (results[1]?.status === "rejected")
      this.publish({ error: "logout_unconfirmed" });
  }
  dispose() {
    this.epoch++;
    this.cancelBrowser();
    this.state.session?.stop();
    this.listeners.clear();
  }
}
