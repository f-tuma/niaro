import type {
  HubChartKind,
  HubRefresh,
  HubWidgetType,
} from "../../../../packages/protocol/hub";
import type { PluralForms } from "../lib/plural";
import { useApp } from "./context";

const en = {
  overview: "Overview",
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  edit: "Edit",
  done: "Done",
  add: "Add widget",
  addTitle: "Add widget",
  builtIn: "Built in",
  processes: "Processes",
  newChat: "New chat",
  ask: "Ask the assistant…",
  askSend: "Ask",
  actions: "Widget actions",
  configure: "Set up view",
  rename: "Rename",
  move: "Move",
  resize: "Resize",
  sheetTitle: "Widget",
  nameLabel: "Name",
  viewLabel: "Show as",
  views: {
    number: "Number",
    chart: "Chart",
    list: "List",
    table: "Table",
    text: "Text",
    summary: "Summary",
    tasks: "Tasks",
    widget: "Widget",
  } satisfies Record<HubWidgetType, string>,
  dataLabel: "Data",
  labelLabel: "Label",
  unitLabel: "Unit",
  compareLabel: "Compare with",
  compareNone: "Nothing",
  comparePrevious: "Previous refresh",
  chartLabel: "Chart type",
  charts: {
    bar: "Bars",
    line: "Line",
    area: "Area",
    pie: "Pie",
  } satisfies Record<HubChartKind, string>,
  xLabel: "Labels",
  yLabel: "Values",
  titleField: "Title",
  subtitleField: "Detail",
  none: "None",
  columnsLabel: "Columns",
  save: "Save",
  cancel: "Cancel",
  fieldsUnknown: "Refresh it first to see what data it returns.",
  mismatch: "The process returns different data now. Set up the view again.",
  sincePrevious: "since last refresh",
  of: "of",
  other: "Other",
  addEmpty: "No process that runs without input yet.",
  openProcesses: "Open processes",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  never: "Not loaded yet",
  confirm: "New — refresh it yourself",
  waiting: "Waiting for you",
  openChat: "Open chat",
  failed: "Couldn't refresh",
  empty: "Nothing to show",
  more: "more",
  moveUp: "Move up",
  moveDown: "Move down",
  remove: "Remove from overview",
  policyLabel: "Refresh schedule",
  policy: {
    manual: "Manually",
    hourly: "Hourly",
    daily: "Daily",
    on_open: "On open",
  } satisfies Record<HubRefresh, string>,
  tasks: "Tasks",
  tasksCount: { one: "open item", other: "open items" } as PluralForms,
  tasksNone: "Nothing to resolve.",
  tasksWaiting: "Waiting for your answer",
  showAll: "Show all",
  editOverview: "Edit overview",
  emptyTitle: "Nothing here yet",
  widgets: "Widgets",
  presets: "Ready-made",
  fromProcess: "From a process",
  fromProcessHint: "The result of a process that runs without input.",
  back: "Back",
  addAction: "Add",
  briefLabel: "What do you want to see",
  sourcesLabel: "Sources",
  sourcesHint: "Optional. Without them the assistant picks.",
  editBrief: "Edit request",
  editWidget: "Set up",
  askWidget: "Ask",
  expand: "Expand",
  close: "Close",
  askAbout: (name: string, detail: string) =>
    `About the widget ${name}${detail ? ` (${detail})` : ""}: `,
  from: (names: string) => `From ${names}`,
  unknownType: "This version can't show this widget.",
  loadFailed: "The overview didn't load.",
  retry: "Try again",
  changeFailed: "The overview didn't change. Try again.",
  errors: {
    hub_process_unavailable: "The process is no longer available.",
    hub_process_needs_input: "The process needs input, so it can't run here.",
    hub_process_writes:
      "The process changes data without asking for approval, so it can't run here.",
    hub_refresh_interrupted: "The refresh was interrupted.",
    hub_run_unavailable: "The last run is no longer available.",
    hub_full: "The overview is full.",
    hub_item_exists: "It's already on the overview.",
    hub_view_invalid: "This view doesn't fit the process's data.",
    hub_layout_invalid: "The widgets don't fit like that.",
    hub_changed: "The overview changed meanwhile. Try again.",
    connection_required: "Connect the service in Connections.",
    budget: "The AI budget ran out. Ask an administrator.",
    access: "You can't run this process right now.",
    qualification_required: "The process needs a new test.",
    unavailable: "The process can't run now. Ask an administrator.",
    busy: "The assistant was busy. Try again.",
    process_step_limit: "The process hit its step limit.",
    process_duration_exceeded: "The process ran out of time.",
    process_output_invalid: "The process returned an invalid result.",
    hub_fill_invalid:
      "The assistant didn't return the data in the right shape.",
    hub_source_unavailable: "The chosen service is no longer available.",
    service_unavailable: "You have no service connected to read from.",
    hub_fill_limit: "The assistant hit its step limit.",
    hub_fill_no_data: "The assistant found nothing to read for this.",
    hub_fill_failed: "The assistant couldn't read the data.",
    hub_widget_invalid: "This widget's settings don't fit. Edit it.",
    catalog_model_required: "An administrator hasn't set up an AI model yet.",
    other: "Couldn't refresh.",
  },
  /** Why an AI widget can't fill, with the step that fixes it. */
  fix: {
    connect: "Your account isn't connected to the service.",
    noModel: "The overview has no AI model.",
    noReadable: "No service the overview can read yet.",
    unreadable: "The overview can't read the chosen service.",
    askAdmin: "Ask an administrator.",
    connectAction: "Connect account",
    routingAction: "Model routing",
    serviceAction: "Open service",
    servicesAction: "Services",
  },
  sourcesNone: "No service can be read by the overview yet.",
};
export type HubCopy = typeof en;
const cs: HubCopy = {
  overview: "Přehled",
  morning: "Dobré ráno",
  afternoon: "Dobré odpoledne",
  evening: "Dobrý večer",
  edit: "Upravit",
  done: "Hotovo",
  add: "Přidat widget",
  addTitle: "Přidat widget",
  builtIn: "Vestavěné",
  processes: "Procesy",
  newChat: "Nový chat",
  ask: "Zeptej se asistenta…",
  askSend: "Zeptat se",
  actions: "Akce widgetu",
  configure: "Nastavit zobrazení",
  rename: "Přejmenovat",
  move: "Přesunout",
  resize: "Změnit velikost",
  sheetTitle: "Widget",
  nameLabel: "Název",
  viewLabel: "Zobrazit jako",
  views: {
    number: "Číslo",
    chart: "Graf",
    list: "Seznam",
    table: "Tabulka",
    text: "Text",
    summary: "Souhrn",
    tasks: "Úkoly",
    widget: "Widget",
  },
  dataLabel: "Data",
  labelLabel: "Popisek",
  unitLabel: "Jednotka",
  compareLabel: "Porovnat s",
  compareNone: "Nic",
  comparePrevious: "Minulé obnovení",
  chartLabel: "Typ grafu",
  charts: {
    bar: "Sloupce",
    line: "Čára",
    area: "Plocha",
    pie: "Koláč",
  },
  xLabel: "Popisky",
  yLabel: "Hodnoty",
  titleField: "Název",
  subtitleField: "Detail",
  none: "Nic",
  columnsLabel: "Sloupce",
  save: "Uložit",
  cancel: "Zrušit",
  fieldsUnknown: "Nejdřív ho obnov, ať je vidět, jaká data vrací.",
  mismatch: "Proces teď vrací jiná data. Nastav zobrazení znovu.",
  sincePrevious: "oproti minule",
  of: "z",
  other: "Ostatní",
  addEmpty: "Zatím tu není proces, který jde spustit bez vstupů.",
  openProcesses: "Otevřít procesy",
  refresh: "Obnovit",
  refreshing: "Obnovuji…",
  never: "Zatím nenačteno",
  confirm: "Nový — obnov ručně",
  waiting: "Čeká na tebe",
  openChat: "Otevřít chat",
  failed: "Nepodařilo se obnovit",
  empty: "Nic k zobrazení",
  more: "další",
  moveUp: "Posunout výš",
  moveDown: "Posunout níž",
  remove: "Odebrat z přehledu",
  policyLabel: "Obnovovat",
  policy: {
    manual: "Ručně",
    hourly: "Každou hodinu",
    daily: "Denně",
    on_open: "Při otevření",
  },
  tasks: "Úkoly",
  tasksCount: {
    one: "otevřený úkol",
    few: "otevřené úkoly",
    other: "otevřených úkolů",
  },
  tasksNone: "Nic nečeká na vyřešení.",
  tasksWaiting: "Čeká na tvou odpověď",
  showAll: "Zobrazit vše",
  editOverview: "Upravit přehled",
  emptyTitle: "Zatím tu nic není",
  widgets: "Widgety",
  presets: "Připravené",
  fromProcess: "Z procesu",
  fromProcessHint: "Výsledek procesu, který běží bez vstupů.",
  back: "Zpět",
  addAction: "Přidat",
  briefLabel: "Co chceš vidět",
  sourcesLabel: "Zdroje",
  sourcesHint: "Nepovinné. Bez nich vybere asistent sám.",
  editBrief: "Upravit zadání",
  editWidget: "Nastavit",
  askWidget: "Zeptat se",
  expand: "Zvětšit",
  close: "Zavřít",
  askAbout: (name: string, detail: string) =>
    `K widgetu ${name}${detail ? ` (${detail})` : ""}: `,
  from: (names: string) => `Z: ${names}`,
  unknownType: "Tenhle widget tahle verze neumí.",
  loadFailed: "Přehled se nenačetl.",
  retry: "Zkusit znovu",
  changeFailed: "Přehled se nezměnil. Zkus to znovu.",
  errors: {
    hub_process_unavailable: "Proces už není dostupný.",
    hub_process_needs_input: "Proces potřebuje vstupy, tady ho spustit nejde.",
    hub_process_writes:
      "Proces mění data bez schválení, tady ho spustit nejde.",
    hub_refresh_interrupted: "Obnovení se přerušilo.",
    hub_run_unavailable: "Poslední běh už není dostupný.",
    hub_full: "Přehled je plný.",
    hub_item_exists: "Už je na přehledu.",
    hub_view_invalid: "Tohle zobrazení k datům procesu nesedí.",
    hub_layout_invalid: "Takhle se widgety nevejdou.",
    hub_changed: "Přehled se mezitím změnil. Zkus to znovu.",
    connection_required: "Připoj službu v Připojeních.",
    budget: "Došel rozpočet na AI. Ozvi se správci.",
    access: "Tenhle proces teď nemůžeš spustit.",
    qualification_required: "Proces je potřeba znovu otestovat.",
    unavailable: "Proces teď nejde spustit. Ozvi se správci.",
    busy: "Asistent byl zaneprázdněný. Zkus to znovu.",
    process_step_limit: "Proces narazil na limit kroků.",
    process_duration_exceeded: "Proces narazil na časový limit.",
    process_output_invalid: "Proces vrátil neplatný výsledek.",
    hub_fill_invalid: "Asistent nevrátil data ve správném tvaru.",
    hub_source_unavailable: "Vybraná služba už není dostupná.",
    service_unavailable:
      "Nemáš připojenou žádnou službu, ze které by šlo číst.",
    hub_fill_limit: "Asistent narazil na limit kroků.",
    hub_fill_no_data: "Asistent k tomuhle zadání nic nenačetl.",
    hub_fill_failed: "Asistent data nenačetl.",
    hub_widget_invalid: "Widget je nastavený špatně. Uprav zadání.",
    catalog_model_required: "Správce zatím nenastavil AI model.",
    other: "Nepodařilo se obnovit.",
  },
  fix: {
    connect: "Nemáš ke službě připojený účet.",
    noModel: "Přehled nemá AI model.",
    noReadable: "Zatím tu není služba, kterou přehled umí číst.",
    unreadable: "Vybranou službu přehled číst neumí.",
    askAdmin: "Ozvi se správci.",
    connectAction: "Připojit účet",
    routingAction: "Přiřazení modelů",
    serviceAction: "Otevřít službu",
    servicesAction: "Služby",
  },
  sourcesNone: "Zatím tu není služba, kterou přehled umí číst.",
};
export const hubCopy = { en, cs };
export function useHubCopy(): HubCopy {
  return hubCopy[useApp().language];
}

