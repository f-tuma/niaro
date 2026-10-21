/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { IdentityId } from "./identity";

/** MCP servers that Agent Server can install and run itself, always inside a sandbox. */
export const HostedTemplateId = z.enum(["microsoft-365"]);
export type HostedTemplateId = z.infer<typeof HostedTemplateId>;
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
export const HostedEnv = z
  .array(
    z.strictObject({
      name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/),
      /** Secret values are stored encrypted and never returned. */
      value: z.string().max(4096).optional(),
      secret: z.boolean(),
    }),
  )
  .max(30)
  .refine(
    (items) => new Set(items.map((item) => item.name)).size === items.length,
  );
export const HostedDefinitionInput = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("npm"),
    package: NpmPackage,
    version: NpmVersion,
    /** One of the package's executables; defaults to its only one. */
    bin: z.string().max(100).optional(),
    args: HostedArgs.refine((args) => args.some((a) => a.includes("{port}")), {
      message: "The arguments must include {port}",
    }),
    env: HostedEnv,
  }),
  z.strictObject({
    source: z.literal("image"),
    image: ImageReference,
    /** The port the server listens on inside the container. */
    port: z.number().int().min(1).max(65535),
    args: HostedArgs,
    env: HostedEnv,
  }),
]);
export type HostedDefinitionInput = z.infer<typeof HostedDefinitionInput>;
export const HostedServerSchema = z.strictObject({
  id: HostedServerId,
  source: z.enum(["template", "npm", "image"]),
  template: HostedTemplateId.optional(),
  name: z.string().max(100),
  /** Package or image and its exact version or digest. */
  artifact: z.string().max(400),
  version: z.string().max(80),
  enabled: z.boolean(),
  status: HostedStatus,
  /** The MCP endpoint to use as a service URL; reachable only from this server. */
  url: z.string().url(),
  revision: z.number().int().positive(),
  error: z.string().max(200).optional(),
  restarts: z.number().int().nonnegative(),
  env: z
    .array(
      z.strictObject({
        name: z.string(),
        secret: z.boolean(),
        value: z.string().optional(),
      }),
    )
    .max(30),
  args: HostedArgs,
});
export type HostedServer = z.infer<typeof HostedServerSchema>;
export const HostedTemplateSchema = z.strictObject({
  id: HostedTemplateId,
  name: z.string(),
  version: z.string(),
  package: z.string(),
});
export const HostedServersSchema = z.strictObject({
  organizationId: IdentityId,
  canManage: z.boolean(),
  /** The operator's server profile decides; the console can never turn it on. */
  allowCustom: z.boolean(),
  sandbox: z.enum(["docker", "unavailable"]),
  templates: z.array(HostedTemplateSchema).max(20),
  servers: z.array(HostedServerSchema).max(20),
});
export const HostedCommand = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    organizationId: IdentityId,
    template: HostedTemplateId,
  }),
  z.strictObject({
    type: z.literal("createCustom"),
    organizationId: IdentityId,
    name: z.string().trim().min(1).max(100),
    definition: HostedDefinitionInput,
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
