import assert from "node:assert/strict";
import { test } from "node:test";
import { authRequest } from "../packages/client-core/auth";
import { ClientSession } from "../packages/client-core/session";
import { CredentialSchema } from "../packages/protocol";
import { WORKSPACE_DESIGN_PROFILE } from "../packages/protocol/process-design";
import { DESIGN_PROFILE } from "../packages/protocol/process-design";
import { designHttpFixture } from "./helpers/process-design-http";

const profile = `profile=${encodeURIComponent(WORKSPACE_DESIGN_PROFILE)}`;

test("default paired session can use the designer without enabling process execution", async () => {
  const h = await designHttpFixture();
  let session: ClientSession | undefined;
  try {
    const issued = await h.request(
      "owner",
      "api/identity/mobile/pairing",
      h.target,
    );
    assert.equal(issued.status, 200, JSON.stringify(issued.data));
    const grant = h.record(issued.data);
    const credential = CredentialSchema.parse(
      await authRequest(
        String(grant.address),
        "pair",
        fetch,
        undefined,
        String(grant.code),
        false,
        true,
      ),
    );
    session = new ClientSession(
      String(grant.address),
      { getItem: async () => null, setItem: async () => {} },
      credential,
    );
    await session.start(false);

    const capabilities = (await session.requestProcessDesign("capabilities", {
      organizationId: h.target.organizationId,
      workspaceId: h.target.workspaceId,
    })) as { profile?: string };
    assert.equal(capabilities.profile, WORKSPACE_DESIGN_PROFILE);
    const serviceCapabilities = (await session.requestProcessDesign(
      "capabilities",
      {
        profile: DESIGN_PROFILE,
      },
    )) as { profile?: string };
    assert.equal(serviceCapabilities.profile, DESIGN_PROFILE);
    await assert.rejects(
      session.loadProcessInventory(),
      /process_profile_unsupported/,
    );
  } finally {
    session?.stop();
    await h.close();
  }
});