/** A short reason for a failed refresh; unknown codes get a generic line. */
export function hubErrorText(copy: HubCopy, code: string | undefined) {
  const errors = copy.errors;
  if (!code) return errors.other;
  if (code in errors) return errors[code as keyof typeof errors];
  if (/budget/.test(code)) return errors.budget;
  if (code === "catalog_busy" || code === "model_busy") return errors.busy;
  if (
    /^(identity_|auth_)/.test(code) ||
    /qualification_(stale|authority_changed)|definition_invalid|forbidden/.test(
      code,
    )
  )
    return errors.access;
  if (
    [
      "service_unavailable",
      "model_unavailable",
      "source_changed",
      "process_sources_changed",
      "process_not_active",
      "process_execution_unavailable",
    ].includes(code)
  )
    return errors.unavailable;
  return errors.other;
}

/** What fixes a failed AI widget: the app's own connect flow, or a page of
 * the administration (a separate app, so a plain link). */
export type HubFix =
  | { kind: "connect"; serviceId?: string }
  | {
      kind: "admin";
      href: string;
      label: "routingAction" | "serviceAction" | "servicesAction";
    };
/**
 * A failed AI widget (or a refused widget change) in one line, with the step
 * that fixes it when there is one. Codes without a fix read as `hubErrorText`.
 */
export function hubWidgetProblem(
  copy: HubCopy,
  code: string | undefined,
  context: { sources: { id: string }[]; isAdmin: boolean },
): { text: string; fix?: HubFix } {
  const only = context.sources.length === 1 ? context.sources[0]!.id : null;
  const admin = (text: string, fix: HubFix) =>
    context.isAdmin ? { text, fix } : { text: `${text} ${copy.fix.askAdmin}` };
  switch (code) {
    case "connection_required":
      return {
        text: copy.fix.connect,
        fix: { kind: "connect", ...(only ? { serviceId: only } : {}) },
      };
    case "model_unavailable":
    case "catalog_model_required":
      return admin(copy.fix.noModel, {
        kind: "admin",
        href: "/admin/routing",
        label: "routingAction",
      });
    case "service_unavailable":
    case "hub_source_unavailable":
      return admin(
        code === "service_unavailable"
          ? copy.fix.noReadable
          : copy.fix.unreadable,
        only
          ? {
              kind: "admin",
              href: `/admin/services/${encodeURIComponent(only)}`,
              label: "serviceAction",
            }
          : { kind: "admin", href: "/admin/services", label: "servicesAction" },
      );
  }
  return { text: hubErrorText(copy, code) };
}
