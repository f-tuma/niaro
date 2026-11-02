/**
 * Fixed, synthetic Czech and English memories for NIAR-272 ranking tests.
 * Every name, company and number is invented. Nothing here comes from real
 * memories, and no measurement against real data is implied.
 */
export type RankingMemory = {
  key: string;
  kind: "preference" | "fact" | "note";
  content: string;
};

export const RANKING_MEMORIES: readonly RankingMemory[] = [
  {
    key: "pref-cs",
    kind: "preference",
    content: "Odpovídej česky a stručně, v odrážkách.",
  },
  {
    key: "pref-en",
    kind: "preference",
    content: "Keep answers short and use bullet lists.",
  },
  {
    key: "porada",
    kind: "fact",
    content: "Porada obchodního týmu je každé pondělí v 9:00 v zasedačce Brno.",
  },
  {
    key: "schuzka-mikulov",
    kind: "fact",
    content: "Schůzka s klientem Mikulov Wine je domluvená na čtvrtek 14:00.",
  },
  {
    key: "faktury-mikulov",
    kind: "note",
    content: "Faktury pro Mikulov Wine posílám vždy do 5. dne v měsíci.",
  },
  {
    key: "sefova-prodeje",
    kind: "fact",
    content: "Šéfová oddělení prodeje je Jana Dvořáková.",
  },
  {
    key: "projekt-cedar",
    kind: "fact",
    content: "Projekt Cedar: spuštění nového e-shopu v listopadu.",
  },
  {
    key: "schuzky-dodavatele",
    kind: "note",
    content: "Na schůzkách s dodavateli chci mít připravený ceník.",
  },
  {
    key: "prehled-prodeju",
    kind: "note",
    content: "Týdenní přehled prodejů posílám v pátek Petrovi.",
  },
  {
    key: "kontakt-novak",
    kind: "fact",
    content:
      "Kontaktní osoba ve firmě Stavby Novák je Pavel Novák, volat přes recepci.",
  },
  {
    key: "smlouvy",
    kind: "fact",
    content: "Smlouvy kontroluje právní oddělení, než je podepíšu.",
  },
  {
    key: "ukoly-crm",
    kind: "note",
    content: "Úkoly z porad zapisuji do Twenty CRM.",
  },
  {
    key: "dovolena",
    kind: "fact",
    content: "Dovolená od 20. do 27. prosince, zástup má Petr.",
  },
  {
    key: "objednavky",
    kind: "fact",
    content: "Objednávky nad 50 000 Kč schvaluje ředitel.",
  },
  {
    key: "pipeline",
    kind: "fact",
    content: "Weekly pipeline review with the sales team happens on Tuesdays.",
  },
  {
    key: "cedar-budget",
    kind: "fact",
    content: "The Cedar project budget is 1.2 million CZK.",
  },
  {
    key: "acme-invoices",
    kind: "note",
    content:
      "Invoices for Acme Logistics go out on the first working day of the month.",
  },
  {
    key: "meeting-notes",
    kind: "note",
    content: "Meeting notes are stored in the shared Teams channel.",
  },
  {
    key: "calls",
    kind: "note",
    content: "Video calls work best in the morning, never after 4 pm.",
  },
  {
    key: "acme-contact",
    kind: "fact",
    content: "Acme Logistics contact is Sarah Miller, procurement lead.",
  },
  {
    key: "acme-contracts",
    kind: "fact",
    content: "Contract renewals for Acme are due in March.",
  },
  {
    key: "board-report",
    kind: "note",
    content:
      "The quarterly report draft goes to the CFO two weeks before the board meeting.",
  },
];

/**
 * Expected leading non-preference results per query, in order. Preferences
 * always come first and are not listed. `only` means nothing else may follow.
 */
export const RANKING_QUERIES: readonly {
  query: string;
  top: readonly string[];
  only?: boolean;
}[] = [
  // Czech inflection: "schůzku" recalls "Schůzka" and "schůzkách".
  {
    query: "Kdy mám schůzku s klientem z Mikulova?",
    top: ["schuzka-mikulov", "schuzky-dodavatele"],
  },
  {
    query: "faktura Mikulov",
    top: ["faktury-mikulov", "schuzka-mikulov"],
    only: true,
  },
  { query: "porady", top: ["ukoly-crm", "porada"], only: true },
  { query: "Kdo schvaluje objednávky?", top: ["objednavky"], only: true },
  { query: "smlouva", top: ["smlouvy"], only: true },
  { query: "DOVOLENÁ", top: ["dovolena"], only: true },
  {
    query: "přehled prodejů",
    top: ["prehled-prodeju", "sefova-prodeje"],
    only: true,
  },
  // Accent and case folding work in both directions.
  { query: "schuzka mikulov", top: ["schuzka-mikulov"] },
  // English inflection by the same prefix rule.
  { query: "invoice", top: ["acme-invoices"], only: true },
  {
    query: "Who is the contact at Acme?",
    top: ["acme-contact", "acme-contracts", "acme-invoices"],
    only: true,
  },
  {
    query: "meetings",
    top: ["meeting-notes", "board-report"],
    only: true,
  },
  // The shorter record wins an otherwise equal match (length normalization).
  { query: "Cedar", top: ["cedar-budget", "projekt-cedar"], only: true },
  // Short tokens must match exactly; "kontrola" must not recall "Kontaktní".
  { query: "CRM", top: ["ukoly-crm"], only: true },
  { query: "kontrola", top: ["smlouvy"], only: true },
  // Stop words alone recall nothing beyond preferences.
  { query: "a je to the of", top: [], only: true },
];
