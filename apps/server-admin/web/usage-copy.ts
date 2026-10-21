import { useAdmin } from "./context";

const en = {
  title: "Usage limits",
  mode: "Mode",
  observe: "Observe",
  enforce: "Enforce",
  maxTokens: "Tokens per run",
  maxCost: "Cost per run",
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
  exceedsRun: "Even a short call exceeds the run limit.",
  enforceNeedsPrices:
    "In enforce mode, every model you use needs a price. Unpriced models cannot run.",
  designerNeedsEnforce:
    "The process designer and agent steps run only in enforce mode with a priced model.",
  filled: (count: number) =>
    count
      ? `Filled ${count} prices from providers.`
      : "Providers published no prices for these models.",
  fillFailed: "Could not load prices from the provider.",
  unsavedChanges: "Unsaved changes",
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
  enforce: "Vynucovat",
  maxTokens: "Tokenů na běh",
  maxCost: "Náklady na běh",
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
  exceedsRun: "I krátké volání překračuje limit běhu.",
  enforceNeedsPrices:
    "V režimu vynucování potřebuje každý používaný model cenu. Modely bez ceny nepoběží.",
  designerNeedsEnforce:
    "Návrhář procesů a kroky s agentem běží jen v režimu vynucování s oceněným modelem.",
  filled: (count: number) =>
    count
      ? `Ceny vyplněné od poskytovatelů: ${count}.`
      : "Poskytovatelé pro tyto modely ceny nezveřejnili.",
  fillFailed: "Ceny od poskytovatele se nepodařilo načíst.",
  unsavedChanges: "Neuložené změny",
  discardChanges: "Zahodit změny",
  save: "Uložit změny",
  saveFailed: "Limity se nepodařilo uložit. Načti stránku a zkus to znovu.",
  loadFailed: "Limity využití se nepodařilo načíst.",
  retry: "Zkusit znovu",
  readOnly: "Limity využití mohou měnit jen vlastníci a správci.",
};

export function useUsageCopy() {
  return useAdmin().language === "cs" ? cs : en;
}
