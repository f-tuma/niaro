import type { Language } from "./index";

/**
 * Why a process stopped or can't start, as one fixed sentence and at most one
 * next step. Every client reads the same table, and the server writes the
 * same sentence into a run's result, so no model and no provider text is
 * involved. The codes are Niaro's own safe codes: start inventory reasons,
 * start rejections and run failures.
 *
 * Actions are what the person can do next, never something that happens by
 * itself: `sign_in` opens Connections, `run_again` opens the start form with
 * the earlier input, `retest` opens the process's tests and `edit` opens the
 * process, where it is edited. A client shows an action only where it can
 * offer it to this person (members don't retest company processes; the phone
 * has no designer or tests).
 */
export const PROCESS_FAILURE_ACTIONS = [
  "sign_in",
  "run_again",
  "retest",
  "edit",
] as const;
export type ProcessFailureAction = (typeof PROCESS_FAILURE_ACTIONS)[number];
type Entry = Readonly<{
  action: ProcessFailureAction | null;
  en: string;
  cs: string;
}>;
const entry = (
  action: ProcessFailureAction | null,
  en: string,
  cs: string,
): Entry => ({ action, en, cs });

const signIn = entry(
  "sign_in",
  "A service it uses needs you to sign in.",
  "Služba, kterou používá, vyžaduje přihlášení.",
);
const changed = entry(
  "retest",
  "A service it uses changed, so it needs a new test.",
  "Služba, kterou používá, se změnila, takže potřebuje nový test.",
);
const untested = entry(
  "retest",
  "It needs a passing test before it can run.",
  "Než poběží, potřebuje úspěšný test.",
);
const interrupted = entry(
  "run_again",
  "It was interrupted before it finished.",
  "Přerušil se dřív, než skončil.",
);
const broken = entry(
  "edit",
  "Its definition can't run as it is. Fix it in the designer.",
  "Jeho definice takhle běžet nemůže. Oprav ji v návrháři.",
);
const budget = entry(
  null,
  "The workspace's AI budget is used up or not set.",
  "Rozpočet na AI v tomto prostoru je vyčerpaný nebo nenastavený.",
);

