export const petCopy = (language: "en" | "cs") =>
  language === "cs"
    ? {
        title: "Ty a Niaro",
        observed: "Poznatky",
        saved: "Uložené",
        about: "O tobě",
        appearance: "Vzhled",
        all: "Všechny oblasti",
        work: "Práce",
        projects: "Projekty",
        tools: "Nástroje",
        people: "Lidé",
        style: "Styl",
        rhythm: "Rytmus",
        workScope: "Pracovní",
        personal: "Osobní",
        memory: "Používat paměť",
        empty: "Zatím tu nic není.",
        loading: "Načítání…",
        failed: "Nepodařilo se načíst. Zkus to znovu.",
        retry: "Zkusit znovu",
        refresh: "Načíst aktuální stav",
        conflict: "Paměť se změnila. Zkontroluj aktuální stav a zkus to znovu.",
        uncertain: "Uložení se nepodařilo potvrdit.",
        edit: "Upravit",
        correct: "Opravit",
        remove: "Smazat",
        erase: "Smazat vše",
        eraseHint:
          "Smazat soukromé vzpomínky včetně všech předchozích verzí? Zprávy a schůzky zůstanou.",
        removeHint: "Smazat tuto vzpomínku včetně předchozích verzí?",
        cancel: "Zrušit",
        save: "Uložit",
        done: "Hotovo",
        name: "Jméno",
        colour: "Barva",
        shape: "Tvar",
        auto: "Automaticky",
        animate: "Pohyb peta",
        chat: "Zobrazit v chatu",
        job: "Pozice",
        department: "Oddělení",
        sources: "Zdroje",
        removed: "Zdroj odstraněn",
        chatSource: "Chat",
        meetingSource: "Schůzka",
        inference: "Pozorování",
        assertion: "Přidáno tebou",
        verified: "Ověřený výsledek",
        unused: "Nepoužívá se",
        earlier: "Předchozí verze",
        loadMore: "Další",
        history: "Předchozí verze",
        unavailable: "Paměť není dostupná",
        manager: "Správa paměti",
        savedStatus: "Uloženo",
        more: "Více",
        statusEmpty: "Ještě tě poznává",
        statusAsleep: "Paměť spí",
        statusError: "Nepodařilo se načíst",
        statusKnowsSections: "Zná tvou práci a nástroje",
        today: "dnes",
        yesterday: "včera",
        personalKeep: "Uchovávat osobní poznatky",
        personalDrop: "Odstranit osobní poznatky",
        dropHint:
          "Odstranit všechny osobní poznatky včetně předchozích verzí? Výslovně uložené vzpomínky zůstanou.",
        classify: "Označit jako osobní",
        classifyWork: "Označit jako pracovní",
        // NIAR-272: what the learner never keeps (docs/guides/memory.md, Never kept).
        neverLearns: "Co si Niaro nikdy nezapíše",
        neverLearnsList:
          "Zdraví, etnický původ, politické názory, náboženské či filozofické přesvědčení, členství v odborech, sexuální život či orientace, biometrické či genetické údaje, hesla a klíče, čísla účtů, karet a rodná čísla.",
        neverLearnsHint: "Když něco proklouzne, smaž to.",
        shapes: [
          "Kruh",
          "Pilulka",
          "Sušenka",
          "Sluníčko",
          "Kytka",
          "Jetel",
          "Výbuch",
          "Oblázek",
          "Kočka",
          "Srdíčko",
        ],
      }
    : {
        title: "You and Niaro",
        observed: "Observed",
        saved: "Saved",
        about: "About you",
        appearance: "Appearance",
        all: "All sections",
        work: "Work",
        projects: "Projects",
        tools: "Tools",
        people: "People",
        style: "Style",
        rhythm: "Rhythm",
        workScope: "Work",
        personal: "Personal",
        memory: "Use memory",
        empty: "Nothing here yet.",
        loading: "Loading…",
        failed: "Couldn't load. Try again.",
        retry: "Try again",
        refresh: "Refresh current state",
        conflict: "This memory changed. Review it and try again.",
        uncertain: "Couldn't confirm the save.",
        edit: "Edit",
        correct: "Correct",
        remove: "Delete",
        erase: "Erase all",
        eraseHint:
          "Erase private memories and all earlier versions? Chats and meetings remain.",
        removeHint: "Delete this memory and its earlier versions?",
        cancel: "Cancel",
        save: "Save changes",
        done: "Done",
        name: "Name",
        colour: "Colour",
        shape: "Shape",
        auto: "Automatic",
        animate: "Animate",
        chat: "Show in chat",
        job: "Position",
        department: "Department",
        sources: "Sources",
        removed: "Source removed",
        chatSource: "Chat",
        meetingSource: "Meeting",
        inference: "Observation",
        assertion: "Added by you",
        verified: "Verified result",
        unused: "Not used",
        earlier: "Earlier version",
        loadMore: "Load more",
        history: "Earlier versions",
        unavailable: "Memory unavailable",
        manager: "Manage memory",
        savedStatus: "Saved",
        more: "More",
        statusEmpty: "Still learning you",
        statusAsleep: "Memory asleep",
        statusError: "Couldn't load",
        statusKnowsSections: "Knows your work, tools",
        today: "today",
        yesterday: "yesterday",
        personalKeep: "Keep personal observations",
        personalDrop: "Drop personal observations",
        dropHint:
          "Erase all personal observations and their earlier versions? Explicitly saved memories remain.",
        classify: "Mark as personal",
        classifyWork: "Mark as work",
        // NIAR-272: what the learner never keeps (docs/guides/memory.md, Never kept).
        neverLearns: "What Niaro never learns",
        neverLearnsList:
          "Health, ethnic origin, political opinions, religious or philosophical beliefs, trade union membership, sex life or sexual orientation, biometric or genetic data, passwords and keys, account, card and birth numbers.",
        neverLearnsHint: "If something slips through, delete it.",
        shapes: [
          "Circle",
          "Pill",
          "Cookie",
          "Sunny",
          "Flower",
          "Clover",
          "Burst",
          "Pebble",
          "Cat",
          "Heart",
        ],
      };

