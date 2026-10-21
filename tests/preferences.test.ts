import {
  loadLanguage,
  saveLanguage,
  loadSpokenReplies,
  saveSpokenReplies,
} from "../packages/client-core/preferences";
import { normalizeAddress } from "../packages/client-core/connection";
import { en, cs } from "../packages/i18n";
import { AudioSessionCoordinator } from "../spikes/audio/coordinator";
test("first install is EN; manual CS survives a new read", async () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      map.set(k, v);
    },
  };
  expect(await loadLanguage(storage)).toBe("en");
  expect(await loadSpokenReplies(storage)).toBe(true);
  await saveSpokenReplies(storage, false);
  expect(await loadSpokenReplies(storage)).toBe(false);
  await saveSpokenReplies(storage, true);
  expect(await loadSpokenReplies(storage)).toBe(true);
  await saveLanguage(storage, "cs");
  expect(await loadLanguage(storage)).toBe("cs");
  expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
  expect(Object.values(cs).every(Boolean)).toBe(true);
});
test("HTTP exception is explicit and private-network-only", () => {
  expect(() => normalizeAddress("http://192.168.1.5:8787/v1/a")).toThrow(
    "https_required",
  );
  expect(normalizeAddress("http://192.168.1.5:8787/v1/a", true)).toBe(
    "http://192.168.1.5:8787/v1/a",
  );
  expect(() => normalizeAddress("http://example.com/v1/a", true)).toThrow();
  for (const host of [
    "10.attacker.example",
    "127.attacker.example",
    "192.168.attacker.example",
    "172.16.attacker.example",
  ])
    expect(() => normalizeAddress(`http://${host}/v1/a`, true)).toThrow();
  expect(() => normalizeAddress("https://secret@example.com", true)).toThrow();
  expect(() => normalizeAddress("https://example.com?token=x")).toThrow();
});
test("audio coordinator excludes simultaneous microphone owners", () => {
  const c = new AudioSessionCoordinator();
  expect(c.current()).toBe(null);
  c.acquire("recording");
  expect(() => c.acquire("voice")).toThrow("audio_busy");
  c.release("voice");
  expect(c.current()).toBe("recording");
  c.release("recording");
  c.acquire("voice");
  expect(c.current()).toBe("voice");
});