test("mobile workspace designer enforces bearer scope, roles, profile, methods, size and revocation", async () => {
  const h = await designHttpFixture();
  const pair = async (role: "owner" | "member") => {
    const issued = await h.request(
      role,
      "api/identity/mobile/pairing",
      h.target,
    );
    assert.equal(issued.status, 200, JSON.stringify(issued.data));
    const grant = h.record(issued.data);
    return CredentialSchema.parse(
      await authRequest(
        String(grant.address),
        "pair",
        fetch,
        undefined,
        String(grant.code),
        false,
        true,
      ),
    );
  };
  const request = async (
    token: string | undefined,
    path: string,
    method = "GET",
    body?: unknown,
  ) => {
    const response = await fetch(
      `${h.origin}/v1/${h.target.workspaceId}/${path}`,
      {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, value: (await response.json()) as any };
  };
  try {
    const anonymous = await request(
      undefined,
      `process-design/capabilities?${profile}`,
    );
    assert.equal(anonymous.status, 401, JSON.stringify(anonymous.value));

    const owner = await pair("owner");
    const unsupportedProfile = await request(
      owner.accessToken,
      "process-design/capabilities?profile=agent-process-design%2F3",
    );
    assert.equal(
      unsupportedProfile.status,
      406,
      JSON.stringify(unsupportedProfile.value),
    );
    const unsupportedMethod = await request(
      owner.accessToken,
      `process-design/capabilities?${profile}`,
      "PUT",
    );
    assert.equal(
      unsupportedMethod.status,
      405,
      JSON.stringify(unsupportedMethod.value),
    );
    const unsupportedPath = await request(
      owner.accessToken,
      `process-design/delete?${profile}`,
    );
    assert.equal(
      unsupportedPath.status,
      404,
      JSON.stringify(unsupportedPath.value),
    );
    const oversized = await request(
      owner.accessToken,
      `process-design/start?${profile}`,
      "POST",
      {
        profile: WORKSPACE_DESIGN_PROFILE,
        requestId: "TEST-mobile-design-oversized",
        owner: { type: "workspace" },
        padding: "x".repeat(132_000),
      },
    );
    assert.equal(oversized.status, 413, JSON.stringify(oversized.value));

    const capabilities = await request(
      owner.accessToken,
      `process-design/capabilities?${profile}&organizationId=TEST-forged`,
    );
    assert.equal(capabilities.status, 200, JSON.stringify(capabilities.value));
    assert.equal(capabilities.value.profile, WORKSPACE_DESIGN_PROFILE);
    assert.equal(
      capabilities.value.capabilities.organizationId,
      h.target.organizationId,
    );
    assert.equal(
      capabilities.value.capabilities.workspaceId,
      h.target.workspaceId,
    );

    const serviceProfile = `profile=${encodeURIComponent(DESIGN_PROFILE)}`;
    const serviceCapabilities = await request(
      owner.accessToken,
      `process-design/capabilities?${serviceProfile}`,
    );
    assert.equal(
      serviceCapabilities.status,
      200,
      JSON.stringify(serviceCapabilities.value),
    );
    assert.equal(serviceCapabilities.value.profile, DESIGN_PROFILE);
    const serviceStarted = await request(
      owner.accessToken,
      `process-design/start?${serviceProfile}`,
      "POST",
      {
        requestId: "TEST-mobile-service-design-start",
        serviceId: h.serviceId,
      },
    );
    assert.equal(
      serviceStarted.status,
      200,
      JSON.stringify(serviceStarted.value),
    );
    assert.equal(serviceStarted.value.review.serviceId, h.serviceId);
    const serviceSessionId = serviceStarted.value.receipt.sessionId as string;
    const serviceSessions = await request(
      owner.accessToken,
      `process-design/sessions/list?${serviceProfile}&serviceId=${encodeURIComponent(h.serviceId)}`,
    );
    assert.equal(
      serviceSessions.status,
      200,
      JSON.stringify(serviceSessions.value),
    );
    assert.equal(serviceSessions.value.serviceId, h.serviceId);
    assert(
      serviceSessions.value.sessions.some(
        (item: { id: string }) => item.id === serviceSessionId,
      ),
    );
    const serviceDrafts = await request(
      owner.accessToken,
      `process-design/drafts/list?${serviceProfile}&serviceId=${encodeURIComponent(h.serviceId)}`,
    );
    assert.equal(
      serviceDrafts.status,
      200,
      JSON.stringify(serviceDrafts.value),
    );
    assert.deepEqual(serviceDrafts.value.drafts, []);

    for (const collection of ["sessions/list", "drafts/list"] as const) {
      const missingService = await request(
        owner.accessToken,
        `process-design/${collection}?${serviceProfile}&serviceId=TEST-missing-service`,
      );
      assert.equal(
        missingService.status,
        404,
        JSON.stringify(missingService.value),
      );
    }

    const started = await request(
      owner.accessToken,
      `process-design/start?${profile}`,
      "POST",
      {
        profile: WORKSPACE_DESIGN_PROFILE,
        requestId: "TEST-mobile-design-start",
        owner: { type: "workspace" },
        organizationId: "TEST-forged",
        workspaceId: "TEST-forged",
      },
    );
    assert.equal(started.status, 200, JSON.stringify(started.value));
    assert.equal(started.value.profile, WORKSPACE_DESIGN_PROFILE);
    assert.equal(started.value.review.organizationId, h.target.organizationId);
    assert.equal(started.value.review.workspaceId, h.target.workspaceId);
    assert.equal(started.value.review.acceptedProcessId, null);
    const sessionId = started.value.receipt.sessionId as string;
    const reloaded = await request(
      owner.accessToken,
      `process-design?${profile}&sessionId=${encodeURIComponent(sessionId)}&organizationId=TEST-forged&workspaceId=TEST-forged`,
    );
    assert.equal(reloaded.status, 200, JSON.stringify(reloaded.value));
    assert.equal(reloaded.value.profile, WORKSPACE_DESIGN_PROFILE);
    assert.equal(reloaded.value.review.id, sessionId);
    assert.equal(reloaded.value.review.organizationId, h.target.organizationId);
    assert.equal(reloaded.value.review.workspaceId, h.target.workspaceId);

    let release!: () => void;
    let entered!: () => void;
    let serverAborted!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const modelEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // The server must notice the closed request before the model answers;
    // otherwise a slow runner lets the turn complete first.
    const disconnected = new Promise<void>((resolve) => {
      serverAborted = resolve;
    });
    h.onModel(async (_request, signal) => {
      if (signal?.aborted) serverAborted();
      else signal?.addEventListener("abort", () => serverAborted());
      entered();
      await modelGate;
      return { content: "TEST mobile designer interrupted" };
    });
    const turnRequestId = "TEST-mobile-design-abort";
    const abort = new AbortController();
    const pendingTurn = fetch(
      `${h.origin}/v1/${h.target.workspaceId}/process-design/turns?${profile}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          organizationId: h.target.organizationId,
          workspaceId: h.target.workspaceId,
          sessionId,
          requestId: turnRequestId,
          revision: started.value.review.revision,
          modelId: h.modelId,
          text: "TEST cancel this mobile design turn",
          language: "en",
        }),
        signal: abort.signal,
      },
    ).catch(() => undefined);
    try {
      await modelEntered;
      abort.abort();
      await pendingTurn;
      await Promise.race([
        disconnected,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(Error("The server did not notice the closed request")),
            10_000,
          ),
        ),
      ]);
    } finally {
      release();
    }
    let interruptedTurn: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await request(
        owner.accessToken,
        `process-design/turns?${profile}&sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(turnRequestId)}`,
      );
      assert.equal(current.status, 200, JSON.stringify(current.value));
      interruptedTurn = current.value.turn;
      if (interruptedTurn.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(interruptedTurn.status, "interrupted");
    assert.equal(
      interruptedTurn.userText,
      "TEST cancel this mobile design turn",
    );
    assert.equal(interruptedTurn.reply, null);

    // Members design personal processes: the mobile app's workspace start is
    // recorded as the member's own process. Service designer lists stay admin-only.
    const member = await pair("member");
    const memberCapabilities = await request(
      member.accessToken,
      `process-design/capabilities?${profile}`,
    );
    assert.equal(
      memberCapabilities.status,
      200,
      JSON.stringify(memberCapabilities.value),
    );
    const personal = await request(
      member.accessToken,
      `process-design/start?${profile}`,
      "POST",
      {
        profile: WORKSPACE_DESIGN_PROFILE,
        requestId: "TEST-mobile-member-personal",
        owner: { type: "workspace" },
      },
    );
    assert.equal(personal.status, 200, JSON.stringify(personal.value));
    assert.equal(personal.value.review.owner.type, "user");
    for (const collection of ["sessions/list", "drafts/list"] as const) {
      const deniedCollection = await request(
        member.accessToken,
        `process-design/${collection}?${serviceProfile}&serviceId=${encodeURIComponent(h.serviceId)}`,
      );
      assert.equal(
        deniedCollection.status,
        403,
        JSON.stringify(deniedCollection.value),
      );
    }

    const revoked = await h.request(
      "owner",
      "api/identity/mobile/revoke",
      h.target,
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
    const expired = await request(
      owner.accessToken,
      `process-design?${profile}&sessionId=${encodeURIComponent(sessionId)}`,
    );
    assert.equal(expired.status, 401, JSON.stringify(expired.value));
  } finally {
    await h.close();
  }
});