/** Czech counts: 1 věc · 2–4 věci · 5+ věcí; English keeps one plural. */
export const petPlural = (
  language: "en" | "cs",
  n: number,
  forms: readonly [one: string, few: string, many: string],
) =>
  n === 1
    ? forms[0]
    : language === "cs" && n >= 2 && n <= 4
      ? forms[1]
      : forms[2];
/** Calendar days between `iso` and now: dnes · včera · před N dny. */
export function petRelative(
  language: "en" | "cs",
  iso: string,
  now: Date = new Date(),
) {
  const then = new Date(iso);
  const day = (d: Date) =>
    Math.floor(
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 864e5,
    );
  const days = Math.max(0, day(now) - day(then));
  const c = petCopy(language);
  if (days === 0) return c.today;
  if (days === 1) return c.yesterday;
  return language === "cs" ? `před ${days} dny` : `${days} days ago`;
}
/** The new short device strings from the brief, with their plurals. */
export const petFormat = (language: "en" | "cs") => ({
  statusKnows: (n: number) =>
    language === "cs"
      ? `Zná ${n} ${petPlural(language, n, ["věc", "věci", "věcí"])} o tvé práci`
      : `Knows ${n} work ${petPlural(language, n, ["thing", "things", "things"])}`,
  countLabel: (n: number) =>
    language === "cs"
      ? `${n} ${petPlural(language, n, ["poznatek", "poznatky", "poznatků"])}`
      : `${n} ${petPlural(language, n, ["observation", "observations", "observations"])}`,
  lastSeen: (iso: string, now?: Date) =>
    `${language === "cs" ? "naposledy" : "last"} ${petRelative(language, iso, now)}`,
  sourcesCount: (n: number) =>
    language === "cs" ? `Zdroje (${n})` : `Sources (${n})`,
});
