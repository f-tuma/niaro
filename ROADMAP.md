# Roadmap

Source: Itsaplan project NIAR (https://api-plan.f-tuma.dev), pulled 2026-11-23. Itsaplan stays the source of truth: refresh this file from it, do not edit plans here only.
Open work: 52 issues (2 In Progress, 19 Todo, 31 Backlog). Done initiatives are listed at the end.

## Initiatives with open work

### Integrace, identita a ověřené výsledky

Status active, priority high, 8/12 done (1 canceled).

Ověřit CRM a kalendář end-to-end, osobní OAuth a obnovu relací. Zápis je úspěšný až s doloženým výsledkem. Hotovo: osobní přihlášení ke službám s oprávněními v rukou uživatele, 30denní relace, registrace veřejného OAuth klienta (Twenty), automatické OAuth při přidání MCP služby (NIAR-202), MCP servery z jednoho definičního formátu, plugin SDK a checklist nastavení služby (NIAR-219). Otevřené: osobní přihlášení pro Spilberk CRM, živý řetězec CRM → kalendář (NIAR-47, NIAR-49), částečný zápis poznámky (NIAR-135).

- `NIAR-46` Todo · high — Ověřit skutečný osobní OAuth a identitu účinku služby
- `NIAR-47` Todo · high — Živě ověřit v pilotu: kontakt z Twenty → termín v kalendáři M365 přes chat
- `NIAR-31` Backlog · medium — Zavést stránkování rozsáhlých výsledků služeb a kontextu

### Osobní přehled a widgety plněné agentem

Status active, priority high, 5/6 done (0 canceled).

Přehled (/) je osobní dashboard ve stylu Twenty: registr typů widgetů (packages/protocol/widgets) a plnění AI přes uzavřeného Mastra agenta, který má jen čtecí akce a vynucený JSON výstup. Recept umožní levné obnovení, galerie a mřížka jdou upravovat. Typy widgetů: kalendář, pošta, shrnutí, KPI, graf, follow-upy, seznam, tabulka, schválení, schůzky. Hotovo i plánovač obnovení na serveru (NIAR-203), plnění z read-only MCP nástrojů a vysvětlení, proč widget nejde naplnit (NIAR-219). Widgety zůstávají systémové UI, generativní UI je jen v odpovědích chatu. Dokumentace: docs/hub.md. Otevřené: mobilní přehled (NIAR-204), automatická výška karet (NIAR-206).

- `NIAR-206` Backlog · low — Přehled: automatická výška karet podle obsahu a hustší výchozí velikosti

### Úklid po přechodu na OpenSpec: oprávnění, odstranění starého kódu a mezery

Status active, priority high, 3/17 done (0 canceled).

Po přechodu dokumentace na OpenSpec (NIAR-236) jsme při ověřování specifikací proti kódu našli díry v oprávněních, starý kód bez rozhraní a mezery v produktu. Každá položka má OpenSpec změnu v openspec/changes (proposal, design, tasks, delta specifikací) a projde kontrolou návrhu před implementací.

- `NIAR-237` In Progress · high — Externí AI aplikace členů: admin může vyžadovat schválení (vypnuto / se schválením / volně)
- `NIAR-238` In Progress · high — Nastavení celého serveru smí měnit jen vlastník instance, ne admin libovolné organizace
- `NIAR-239` Todo · medium — Odstranit zastaralá admin API: AI profily, CalDAV pracovního prostoru, TEST contacts, pole planner, staré párování aplikace
- `NIAR-240` Todo · medium — Odstranit testovací interpret: operátorsky spárované /v1/a a /v1/b, kalendářové návrhy, crm.contacts
- `NIAR-242` Todo · medium — Vyřazení firemního procesu z provozu
- `NIAR-243` Todo · medium — Obrazovka paměti pro člena ve webové aplikaci
- `NIAR-244` Todo · medium — Automatický test upgradu: nový image na datech staré verze
- `NIAR-241` Todo · low — Zrušit audio spike a přejmenovat aplikaci z Agent Client na Niaro
- `NIAR-247` Backlog · medium — Odstranit staré enginy agent-1 a progressive-1 a navazující obnovu otázek
- `NIAR-249` Backlog · medium — Člen si připojí AI aplikaci a schvaluje akce konektoru ze svého účtu
- `NIAR-248` Backlog · low — Oddělit organizace: instalované konektory, přihlašovací stránka a chyby pluginů
- `NIAR-310` Backlog · low — Nainstalované konektory: sdílený host a vlastní image jen pro vlastníka instance
- `NIAR-311` Backlog · low — Přihlašovací stránka ukazuje metody přihlášení všech organizací
- `NIAR-312` Backlog · low — Chyby načtení pluginů vidí admini všech organizací

### Mobilní aplikace jako harness nad webem

Status active, priority medium, 7/17 done (5 canceled).

Od října 2026 je hlavním produktem webová aplikace. Mobil sdílí protokol a client-core a webu se dotahuje. Generativní UI (OpenUI) už vykresluje vlastním rendererem nad lang-core a chat zobrazuje stejně jako web, s řádkem „Přemýšlím“ (NIAR-214, NIAR-215). Otevřené: přehled s widgety, osobní oprávnění služeb a skok na nalezenou zprávu (NIAR-204), fyzická akceptace schůzek (NIAR-140) a nativní procesní tok (NIAR-108).

- `NIAR-42` Backlog · high — Přijmout EN/CS přepis a kalibrovat kontrolu kritických údajů
- `NIAR-44` Backlog · high — Ověřit fyzickou audio matici nového voice capture
- `NIAR-45` Backlog · high — Ověřit mobilní TTS, věrnost zvuku a synchronizaci odpovědi
- `NIAR-21` Backlog · medium — Dodat nastavení soukromí, úložiště a bezpečného odpojení
- `NIAR-204` Backlog · medium — Mobil: přehled s widgety, osobní oprávnění služeb a skok na nalezenou zprávu

### Meetings: záznam, upload a artefakty

Status active, priority medium, 6/9 done (1 canceled).

Schůzky ve webu i na mobilu: nahrávání audia hovoru u nás (dvoustopé stereo, ffmpeg na serveru), přepis, souhrn a lidské úkoly; nikdy přepisy z Teams. Otevřené: import nahrávek Teams/Google, živý bot, fyzická akceptace mobilního záznamu (NIAR-140), bezpečný trigger po zpracování (NIAR-146).

- `NIAR-212` Todo · high — Schůzky fáze 3: kalendář, šablony, follow-up e-mail, CRM, vlastní poznámky, brief
- `NIAR-213` Backlog · low — Schůzky fáze 4: živý přepis, průběžný upload, import z Teams, bot

### Spolehlivý agent a dlouhodobá paměť

Status planned, priority high, 48/56 done (2 canceled).

Dokončit trvalé cíle, kontext a měřenou důvěryhodnost loopu. Již implementované ochrany se evidují odděleně od kvalitativního ověření.

- `NIAR-38` Todo · high — Změřit důvěryhodnost plánovače a checkeru na skutečných modelech
- `NIAR-189` Todo · high — Ověřit MCP end to end, obnovu spojení a připojení vlastních klientů
- `NIAR-30` Backlog · high — Zapojit bezpečné vyhledávání v archivu konverzací do kontextu agenta
- `NIAR-40` Backlog · medium — Zpřístupnit starší paměti serverovým vyhledáváním a stránkováním
- `NIAR-41` Backlog · low — Navrhnout oddělenou extrakci paměťových kandidátů z archivů
- `NIAR-181` Backlog · — — Ověřit gravitační přelévání hlasového orbu na telefonu

### Provoz, přenositelnost a soukromá beta

Status planned, priority medium, 6/15 done (0 canceled).

Uzavřít bezpečnostní, provozní, retenční a distribuční podmínky soukromé bety, dlouhodobý rozvoj evidovat jako backlog. Hotovo: nasazení na Dokploy, CI v paralelních jobech, první účet jako vlastník a export a import nastavení serveru (NIAR-217), repozitář připravený na open source (NIAR-218). Otevřené: retence a mazání dat, záloha a ověřená obnova, upgrade a ukončení serveru, obnova hesla a správa zařízení.

- `NIAR-19` Backlog · high — Dokončit nativní buildy a testovací distribuci klienta
- `NIAR-20` Backlog · high — Schválit nativní vizuální baseline a přístupnost hlavních toků
- `NIAR-23` Backlog · high — Samoobslužná obnova hesla e-mailem (SMTP)
- `NIAR-26` Backlog · high — Zavést retenci a scoped smazání serverových dat
- `NIAR-29` Backlog · medium — Doplnit bezpečnostní audit událostí a omezený export pro incidenty
- `NIAR-32` Backlog · medium — Vydat minimální backend SDK a ověřit druhou nezávislou implementaci
- `NIAR-33` Backlog · medium — Dodat generické push notifikace a bezpečné otevření čekající práce
- `NIAR-35` Backlog · low — Navrhnout webový builder nad sdíleným kontraktem
- `NIAR-36` Backlog · low — Vyhodnotit více instancí serveru a oddělené worker procesy

## Open issues without an initiative

- `NIAR-135` Todo · high — Dokončit poznámku u osoby a pravdivě zobrazit částečný CRM zápis
- `NIAR-140` Todo · high — Akceptace záznamu schůzky: skutečná schůzka na webu a fyzický telefon
- `NIAR-246` Todo · high — Pracovní mazlíček: postupně sbíraný profil člověka viditelný jako mazlíček
- `NIAR-259` Todo · high — Audio ze schůzek v S3 a lokální RustFS na dev serveru
- `NIAR-264` Todo · high — Telefon: připomínky z prvního testu aplikace
- `NIAR-288` Todo · high — MCP: připojení z Claude, ChatGPT a Codexu jedním kliknutím a bez hodinového odpojování
- `NIAR-306` Todo · low — Prozkoumat: asynchronní úlohy a multiplayer přes Pi Durable
- `NIAR-250` Todo · — — Přílohy a kamera v chatu s úložištěm S3, Hetzner a RustFS
- `NIAR-146` Backlog · high — Nastavit bezpečný procesní trigger po zpracování schůzky
- `NIAR-162` Backlog · high — Odstranit legacy smyčky až po ověřeném drainu
- `NIAR-309` Backlog · low — Mazlíček: počasí a prostředí peta (pet-weather, PetEnvironment)
- `NIAR-108` Backlog · — — Přijmout celý native procesní tok na fyzickém Androidu

## Initiatives with no open issues

- Webová aplikace: chat jako hlavní vstup, admin jako sekce, pilot (active, 8/8 done)
- Generativní UI v odpovědích (OpenUI) (active, 4/5 done)
- Dotažení chatu do spolehlivého provozu: rychlost, zbytky prototypu, provoz a pravdivé zápisy (active, 6/6 done)
- Jádro chatu na standardu: Mastra stream, AI SDK UI, nástroje přímo modelu (planned, 4/4 done)

## Follow-ups not in Itsaplan yet

From the NIAR-308 reviews (2026-11-13) and the 2026-11-23 checks. None blocks members.

- Attachment tests (`tests/attachment-*.node.ts`) are in no npm script and not in CI.
- Docs drift: `docs/guides/object-storage.md` still says backup tasks 4.4–4.5 are not implemented (backup scripts ship); `docs/guides/memory.md` still calls the pet page later work.
- Worktrees with symlinked `node_modules` fail 3 Pi tests (`pi-agent-core`, `pi-crash`) even on clean main; run full suites in the main checkout.
- Designer budget copy: `budget_exhausted` and `budget_overrun` show the same "used its per-run usage limit" text (`apps/server-admin/web/process-design-copy.ts`), so a price overrun reads as a spent limit.
- Price ceiling outside OpenRouter: enforced calls to other providers have no `max_price`, so a provider billing above the saved price still overruns and stops the turn (`apps/server-identity/inference-budget.ts`).
- Designer `resent` mark is never cleared after a successful resend (`apps/server-admin/web/lib/process-design-client.ts`).
- The designer turn-POST predicate is duplicated and `DESIGN_TURN_TIMEOUT_MS` covers all admin design paths (`apps/server-identity/service.ts`, naming).
- Step 1's earlier-overrun check runs after `readyHeld` opens the new run row (`apps/server-identity/process-design-conversation.ts`, order only).
- The `integration_unavailable` text ("Podrobnosti najdeš v odpovědi…") should be reworded.
- Shutdown: a socket busy during `close()` stays open up to 121 s after its response (keep-alive 120 s).
