import {
  LANGUAGE_KEY,
  browserLanguage,
  preferredLanguage,
  storeLanguage,
} from "../apps/server-admin/web/lib/language";

// The administration speaks the browser's language until someone picks one.
const store = new Map<string, string>();
const languages = (list: string[]) =>
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { languages: list, language: list[0] ?? "" },
  });
beforeAll(() =>
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  }),
);
beforeEach(() => store.clear());

test("a Czech browser opens the administration in Czech", () => {
  languages(["cs-CZ", "en-US"]);
  expect(browserLanguage()).toBe("cs");
  expect(preferredLanguage()).toBe("cs");
});

test("the first of Czech or English the browser lists wins; anything else is English", () => {
  languages(["de-DE", "en-GB", "cs"]);
  expect(browserLanguage()).toBe("en");
  languages(["sk", "cs", "en"]);
  expect(browserLanguage()).toBe("cs");
  languages(["fr"]);
  expect(browserLanguage()).toBe("en");
});

test("a stored choice wins over the browser, and only a choice is stored", () => {
  languages(["cs-CZ"]);
  expect(preferredLanguage()).toBe("cs");
  expect(store.size).toBe(0);
  storeLanguage("en");
  expect(store.get(LANGUAGE_KEY)).toBe("en");
  expect(preferredLanguage()).toBe("en");
});
