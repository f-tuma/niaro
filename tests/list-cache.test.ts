import { z } from "zod";
import {
  CHAT_LIST,
  LIST_CACHE_INDEX_KEY,
  LIST_CACHE_MAX_BYTES,
  ListCache,
  followConnections,
  listCacheKey,
  type CachedListSpec,
  type ListCacheConnections,
  type ListOwner,
} from "../packages/client-core/list-cache";
import type { ConversationSummary } from "../packages/protocol";

const memory = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      values.delete(key);
    }),
  };
};
const settle = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
const ItemSchema = z.strictObject({ id: z.string(), title: z.string() });
type Item = z.infer<typeof ItemSchema>;
const spec: CachedListSpec<Item> = {
  name: "TEST-items",
  version: 1,
  item: ItemSchema,
  limit: 3,
  freshMs: 60_000,
};
const item = (id: string): Item => ({ id, title: `TEST ${id}` });
const alice = (): ListOwner => ({ identityKey: "TEST-server|alice" });
const bob = (): ListOwner => ({ identityKey: "TEST-server|bob" });

test("a server answer is kept on the device for its identity and read back by the next session", async () => {
  const storage = memory();
  const first = new ListCache(storage);
  const session = alice();
  await first.adopt(session.identityKey);
  await first.write(session, spec, [item("a"), item("b")]);
  expect(first.peek(session, spec)).toEqual([item("a"), item("b")]);

  // The next app run: nothing in memory, the device copy comes back.
  const next = new ListCache(storage);
  const later = alice();
  expect(next.peek(later, spec)).toBeUndefined();
  expect(await next.read(later, spec)).toEqual([item("a"), item("b")]);
  // A copy from the device is shown but never counts as current.
  expect(next.fresh(later, spec)).toBe(false);
  // Another person on the same device reads nothing of it.
  expect(await next.read(bob(), spec)).toBeUndefined();
  expect(storage.values.get(listCacheKey(later.identityKey, spec))).toContain(
    "TEST a",
  );
});

test("the server answer replaces the cached list, in memory and on the device", async () => {
  const storage = memory();
  const cache = new ListCache(storage);
  const session = alice();
  await cache.adopt(session.identityKey);
  await cache.write(session, spec, [item("a"), item("b")]);
  await cache.write(session, spec, [item("c")]);
  expect(cache.peek(session, spec)).toEqual([item("c")]);
  expect(await new ListCache(storage).read(alice(), spec)).toEqual([item("c")]);
  // An answer that arrived while the device was read wins over the copy.
  const slow = memory();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  slow.values = storage.values;
  slow.getItem.mockImplementation(async (key: string) => {
    await gate;
    return storage.values.get(key) ?? null;
  });
  const racing = new ListCache(slow);
  const owner = alice();
  void racing.adopt(owner.identityKey);
  const reading = racing.read(owner, spec);
  void racing.write(owner, spec, [item("d")]);
  release();
  expect(await reading).toEqual([item("d")]);
});

test("freshness: within the window and with the same change mark only; invalidate asks again", async () => {
  let now = 1_000_000;
  const cache = new ListCache(memory(), () => now);
  const session = alice();
  await cache.adopt(session.identityKey);
  expect(cache.fresh(session, spec, "1:0")).toBe(false);
  await cache.write(session, spec, [item("a")], { mark: "1:0" });
  expect(cache.fresh(session, spec, "1:0")).toBe(true);
  // An event since the answer (the cursor moved) makes it old at once.
  expect(cache.fresh(session, spec, "2:0")).toBe(false);
  now += 59_000;
  expect(cache.fresh(session, spec, "1:0")).toBe(true);
  now += 1_000;
  expect(cache.fresh(session, spec, "1:0")).toBe(false);
  await cache.write(session, spec, [item("a")], { mark: "1:0" });
  cache.invalidate(session, spec);
  expect(cache.fresh(session, spec, "1:0")).toBe(false);
  expect(cache.peek(session, spec)).toEqual([item("a")]);
  // A local edit is shown and kept, but is not a server answer.
  await cache.write(session, spec, [item("b")], { fresh: false });
  expect(cache.peek(session, spec)).toEqual([item("b")]);
  expect(cache.fresh(session, spec)).toBe(false);
  // Freshness belongs to one signed-in session, not to the identity.
  await cache.write(session, spec, [item("b")]);
  expect(cache.fresh(alice(), spec)).toBe(false);
});

test("versioned: an older envelope, another item version or a damaged copy is removed and never shown", async () => {
  const storage = memory();
  const cache = new ListCache(storage);
  const session = alice();
  await cache.adopt(session.identityKey);
  await cache.write(session, spec, [item("a")]);
  const key = listCacheKey(session.identityKey, spec);
  // The items' shape changed: version 2 has its own key and starts empty.
  const v2: CachedListSpec<Item & { due: string }> = {
    ...spec,
    version: 2,
    item: ItemSchema.extend({ due: z.string() }),
  };
  expect(await new ListCache(storage).read(alice(), v2)).toBeUndefined();
  // The same key with items that no longer parse is removed.
  storage.values.set(
    key,
    JSON.stringify({ version: 1, savedAt: 1, items: [{ id: 1 }] }),
  );
  expect(await new ListCache(storage).read(alice(), spec)).toBeUndefined();
  expect(storage.values.has(key)).toBe(false);
  // An envelope of another cache version is removed too.
  storage.values.set(
    key,
    JSON.stringify({ version: 0, savedAt: 1, items: [item("a")] }),
  );
  expect(await new ListCache(storage).read(alice(), spec)).toBeUndefined();
  expect(storage.values.has(key)).toBe(false);
  storage.values.set(key, "{not json");
  expect(await new ListCache(storage).read(alice(), spec)).toBeUndefined();
  expect(storage.values.has(key)).toBe(false);
});

