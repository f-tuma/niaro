import type { Language } from "../../packages/protocol";

const copy = {
  cs: {
    tasks: "Úkoly",
    library: "Knihovna",
    composer: "Napiš nebo mluv…",
    composerLargeText: "Napiš…",
    context: "Přidat kontext",
    task: "Vybrat úkol",
    pet: "Niaro, tvůj společník",
    petTouch: "Pohladit Niara",
    yourTasks: "Tvoje úkoly",
    needsYou: "Čeká na tebe",
    speaking: "Čtu odpověď",
    stopSpeech: "Zastavit čtení",
  },
  en: {
    tasks: "Tasks",
    library: "Library",
    composer: "Type or speak…",
    composerLargeText: "Write…",
    context: "Add context",
    task: "Choose a task",
    pet: "Niaro, your companion",
    petTouch: "Pet Niaro",
    yourTasks: "Your tasks",
    needsYou: "Waiting for you",
    speaking: "Reading the reply",
    stopSpeech: "Stop reading",
  },
} as const;
export const companionCopy = (language: Language) => copy[language];
