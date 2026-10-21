import { conversationTitle } from "../packages/client-core/conversation-title";

test.each([
  [
    "Ahoj, můžeš mi naplánovat schůzku s Petrem na zítra?",
    "Naplánovat schůzku s Petrem na zítra",
  ],
  [
    "Hi! Could you please find Novak Ltd in the CRM?",
    "Find Novak Ltd in the CRM",
  ],
  ["What's on my calendar tomorrow?", "What's on my calendar tomorrow"],
  ["prosím zkontroluj rozpočet. A pak pošli shrnutí.", "Zkontroluj rozpočet"],
  [
    "Připrav podklady k jednání s klientem Novák s.r.o. o rozpočtu na příští čtvrtletí",
    "Připrav podklady k jednání s klientem…",
  ],
  ["Hire a historian", "Hire a historian"],
])("%s → %s", (raw, title) => {
  expect(conversationTitle(raw)).toBe(title);
});
test("a message made only of an opener keeps its words", () => {
  expect(conversationTitle("Ahoj")).toBe("Ahoj");
  expect(conversationTitle("  ")).toBe("");
});
