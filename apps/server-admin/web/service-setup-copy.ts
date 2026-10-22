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
  stepProcess: "Create the first process",
  createProcess: "Create process",
  setup: "Setup",
  discover: "Discover actions",
  markReads: "Mark as reads",
  stepSignIn: "Sign-in",
  stepActions: "Actions",
  stepAccess: "Access",
  stepConnected: "Your account",
  stepTest: "Test",
  checking: "Checking…",
  reachable: "Answers",
  reachableSignIn: "Answers and asks for an account",
  originDenied: "The address isn't allowed. Add its origin in Settings.",
  unreachable: "No answer ({code})",
  openSettings: "Open settings",
  noSignIn: "No sign-in",
  sharedKey: "Shared key",
  sharedKeyMissing: "The shared key is missing",
  personalProvider: "Each person's own account, through {name}",
  personalService: "Each person's own account, through the service's OAuth",
  serviceOAuthMissing: "The service's OAuth isn't set up",
  providerNeeded: "Needs each person's {kind} account",
  providerMissing: "Needs a {kind} sign-in method",
  providerOff: "The sign-in method {name} is off",
  addProvider: "Add sign-in method",
  useProvider: "Use {name}",
  setUp: "Set up",
  providerFields: "The method needs",
  microsoftFields:
    "Application (client) ID, client secret, directory (tenant) ID",
  googleFields: "Client ID, client secret",
  redirectUrl: "Redirect URL",
  permissions: "Permissions",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Copy failed",
  noActions: "No actions yet",
  actionsCount: "{n} actions",
  describing: "Describing actions: {done} of {total}",
  importing: "Loading actions…",
  continueImport: "Continue",
  afterActions: "Waits for actions",
  noneEnabled: "No action is on",
  noReads: "{n} on, none readable by overview widgets",
  accessDone: "{n} on, {reads} readable by overview widgets; {who}",
  findReads: "Find reads",
  afterSignIn: "Waits for sign-in",
  connected: "Connected",
  connectedAs: "Connected as {name}",
  notConnected: "Not connected",
  expired: "Expired, connect again",
  connect: "Connect",
  testNone: "Needs a read action without inputs",
  testIdle: "Runs {action}",
  testRun: "Test",
  testOk: "{action} answered",
  testFailed: "{action}: {reason}",
  connectFirst: "Connect your account first.",
  running: "Running…",
  result: "Result",
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
  stepProcess: "Vytvoř první proces",
  createProcess: "Vytvořit proces",
  setup: "Nastavení",
  discover: "Načíst akce",
  markReads: "Označit jako čtení",
  stepSignIn: "Přihlášení",
  stepActions: "Akce",
  stepAccess: "Přístup",
  stepConnected: "Tvůj účet",
  stepTest: "Test",
  checking: "Ověřuju…",
  reachable: "Odpovídá",
  reachableSignIn: "Odpovídá a chce účet",
  originDenied: "Adresa není povolená. Přidej její origin v Nastavení.",
  unreachable: "Neodpovídá ({code})",
  openSettings: "Otevřít nastavení",
  noSignIn: "Bez přihlášení",
  sharedKey: "Sdílený klíč",
  sharedKeyMissing: "Chybí sdílený klíč",
  personalProvider: "Vlastní účet každého, přes {name}",
  personalService: "Vlastní účet každého, přes OAuth služby",
  serviceOAuthMissing: "OAuth služby není nastavený",
  providerNeeded: "Potřebuje vlastní účet {kind} každého",
  providerMissing: "Chybí přihlašovací metoda {kind}",
  providerOff: "Přihlašovací metoda {name} je vypnutá",
  addProvider: "Přidat přihlašovací metodu",
  useProvider: "Použít {name}",
  setUp: "Nastavit",
  providerFields: "Metoda potřebuje",
  microsoftFields:
    "ID aplikace (klienta), tajný klíč klienta, ID adresáře (tenanta)",
  googleFields: "ID klienta, tajný klíč klienta",
  redirectUrl: "Adresa pro návrat",
  permissions: "Oprávnění",
  copy: "Zkopírovat",
  copied: "Zkopírováno",
  copyFailed: "Kopírování selhalo",
  noActions: "Zatím žádné akce",
  actionsCount: "Akcí: {n}",
  describing: "Popisuju akce: {done} z {total}",
  importing: "Načítám akce…",
  continueImport: "Pokračovat",
  afterActions: "Čeká na akce",
  noneEnabled: "Žádná akce není zapnutá",
  noReads: "Zapnuto {n}, widgety přehledu nemají co číst",
  accessDone: "Zapnuto {n}, pro widgety přehledu {reads}; {who}",
  findReads: "Najít čtení",
  afterSignIn: "Čeká na přihlášení",
  connected: "Připojeno",
  connectedAs: "Připojeno jako {name}",
  notConnected: "Nepřipojeno",
  expired: "Vypršelo, připoj znovu",
  connect: "Připojit",
  testNone: "Chce akci pro čtení bez vstupů",
  testIdle: "Spustí {action}",
  testRun: "Otestovat",
  testOk: "{action} odpověděla",
  testFailed: "{action}: {reason}",
  connectFirst: "Nejdřív připoj svůj účet.",
  running: "Běží…",
  result: "Výsledek",
};
/** A copy line with its `{name}` slots filled. */
export function fill(line: string, values: Record<string, string | number>) {
  return line.replace(/\{(\w+)\}/g, (slot, name: string) =>
    name in values ? String(values[name]) : slot,
  );
}
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
