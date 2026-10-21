import { ApiError } from "../apps/server-admin/web/lib/api";
import {
  cs,
  en,
  failureText,
  redirectFailure,
} from "../apps/server-admin/web/public-account-copy";
import {
  AccessSchema,
  browserLabel,
} from "../apps/server-admin/web/lib/account-access";

test("each unusable invitation or reset link names its own reason", () => {
  const fallback = "fallback";
  for (const code of [
    "invitation_invalid",
    "invitation_expired",
    "invitation_used",
    "invitation_revoked",
    "invitation_account_mismatch",
    "password_reset_invalid",
    "password_reset_expired",
    "password_reset_used",
    "mobile_device_limit",
  ] as const) {
    expect(failureText(new ApiError(410, code), cs, fallback)).toBe(cs[code]);
    expect(cs[code]).not.toBe(en[code]);
  }
  // Different reasons read differently, never one "could not continue".
  expect(new Set([cs.invitation_expired, cs.invitation_used]).size).toBe(2);
  expect(failureText(new ApiError(429, "anything"), en, fallback)).toBe(
    en.rateLimited,
  );
  expect(
    failureText(new ApiError(500, "identity_unavailable"), en, fallback),
  ).toBe(fallback);
  expect(failureText(new Error("network"), en, fallback)).toBe(fallback);
});

test("a provider sign-in failure the person can fix is named on return", () => {
  expect(redirectFailure("", cs, true)).toBe("");
  expect(redirectFailure("?error=invitation_account_mismatch", cs, true)).toBe(
    cs.invitation_account_mismatch,
  );
  expect(redirectFailure("?error=auth_provider_link_required", cs, true)).toBe(
    cs.auth_provider_link_required,
  );
  expect(redirectFailure("?error=auth_provider_link_required", cs, false)).toBe(
    cs.loginLinkRequired,
  );
  expect(redirectFailure("?error=unable_to_get_user_info", en, false)).toBe(
    en.signInFailed,
  );
});

test("browser sessions read as browser and system, never the raw agent", () => {
  expect(
    browserLabel(
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      "Browser",
    ),
  ).toBe("Firefox · Linux");
  expect(
    browserLabel(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0",
      "Browser",
    ),
  ).toBe("Edge · Windows");
  expect(
    browserLabel(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Browser",
    ),
  ).toBe("Safari · iOS");
  expect(browserLabel(null, "Prohlížeč")).toBe("Prohlížeč");
});

test("the account access list parses the server's shape", () => {
  const value = AccessSchema.parse({
    hasPassword: true,
    limit: 8,
    used: 2,
    devices: [
      {
        id: "a".repeat(32),
        workspaceId: "TEST-workspace",
        workspaceName: "TEST Workspace",
        createdAt: null,
        lastActiveAt: 1,
      },
    ],
    sessions: [],
    browsers: [
      {
        id: "b".repeat(32),
        current: true,
        createdAt: 1,
        expiresAt: 2,
        userAgent: null,
        chats: ["TEST Workspace"],
      },
    ],
  });
  expect(value.devices[0]!.workspaceName).toBe("TEST Workspace");
  expect(value.browsers[0]!.current).toBe(true);
  // Older servers send no MCP list.
  expect(value.mcp).toEqual([]);
  const withMcp = AccessSchema.parse({
    hasPassword: false,
    limit: 8,
    used: 0,
    devices: [],
    sessions: [],
    browsers: [],
    mcp: [
      {
        id: "c".repeat(32),
        label: "TEST desktop",
        workspaceName: "TEST Workspace",
        scopes: ["native.run"],
        createdAt: 1,
        expiresAt: 2,
        lastUsedAt: null,
      },
    ],
  });
  expect(withMcp.mcp[0]!.label).toBe("TEST desktop");
});
