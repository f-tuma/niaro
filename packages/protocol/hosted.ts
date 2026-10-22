/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { IdentityId } from "./identity";
import { ServiceIcon } from "./service-catalog";
import { OAuthScope } from "./service-oauth";

/** A built-in definition shipped with the server, e.g. microsoft-365. */
export const HostedBuiltinId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export type HostedBuiltinId = z.infer<typeof HostedBuiltinId>;
export const HostedServerId = z.string().regex(/^hs_[a-f0-9]{24}$/);
export const HostedStatus = z.enum([
  "installing",
  "starting",
  "running",
  "stopped",
  "failed",
]);
/** npm package names, including scopes; no paths, URLs or git sources. */
export const NpmPackage = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
export const NpmVersion = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "An exact version");
/** Images are pinned by digest so the running code cannot change underneath. */
export const ImageReference = z
  .string()
  .max(300)
  .regex(
    /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[a-f0-9]{64}$/,
    "image@sha256:digest",
  );
/** Arguments are passed as a list, never through a shell. {port} is the listening port. */
export const HostedArgs = z
  .array(
    z
      .string()
      .max(500)
      .regex(/^[^\0\r\n]*$/),
  )
  .max(40);
/** Variables that could widen a confined process or replace its own settings. */
const RESERVED_ENV = /^(?:PATH|HOME|TMPDIR|NODE_.*|LD_.*|DYLD_.*)$/;
export const HostedEnvName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, "UPPER_CASE")
  .refine((name) => !RESERVED_ENV.test(name), "Reserved variable");
export const HostedEnvValue = z
  .string()
  .max(4096)
  .regex(/^[^\0\r\n]*$/);
/**
 * How a service for the server is set up: the catalog icon and purpose, and the
 * personal sign-in each person completes with their own account. Prefills
 * only; administrators can change everything afterwards.
 */
export const HostedOnboarding = z.strictObject({
  icon: ServiceIcon.optional(),
  description: z.string().trim().min(1).max(500).optional(),
  signIn: z
    .strictObject({
      /** The kind of organization sign-in method the accounts come from. */
      provider: z.enum(["microsoft", "google"]),
      requiredFor: z.enum(["writes", "all"]).default("all"),
      /** Delegated permissions; the sign-in scopes are added on their own. */
      scopes: z.array(OAuthScope).max(30).default([]),
    })
    .optional(),
});
export type HostedOnboarding = z.infer<typeof HostedOnboarding>;
export const HOSTED_DEFINITION_VERSION = 1;
/**
 * One hosted MCP server, compose-like: what to run (an npm package at an exact
 * version, or an image by digest), its arguments, fixed variables and the names
 * of secret variables. Secret values are entered in administration, never here.
 * Built-in servers are definitions in this same format.
 */
export const HostedDefinition = z
  .strictObject({
    version: z.literal(HOSTED_DEFINITION_VERSION),
    name: z.string().trim().min(1).max(100),
    source: z.union([
      z.strictObject({
        npm: NpmPackage,
        version: NpmVersion,
        /** One of the package's executables; defaults to its only one. */
        bin: z.string().max(100).optional(),
      }),
      z.strictObject({
        image: ImageReference,
        /** The port the server listens on inside the container. */
        port: z.number().int().min(1).max(65535),
      }),
    ]),
    args: HostedArgs.default([]),
    env: z
      .record(HostedEnvName, HostedEnvValue)
      .refine((env) => Object.keys(env).length <= 30, "At most 30 variables")
      .default({}),
    secrets: z.array(HostedEnvName).max(30).default([]),
    memoryMb: z.number().int().min(128).max(4096).default(512),
    /** The MCP endpoint's path on the server. */
    path: z
      .string()
      .max(200)
      .regex(/^\/[A-Za-z0-9._~/-]*$/)
      .default("/mcp"),
    onboarding: HostedOnboarding.optional(),
  })
  .superRefine((value, ctx) => {
    if ("npm" in value.source && !value.args.some((a) => a.includes("{port}")))
      ctx.addIssue({
        code: "custom",
        path: ["args"],
        message: "The arguments must include {port}",
      });
    if (new Set(value.secrets).size !== value.secrets.length)
      ctx.addIssue({
        code: "custom",
        path: ["secrets"],
        message: "Secret names must be unique",
      });
    for (const name of value.secrets)
      if (name in value.env)
        ctx.addIssue({
          code: "custom",
          path: ["secrets"],
          message: `${name} is both a variable and a secret`,
        });
  });
export type HostedDefinition = z.infer<typeof HostedDefinition>;
/** A definition as written: the fields with defaults may be left out. */
export type HostedDefinitionInput = z.input<typeof HostedDefinition>;
/** Secret values by name; only names the definition declares. */
export const HostedSecretValues = z
  .record(HostedEnvName, HostedEnvValue)
  .refine((values) => Object.keys(values).length <= 30);
export const HostedServerSchema = z.strictObject({
  id: HostedServerId,
  builtin: HostedBuiltinId.optional(),
  /** Its definition, as exported: secret names only. */
  definition: HostedDefinition,
  /** Secret names with a stored value. */
  secretsSet: z.array(z.string()).max(30),
  enabled: z.boolean(),
  status: HostedStatus,
  /** The MCP endpoint to use as a service URL; reachable only from this server. */
  url: z.string().url(),
  revision: z.number().int().positive(),
  error: z.string().max(200).optional(),
  restarts: z.number().int().nonnegative(),
});
export type HostedServer = z.infer<typeof HostedServerSchema>;
export const HostedBuiltinSchema = z.strictObject({
  id: HostedBuiltinId,
  definition: HostedDefinition,
});
export const HostedServersSchema = z.strictObject({
  organizationId: IdentityId,
  canManage: z.boolean(),
  /** Custom definitions; the operator can turn them off in the server profile. */
  allowCustom: z.boolean(),
  /** process: no Docker, npm servers run as Node processes of the server. */
  sandbox: z.enum(["docker", "process", "unavailable"]),
  builtins: z.array(HostedBuiltinSchema).max(20),
  servers: z.array(HostedServerSchema).max(20),
});
export const HostedCommand = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    organizationId: IdentityId,
    builtin: HostedBuiltinId,
    secrets: HostedSecretValues.default({}),
  }),
  z.strictObject({
    type: z.literal("createCustom"),
    organizationId: IdentityId,
    definition: HostedDefinition,
    secrets: HostedSecretValues.default({}),
  }),
  /** Replaces the given secret values; the others stay. */
  z.strictObject({
    type: z.literal("secrets"),
    organizationId: IdentityId,
    id: HostedServerId,
    revision: z.number().int().positive(),
    secrets: HostedSecretValues,
  }),
  z.strictObject({
    type: z.enum(["start", "stop", "restart", "remove"]),
    organizationId: IdentityId,
    id: HostedServerId,
    revision: z.number().int().positive(),
  }),
]);
export const HostedLogRequest = z.strictObject({
  organizationId: IdentityId,
  id: HostedServerId,
});
export const HostedResolveRequest = z.strictObject({
  organizationId: IdentityId,
  package: NpmPackage,
  version: NpmVersion.optional(),
});
/** Registry metadata shown before anything is installed. */
export const HostedPackageInfo = z.strictObject({
  package: z.string(),
  version: z.string(),
  description: z.string().max(500).optional(),
  license: z.string().max(100).optional(),
  publisher: z.string().max(200).optional(),
  published: z.string().max(40).optional(),
  integrity: z.string().max(200),
  bins: z.array(z.string().max(100)).max(20),
  hasInstallScripts: z.boolean(),
});
