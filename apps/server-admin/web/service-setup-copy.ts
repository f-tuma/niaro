import { z } from "zod";
import { useAdmin } from "./context";

/** The service detail tabs; the slug and the visible label name the same thing. */
export const serviceTabs = [
  "overview",
  "actions",
  "processes",
  "access",
] as const;
/** Tabs merged into the four above keep working as links. */
const legacyTabs: Record<string, (typeof serviceTabs)[number]> = {
  model: "overview",
  connection: "overview",
  authentication: "access",
  "sign-in": "access",
};
export const serviceTabSchema = z.preprocess(
  (tab) => (typeof tab === "string" ? (legacyTabs[tab] ?? tab) : tab),
  z.enum(serviceTabs),
);
export const addServiceSearchSchema = z.object({
  mode: z.enum(["assistant", "manual"]).optional(),
});
/** What the automatic OAuth probe of a just-added MCP service found. */
export const signInOutcomeSchema = z.enum(["configured", "metadata", "none"]);
export type SignInOutcome = z.infer<typeof signInOutcomeSchema>;
export const serviceDetailSearchSchema = z.object({
  tab: serviceTabSchema.optional(),
  setup: z.literal("assistant").optional(),
  signIn: signInOutcomeSchema.optional(),
});

export const setupEn = {
  overview: "Overview",
  assistant: "Configure with assistant",
  manual: "Configure manually",
  setupMode: "Setup method",
  assistantDescription: "Connect, then design processes in chat.",
  manualDescription: "Set up the connection and actions yourself.",
  purpose: "Purpose",
  noPurpose: "No purpose yet",
  editPurpose: "Edit purpose",
  details: "Details",
  address: "Address",
  credential: "Credential",
  stored: "Stored",
  missing: "Missing",
  notRequired: "Not required",
  editConnection: "Edit connection",
  viewAll: "View all",
  paused: "Enable the service to design processes.",
  signInDetected: "Sign-in: the service's OAuth, for every action",
  clientRegistered: "client registered",
  clientMissing: "client missing",
  signInNone: "OAuth not found",
  edit: "Edit",
  connectOnly: "Only these can connect:",
  connectNobody: "Nobody can connect",
  enable: "Enable",
  enabledOf: "of",
  enabledSuffix: "enabled",
  chooseActions: "Choose actions",
  stepDiscover: "Load the service's actions",
  stepEnable: "Turn on the actions the assistant may use",
  stepProcess: "Create the first process",
  createProcess: "Create process",
} as const;
type SetupCopy = Record<keyof typeof setupEn, string>;
export const setupCs: SetupCopy = {
  overview: "Přehled",
  assistant: "Nastavit pomocí asistenta",
  manual: "Nastavit ručně",
  setupMode: "Způsob nastavení",
  assistantDescription: "Připoj službu a procesy navrhni v chatu.",
  manualDescription: "Připojení a akce nastavíš ručně.",
  purpose: "Účel",
  noPurpose: "Účel zatím chybí",
  editPurpose: "Upravit účel",
  details: "Podrobnosti",
  address: "Adresa",
  credential: "Přístupový údaj",
  stored: "Uložený",
  missing: "Chybí",
  notRequired: "Není potřeba",
  editConnection: "Upravit připojení",
  viewAll: "Zobrazit vše",
  paused: "Pro návrh procesů službu zapni.",
  signInDetected: "Přihlášení: OAuth služby, pro každou akci",
  clientRegistered: "klient zaregistrován",
  clientMissing: "klient chybí",
  signInNone: "OAuth nenalezeno",
  edit: "Upravit",
  connectOnly: "Připojit se mohou jen:",
  connectNobody: "Připojit se nemůže nikdo",
  enable: "Zapnout",
  enabledOf: "z",
  enabledSuffix: "zapnuto",
  chooseActions: "Vybrat akce",
  stepDiscover: "Načti akce služby",
  stepEnable: "Zapni akce, které smí asistent používat",
  stepProcess: "Vytvoř první proces",
  createProcess: "Vytvořit proces",
};
/** The one line the add result shows for an MCP service's automatic OAuth probe. */
export function signInLine(outcome: SignInOutcome, copy: SetupCopy) {
  if (outcome === "none") return copy.signInNone;
  return `${copy.signInDetected} · ${
    outcome === "configured" ? copy.clientRegistered : copy.clientMissing
  }`;
}
const orgRoles = ["owner", "admin", "member"] as const;
/**
 * One line when the service's connection gate leaves out an organization role
 * (an administrator narrowed it), naming who may connect; null when every
 * organization role may, or no gate was ever set (which lets everyone in).
 */
export function connectLimit(
  access:
    | { roles: readonly string[]; workspaceRoles: readonly string[] }
    | undefined,
  labels: {
    roles: Record<(typeof orgRoles)[number], string>;
    workspaceRoles: readonly { id: string; name: string }[];
  },
  copy: SetupCopy,
) {
  if (!access || orgRoles.every((role) => access.roles.includes(role)))
    return null;
  const names = [
    ...orgRoles
      .filter((role) => access.roles.includes(role))
      .map((role) => labels.roles[role]),
    ...access.workspaceRoles.flatMap((id) => {
      const role = labels.workspaceRoles.find((r) => r.id === id);
      return role ? [role.name] : [];
    }),
  ];
  return names.length
    ? `${copy.connectOnly} ${names.join(", ")}`
    : copy.connectNobody;
}
export function useServiceSetupCopy() {
  return useAdmin().language === "cs" ? setupCs : setupEn;
}