// NIAR-271: failure codes as one sentence and one next step.
export const PROCESS_FAILURES = {
  // Start inventory: why a process can't start now.
  connection_required: signIn,
  service_unavailable: entry(
    null,
    "A service it uses is off or unavailable.",
    "Služba, kterou používá, je vypnutá nebo nedostupná.",
  ),
  model_unavailable: entry(
    "edit",
    "Its AI model isn't available. Choose another one.",
    "Jeho model AI není dostupný. Vyber jiný.",
  ),
  source_changed: changed,
  qualification_required: untested,
  budget_unavailable: budget,
  // Start rejections.
  process_input_invalid: entry(
    "run_again",
    "The input didn't fit the form. Check it and start again.",
    "Vstup neodpovídal formuláři. Zkontroluj ho a spusť znovu.",
  ),
  process_origin_changed: entry(
    "run_again",
    "Its source changed before it started. Start it again.",
    "Jeho zdroj se před spuštěním změnil. Spusť ho znovu.",
  ),
  process_active_version_changed: entry(
    "run_again",
    "A newer version was turned on. Start it again.",
    "Mezitím se zapnula novější verze. Spusť ho znovu.",
  ),
  process_not_active: entry(
    null,
    "It's turned off.",
    "Je vypnutý.",
  ),
  process_sources_changed: changed,
  process_test_required: untested,
  process_qualification_required: untested,
  process_qualification_stale: untested,
  process_qualification_unavailable: untested,
  process_qualification_authority_changed: untested,
  process_test_conflict: untested,
  process_start_conflict: entry(
    null,
    "Another start with the same request is already recorded.",
    "Jiné spuštění se stejným požadavkem už je zaznamenané.",
  ),
  process_definition_invalid: broken,
  process_execution_unavailable: entry(
    null,
    "Processes can't run on this server right now.",
    "Procesy teď na tomto serveru nemůžou běžet.",
  ),
  // Run failures.
  process_step_limit: entry(
    "edit",
    "It needed more steps than its limits allow.",
    "Potřeboval víc kroků, než mu limity dovolí.",
  ),
  process_duration_exceeded: entry(
    "edit",
    "It ran longer than its time limit allows.",
    "Běžel déle, než mu časový limit dovolí.",
  ),
  process_cancelled: entry(
    "run_again",
    "It was stopped.",
    "Byl zastaven.",
  ),
  process_execution_failed: entry(
    "run_again",
    "It stopped on an error.",
    "Zastavil se na chybě.",
  ),
  process_action_failed: entry(
    "run_again",
    "One of its actions failed.",
    "Jedna z jeho akcí selhala.",
  ),
  process_action_rejected: entry(
    "run_again",
    "An action it needed was declined.",
    "Akce, kterou potřeboval, byla odmítnuta.",
  ),
  process_action_unknown: entry(
    null,
    "An action's result isn't confirmed. Check the service before you run it again.",
    "Výsledek akce není potvrzený. Než ho spustíš znovu, ověř stav ve službě.",
  ),
  process_output_invalid: entry(
    "edit",
    "Its result didn't match the declared output.",
    "Jeho výsledek neodpovídal deklarovanému výstupu.",
  ),
  process_checkpoint_interrupted: interrupted,
  process_checkpoint_invalid: interrupted,
  process_checkpoint_missing: interrupted,
  process_storage_unavailable: interrupted,
  process_graph_invalid: broken,
  process_compiler_incompatible: broken,
  process_compiler_unsupported: broken,
  process_agent_runtime_required: entry(
    null,
    "Its agent step can't run on this server right now.",
    "Jeho krok s agentem teď na tomto serveru nemůže běžet.",
  ),
  process_agent_budget_required: budget,
  process_approval_conflict: entry(
    null,
    "The approval changed in the meantime. Open the chat.",
    "Schválení se mezitím změnilo. Otevři chat.",
  ),
  process_question_conflict: entry(
    null,
    "The question changed in the meantime. Open the chat.",
    "Otázka se mezitím změnila. Otevři chat.",
  ),
  // Service failures that end a run.
  service_connection_required: signIn,
  service_oauth_connection_required: signIn,
  service_oauth_reconnect_required: signIn,
  service_oauth_token_expired: signIn,
  service_oauth_grant_revoked: signIn,
  service_access_denied: entry(
    null,
    "You don't have access to an action it uses.",
    "Nemáš přístup k akci, kterou používá.",
  ),
  catalog_action_denied: entry(
    null,
    "An action it uses isn't allowed for you.",
    "Akce, kterou používá, ti není povolená.",
  ),
  catalog_model_unavailable: entry(
    "edit",
    "Its AI model isn't available. Choose another one.",
    "Jeho model AI není dostupný. Vyber jiný.",
  ),
  catalog_provider_limit: entry(
    null,
    "A service's daily request limit was reached. Try again tomorrow.",
    "Služba dosáhla denního limitu požadavků. Zkus to zítra.",
  ),
  catalog_budget_exhausted: budget,
  catalog_budget_overrun: budget,
} as const satisfies Record<string, Entry>;
export type ProcessFailureCode = keyof typeof PROCESS_FAILURES;

const GENERIC = {
  en: "It stopped with code {code}.",
  cs: "Zastavil se s kódem {code}.",
};
/** Only a short identifier-like code is ever shown; anything else is "unknown". */
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

export type ProcessFailureCopy = Readonly<{
  code: string;
  known: boolean;
  sentence: string;
  action: ProcessFailureAction | null;
}>;

export function isProcessFailureCode(code: string): code is ProcessFailureCode {
  return Object.hasOwn(PROCESS_FAILURES, code);
}

/** The sentence and next step for a code; an unknown code reads as a generic
 * line that names it, with no action. */
export function processFailure(
  code: string,
  language: Language,
): ProcessFailureCopy {
  if (isProcessFailureCode(code)) {
    const known: Entry = PROCESS_FAILURES[code];
    return {
      code,
      known: true,
      sentence: language === "cs" ? known.cs : known.en,
      action: known.action,
    };
  }
  const safe = SAFE_CODE.test(code) ? code : "unknown";
  return {
    code: safe,
    known: false,
    sentence: (language === "cs" ? GENERIC.cs : GENERIC.en).replace(
      "{code}",
      safe,
    ),
    action: null,
  };
}
