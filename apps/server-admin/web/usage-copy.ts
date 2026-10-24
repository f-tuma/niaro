import { useAdmin } from "./context";

const en = {
  title: "Usage limits",
  mode: "Mode",
  observe: "Observe",
  enforce: "Stop at limit",
  maxTokens: "Max per answer (tokens)",
  maxCost: "Max cost per answer",
  prices: "Model prices",
  pricesMeta: "USD per million tokens",
  priceUnit: "$/1M tok.",
  fillPrices: "Fill from providers",
  model: "Model",
  input: "Input",
  output: "Output",
  maxInput: "Max request",
  maxOutput: "Max reply",
  noPrice: "Not priced",
  noModels: "No chat models are enabled.",
  exceedsRun: "Even a short call exceeds the per-answer limit.",
  enforceNeedsPrices:
    "With Stop at limit, every model you use needs a price. Unpriced models cannot run.",
  designerNeedsEnforce:
    "The process designer and agent steps run only with Stop at limit and a priced model.",
  filled: (count: number) =>
    count
      ? `Filled ${count} prices from providers.`
      : "Providers published no prices for these models.",
  fillFailed: "Could not load prices from the provider.",
  unsavedChanges: "Unsaved changes",
  stalePrices: "Some models changed. Save to update their prices.",
  discardChanges: "Discard changes",
  save: "Save changes",
  saveFailed: "Could not save the limits. Reload and try again.",
  loadFailed: "Could not load the usage limits.",
  retry: "Try again",
  readOnly: "Only owners and admins can change usage limits.",
};
type UsageCopy = typeof en;
const cs: UsageCopy = {
  title: "Limity využití",
  mode: "Režim",
  observe: "Jen sledovat",
  enforce: "Zastavit na limitu",
  maxTokens: "Max. na odpověď (tokeny)",
  maxCost: "Max. cena za odpověď",
  prices: "Ceny modelů",
  pricesMeta: "USD za milion tokenů",
  priceUnit: "$/1M tok.",
  fillPrices: "Vyplnit od poskytovatelů",
  model: "Model",
  input: "Vstup",
  output: "Výstup",
  maxInput: "Max. požadavek",
  maxOutput: "Max. odpověď",
  noPrice: "Bez ceny",
  noModels: "Nejsou zapnuté žádné chatové modely.",
  exceedsRun: "I krátké volání překračuje limit na odpověď.",
  enforceNeedsPrices:
    "Při zastavení na limitu potřebuje každý používaný model cenu. Modely bez ceny nepoběží.",
  designerNeedsEnforce:
    "Návrhář procesů a kroky s agentem běží jen při zastavení na limitu a s oceněným modelem.",
  filled: (count: number) =>
    count
      ? `Ceny vyplněné od poskytovatelů: ${count}.`
      : "Poskytovatelé pro tyto modely ceny nezveřejnili.",
  fillFailed: "Ceny od poskytovatele se nepodařilo načíst.",
  unsavedChanges: "Neuložené změny",
  stalePrices: "Některé modely se změnily. Ulož a ceny se obnoví.",
  discardChanges: "Zahodit změny",
  save: "Uložit změny",
  saveFailed: "Limity se nepodařilo uložit. Načti stránku a zkus to znovu.",
  loadFailed: "Limity využití se nepodařilo načíst.",
  retry: "Zkusit znovu",
  readOnly: "Limity využití mohou měnit jen vlastníci a správci.",
};

export const usageCopy = { en, cs };
/**
 * The save bar's line. Right after loading, nothing was edited yet, but
 * prices pinned to an older model or provider revision still need a save.
 */
export function usageSaveStatus(
  copy: UsageCopy,
  state: { error: string | null; edited: boolean; stale: number },
) {
  return (
    state.error ??
    (!state.edited && state.stale > 0 ? copy.stalePrices : copy.unsavedChanges)
  );
}
export function useUsageCopy() {
  return useAdmin().language === "cs" ? cs : en;
}
