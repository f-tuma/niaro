import type { ProviderPresetIdValue } from "../../../packages/protocol/providers";
import type { ModelCapabilityProbeValue } from "../../../packages/protocol/service-catalog";
import { useAdmin } from "./context";

const en = {
  preset: "Preset",
  presetHint:
    "Fills in the address, key handling and defaults. You can change everything afterwards.",
  authType: "Key handling",
  authBearer: "Bearer token",
  authHeader: "Header",
  authNone: "No key",
  authHeaderName: "Header name",
  dialect: "Request format",
  dialectOpenai: "OpenAI-compatible",
  dialectOpenrouter: "OpenRouter",
  dialectHint:
    "OpenRouter adds its own privacy flags, audio catalogs, web search and decision models.",
  free: "Free or local",
  freeHint:
    "Its models cost nothing in usage limits. Only turn this on when the provider really does not charge.",
  freeBadge: "Free",
  dataHandling: "Data handling",
  dataHandlingHint:
    "What happens to data sent to this provider. Shown on the provider.",
  localHint:
    "A local server: add its address to the trusted origins in Settings before saving.",
  presetNotes: {
    openrouter:
      "Requests go to OpenRouter and the model providers it routes to. Niaro asks for no data collection and zero data retention.",
    openai: "Requests go to OpenAI under its API data policy.",
    anthropic: "Requests go to Anthropic under its API data policy.",
    gemini: "Requests go to Google under the Gemini API data policy.",
    azure: "Requests go to your Azure OpenAI resource in its region.",
    ollama: "Runs locally. Nothing leaves the server.",
    lmstudio: "Runs locally. Nothing leaves the server.",
    vllm: "Runs on your own infrastructure. Nothing leaves it.",
    llamacpp: "Runs locally. Nothing leaves the server.",
    localai: "Runs locally. Nothing leaves the server.",
    custom: "",
  } as Record<ProviderPresetIdValue, string>,
  imageInput: "Image input",
  testCapabilities: "Test capabilities",
  testHint:
    "Sends a few small requests to the provider. They count against the usage limits and the provider's daily requests.",
  testRunning: "Testing…",
  applyResults: "Use these results",
  testNothing: "This kind of model has nothing to test.",
  testStatus: {
    supported: "Supported",
    unsupported: "Not supported",
    failed: "Could not test",
    skipped: "Needs a voice",
  } as Record<"supported" | "unsupported" | "failed" | "skipped", string>,
  probes: {
    tools: "Tool calling",
    imageInput: "Image input",
    audioInput: "Audio input",
    audioOutput: "Audio output",
    transcription: "Transcription",
    speech: "Speech",
  } as Record<ModelCapabilityProbeValue, string>,
  unknownCapabilities: "Unknown, test after adding",
  searchElsewhere:
    "Web search and its search backends are set on the Models page.",
  openModels: "Open Models",
  searchBackends: "Search backends",
  searchBackendsHint:
    "SearXNG, Brave or Tavily for the whole organization. Pick one in Search with above.",
  addSearchBackend: "Add search backend",
  searchBackendSettings: "Search backend",
  searchKind: "Service",
  searchKeyHint: "Brave and Tavily need a key. SearXNG usually does not.",
  noSearchBackends: "No search backends yet.",
  deleteSearchBackend: "Delete search backend",
  confirmRemoveSearchBackend: "Delete this search backend?",
};
type ProviderCopy = typeof en;
const cs: ProviderCopy = {
  preset: "Předvolba",
  presetHint:
    "Vyplní adresu, práci s klíčem a výchozí hodnoty. Potom můžeš změnit cokoli.",
  authType: "Klíč",
  authBearer: "Bearer token",
  authHeader: "Hlavička",
  authNone: "Bez klíče",
  authHeaderName: "Název hlavičky",
  dialect: "Formát požadavků",
  dialectOpenai: "Kompatibilní s OpenAI",
  dialectOpenrouter: "OpenRouter",
  dialectHint:
    "OpenRouter přidává vlastní příznaky soukromí, katalogy audia, hledání na webu a rozhodovací modely.",
  free: "Zdarma nebo lokálně",
  freeHint:
    "Jeho modely nic nestojí v limitech využití. Zapni jen tehdy, když poskytovatel opravdu nic neúčtuje.",
  freeBadge: "Zdarma",
  dataHandling: "Nakládání s daty",
  dataHandlingHint:
    "Co se děje s daty poslanými tomuto poskytovateli. Zobrazí se u poskytovatele.",
  localHint:
    "Lokální server: před uložením přidej jeho adresu mezi důvěryhodné původy v Nastavení.",
  presetNotes: {
    openrouter:
      "Požadavky jdou do OpenRouteru a k poskytovatelům modelů, kam je směruje. Niaro žádá, aby data nesbírali ani neuchovávali.",
    openai: "Požadavky jdou do OpenAI podle jeho zásad pro data z API.",
    anthropic: "Požadavky jdou do Anthropicu podle jeho zásad pro data z API.",
    gemini: "Požadavky jdou do Googlu podle zásad pro data z Gemini API.",
    azure: "Požadavky jdou do tvého prostředku Azure OpenAI v jeho regionu.",
    ollama: "Běží lokálně. Nic neopustí server.",
    lmstudio: "Běží lokálně. Nic neopustí server.",
    vllm: "Běží na vlastní infrastruktuře. Nic ji neopustí.",
    llamacpp: "Běží lokálně. Nic neopustí server.",
    localai: "Běží lokálně. Nic neopustí server.",
    custom: "",
  },
  imageInput: "Vstup obrázků",
  testCapabilities: "Otestovat schopnosti",
  testHint:
    "Pošle poskytovateli pár malých požadavků. Počítají se do limitů využití a denních požadavků poskytovatele.",
  testRunning: "Testuji…",
  applyResults: "Použít výsledky",
  testNothing: "U tohoto druhu modelu není co testovat.",
  testStatus: {
    supported: "Podporováno",
    unsupported: "Nepodporováno",
    failed: "Nelze otestovat",
    skipped: "Chybí hlas",
  },
  probes: {
    tools: "Volání nástrojů",
    imageInput: "Vstup obrázků",
    audioInput: "Vstup audia",
    audioOutput: "Výstup audia",
    transcription: "Přepis",
    speech: "Řeč",
  },
  unknownCapabilities: "Neznámé, otestuj po přidání",
  searchElsewhere:
    "Hledání na webu a vyhledávače se nastavují na stránce Modely.",
  openModels: "Otevřít Modely",
  searchBackends: "Vyhledávače",
  searchBackendsHint:
    "SearXNG, Brave nebo Tavily pro celou organizaci. Vyber ho výše v Hledat přes.",
  addSearchBackend: "Přidat vyhledávač",
  searchBackendSettings: "Vyhledávač",
  searchKind: "Služba",
  searchKeyHint: "Brave a Tavily potřebují klíč. SearXNG obvykle ne.",
  noSearchBackends: "Zatím žádné vyhledávače.",
  deleteSearchBackend: "Smazat vyhledávač",
  confirmRemoveSearchBackend: "Smazat tento vyhledávač?",
};
export const providerCopy = { en, cs };
export function useProviderCopy() {
  return useAdmin().language === "cs" ? cs : en;
}
export type { ProviderCopy };