test("bounded: the first `limit` items, fewer when they exceed the byte limit", async () => {
  const storage = memory();
  const cache = new ListCache(storage);
  const session = alice();
  await cache.adopt(session.identityKey);
  await cache.write(session, spec, ["a", "b", "c", "d", "e"].map(item));
  expect(cache.peek(session, spec)?.map((i) => i.id)).toEqual(["a", "b", "c"]);
  const big: CachedListSpec<Item> = { ...spec, name: "TEST-big", limit: 400 };
  const long = (id: string) => ({ id, title: "x".repeat(2_000) });
  await cache.write(
    session,
    big,
    Array.from({ length: 400 }, (_, n) => long(`i${n}`)),
  );
  const stored = storage.values.get(listCacheKey(session.identityKey, big))!;
  expect(stored.length).toBeLessThanOrEqual(LIST_CACHE_MAX_BYTES);
  const kept = JSON.parse(stored).items as Item[];
  expect(kept.length).toBeGreaterThan(0);
  expect(kept[0]!.id).toBe("i0");
});

test("the same answer again is not rewritten to the device", async () => {
  const storage = memory();
  let now = 1;
  const cache = new ListCache(storage, () => now);
  const session = alice();
  await cache.adopt(session.identityKey);
  await cache.write(session, spec, [item("a")]);
  const writes = storage.setItem.mock.calls.length;
  now = 2;
  await cache.write(session, spec, [item("a")]);
  expect(storage.setItem.mock.calls.length).toBe(writes);
  await cache.write(session, spec, [item("b")]);
  expect(storage.setItem.mock.calls.length).toBe(writes + 1);
});

test("signing out, an expired sign-in or another identity removes the lists; nothing is written afterwards", async () => {
  const storage = memory();
  const cache = new ListCache(storage);
  const listeners = new Set<() => void>();
  let state: ReturnType<ListCacheConnections["getSnapshot"]> = {
    status: "loading",
    session: null,
  };
  const connections: ListCacheConnections = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
  };
  const publish = async (next: typeof state) => {
    state = next;
    listeners.forEach((listener) => listener());
    await settle();
  };
  const stop = followConnections(connections, cache);
  const first = alice();
  await publish({ status: "connected", session: first });
  await cache.write(first, spec, [item("a")]);
  await cache.write(first, CHAT_LIST, [] as ConversationSummary[]);
  expect(JSON.parse(storage.values.get(LIST_CACHE_INDEX_KEY)!).keys).toEqual([
    listCacheKey(first.identityKey, spec),
    listCacheKey(first.identityKey, CHAT_LIST),
  ]);

  // Sign-out: memory and device are empty, and a late answer is dropped.
  let late!: (items: Item[]) => Promise<void>;
  const pending = new Promise<Item[]>((resolve) => {
    late = async (items) => {
      resolve(items);
      await settle();
    };
  });
  const lateWrite = pending.then((items) => cache.write(first, spec, items));
  await publish({ status: "signed_out", session: null });
  expect(cache.peek(first, spec)).toBeUndefined();
  expect([...storage.values.keys()]).toEqual([]);
  await late([item("late")]);
  await lateWrite;
  expect([...storage.values.keys()]).toEqual([]);
  expect(await cache.read(first, spec)).toBeUndefined();

  // Signed in again as alice, then another person on another server.
  const again = alice();
  await publish({ status: "connected", session: again });
  await cache.write(again, spec, [item("b")]);
  expect(await new ListCache(storage).read(alice(), spec)).toEqual([item("b")]);
  const other = bob();
  await publish({ status: "connected", session: other });
  expect(storage.values.has(listCacheKey(again.identityKey, spec))).toBe(false);
  // The previous identity's session can no longer read or write.
  await cache.write(again, spec, [item("c")]);
  expect(cache.peek(again, spec)).toBeUndefined();
  expect(storage.values.has(listCacheKey(again.identityKey, spec))).toBe(false);
  await cache.write(other, spec, [item("d")]);
  expect(cache.peek(other, spec)).toEqual([item("d")]);

  // An expired sign-in hides the lists as signing out does.
  await publish({ status: "expired", session: null });
  expect([...storage.values.keys()]).toEqual([]);
  stop();
});

test("a remove that fails still forgets the lists in memory", async () => {
  const storage = memory();
  const cache = new ListCache({
    getItem: storage.getItem,
    setItem: storage.setItem,
    removeItem: () => Promise.reject(new Error("TEST unavailable")),
  });
  const session = alice();
  await cache.adopt(session.identityKey);
  await cache.write(session, spec, [item("a")]);
  await cache.forget();
  expect(cache.peek(session, spec)).toBeUndefined();
  expect(await cache.read(session, spec)).toBeUndefined();
});
