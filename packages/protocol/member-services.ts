/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { ActionFailureSchema } from "./action-failure";
import { IdentityId, IdentityName } from "./identity";
import { CatalogTarget, ServiceIcon } from "./service-catalog";

/** Whose account a kind of action runs under: the company's shared one or
 * the person's own sign-in. */
export const MemberServiceAccount = z.enum(["company", "own"]);
export type MemberServiceAccount = z.infer<typeof MemberServiceAccount>;

/** One action the person's assistant may run right now. */
export const MemberServiceAction = z.strictObject({
  id: IdentityId,
  name: IdentityName,
  description: z.string().max(2000),
});
export type MemberServiceAction = z.infer<typeof MemberServiceAction>;

/** Reads or changes of a service: the account they run under and which ones
 * the person may use. */
export const MemberServiceEffect = z.strictObject({
  account: MemberServiceAccount,
  actions: z.array(MemberServiceAction).max(1000),
});
export type MemberServiceEffect = z.infer<typeof MemberServiceEffect>;

/**
 * A service the person may use, as the person sees it: whose account it reads
 * and changes with, what they may run there, and their own last read and last
 * failure. Carries no address, configuration, credential or anyone else's
 * activity.
 */
export const MemberService = z.strictObject({
  serviceId: IdentityId,
  name: IdentityName,
  icon: ServiceIcon,
  iconSource: z.enum(["favicon", "custom"]),
  /** The person added this service for themselves. */
  own: z.boolean(),
  reads: MemberServiceEffect,
  changes: MemberServiceEffect,
  /** The person's own sign-in when some action needs it; null when nothing
   * runs under their account. `not_ready`: an administrator has not finished
   * the setup. */
  signIn: z
    .enum(["connected", "expired", "disconnected", "not_ready"])
    .nullable(),
  /** The person's last successful read in this service. */
  lastRead: z.strictObject({ at: z.number().int().positive() }).nullable(),
  /** The person's last failed action in this service, with its kind only. */
  lastFailure: z
    .strictObject({
      at: z.number().int().positive(),
      kind: ActionFailureSchema.shape.kind,
    })
    .nullable(),
});
export type MemberService = z.infer<typeof MemberService>;

export const MemberServiceList = CatalogTarget.extend({
  services: z.array(MemberService).max(1000),
});
export type MemberServiceList = z.infer<typeof MemberServiceList>;
