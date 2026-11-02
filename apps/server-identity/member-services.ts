import {
  MemberServiceList,
  type MemberService,
} from "../../packages/protocol/member-services";
import type { CatalogActor, ServiceCatalogStore } from "./service-catalog";
import { personalSignIns } from "./service-oauth-controller";

/**
 * Every enabled service the person may use, as they see it: whose account
 * reads and changes run under, which actions they may run now, their sign-in
 * when something needs it, and their own last read and last failure. Uses the
 * same access rules as the person's catalog view and sign-ins, so an
 * administrator sees only what they may run, too. Never returns the address,
 * credentials, sign-in configuration, grants or anyone else's activity.
 */
export function memberServices(
  catalog: ServiceCatalogStore,
  target: { organizationId: string; workspaceId: string },
  actor: CatalogActor,
): MemberServiceList {
  const { organizationId, workspaceId } = target;
  const signIns = new Map(
    personalSignIns(catalog, target, actor).map((entry) => [
      entry.serviceId,
      entry,
    ]),
  );
  const activity = catalog.serviceActivity(
    organizationId,
    workspaceId,
    actor.userId,
  );
  // The stored catalog, not the person's projection, so a service whose
  // actions the person switched off stays listed with nothing to run.
  const services = catalog
    .inventory(organizationId, workspaceId, { ...actor, role: "owner" })
    .services.flatMap((service): MemberService[] => {
      const owned = service.personal;
      if (
        !service.enabled ||
        (owned && (owned.userId !== actor.userId || owned.status !== "active"))
      )
        return [];
      const usable = service.actions.filter(
        (action) => action.enabled && catalog.allowed(action, actor),
      );
      const signIn = signIns.get(service.id);
      if (!owned && !signIn && !usable.length) return [];
      const required = owned
        ? "all"
        : (catalog.oauth?.requiredFor(workspaceId, service.id) ?? "none");
      const pick = (effect: "read" | "write") =>
        usable
          .filter((action) => action.effect === effect)
          .map((action) => ({
            id: action.id,
            name: action.name,
            description: action.description,
          }));
      const ownSignIn = owned
        ? catalog.personalSummary(service).signIn
        : undefined;
      const done = activity.get(service.id);
      return [
        {
          serviceId: service.id,
          name: service.name,
          icon: service.icon,
          iconSource: service.iconSource,
          own: !!owned,
          reads: {
            account: required === "all" ? "own" : "company",
            actions: pick("read"),
          },
          changes: {
            account: required === "none" ? "company" : "own",
            actions: pick("write"),
          },
          signIn: owned
            ? ownSignIn === "connected"
              ? "connected"
              : ownSignIn === "needed"
                ? "disconnected"
                : null
            : signIn
              ? signIn.ready
                ? signIn.status
                : "not_ready"
              : null,
          lastRead: done?.lastRead ? { at: done.lastRead } : null,
          lastFailure: done?.lastFailure ?? null,
        },
      ];
    });
  return MemberServiceList.parse({ organizationId, workspaceId, services });
}
