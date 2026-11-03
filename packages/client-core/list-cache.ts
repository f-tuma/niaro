import { z } from "zod";
import type { KeyValueStorage } from "./preferences";
import {
  ConversationSummarySchema,
  type ConversationSummary,
} from "../protocol";
import { MeetingSchema, type Meeting } from "../protocol/meetings";
import {
  HumanTaskSchema,
  type HumanTask,
  type HumanTaskTab,
} from "../protocol/human-tasks";
import { MemberService } from "../protocol/member-services";

/**
 * Lists the phone keeps from its last server answer (chats in the menu,
 * tasks, meetings, the person's services), so a screen shows them at once
 * and asks the server again only when they may have changed.
 *
 * - One identity at a time: the lists of the signed-in person on one server
 *   (`ClientSession.identityKey`: address, connection, server, person,
 *   workspace). Signing out, an expired sign-in or another identity removes
 *   every list of the previous one.
 * - Versioned: `LIST_CACHE_VERSION` (the envelope) and each list's own
 *   `version` are part of the key; a stored value that no longer parses is
 *   removed, never shown.
 * - Bounded: at most `limit` items and `LIST_CACHE_MAX_BYTES` per list.
 * - What servers answered only: never credentials, drafts or commands.
 * - Freshness lives in memory for one signed-in session: a list read from the
 *   device is shown but always asked again once in that session.
 */
export interface ListCacheStorage extends KeyValueStorage {
  removeItem(key: string): Promise<void>;
}

/** The stored envelope's version; raising it drops every stored list. */
export const LIST_CACHE_VERSION = 1;
const PREFIX = `niaro.lists.v${LIST_CACHE_VERSION}`;
/** Which identity's lists are on the device, and under which keys. */
export const LIST_CACHE_INDEX_KEY = `${PREFIX}.index`;
export const LIST_CACHE_MAX_BYTES = 256 * 1024;

export type CachedListSpec<T> = {
  /** Part of the key: `chats`, `tasks-open`, `meetings`, … */
  name: string;
  /** The items' own version; raise it when `item` changes incompatibly. */
  version: number;
  item: z.ZodType<T>;
  /** Items kept on the device, from the start of the list. */
  limit: number;
  /** How long a server answer counts as current within one session. */
  freshMs: number;
};

/** The owner of in-memory lists: one signed-in `ClientSession`. */
export type ListOwner = { readonly identityKey: string };

export const listCacheKey = (
  identityKey: string,
  spec: Pick<CachedListSpec<unknown>, "name" | "version">,
) => `${PREFIX}:${spec.name}.${spec.version}:${identityKey}`;

const Envelope = z.strictObject({
  version: z.literal(LIST_CACHE_VERSION),
  savedAt: z.number().int().nonnegative(),
  items: z.array(z.unknown()),
});
const IndexSchema = z.strictObject({
  version: z.literal(LIST_CACHE_VERSION),
  identity: z.string().min(1).max(2000),
  keys: z.array(z.string().max(2400)).max(64),
});
type Index = z.infer<typeof IndexSchema>;

type Entry = {
  items: readonly unknown[];
  /** When the server answered in this session; absent for device copies. */
  fetchedAt?: number;
  /** What the caller's change signal said when the server answered. */
  mark?: string;
};

export class ListCache {
  private memory = new WeakMap<ListOwner, Map<string, Entry>>();
  /** `undefined` until told; `null` while signed out. */
  private identity: string | null | undefined;
  /** Bumped whenever the identity changes; late writes of another one drop. */
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private index: Index | null | undefined;
  private written = new Map<string, string>();
  constructor(
    private storage: ListCacheStorage,
    private now: () => number = () => Date.now(),
  ) {}

  private allowed(owner: ListOwner) {
    return (
      typeof owner.identityKey === "string" &&
      owner.identityKey.length > 0 &&
      this.identity !== null &&
      (this.identity === undefined || this.identity === owner.identityKey)
    );
  }
  private entries(owner: ListOwner) {
    let entries = this.memory.get(owner);
    if (!entries) {
      entries = new Map();
      this.memory.set(owner, entries);
    }
    return entries;
  }
  /** Device storage work runs one at a time, in call order. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(operation);
    this.queue = next;
    return next;
  }
  private async readIndex(): Promise<Index | null> {
    if (this.index !== undefined) return this.index;
    try {
      const raw = await this.storage.getItem(LIST_CACHE_INDEX_KEY);
      const parsed = raw ? IndexSchema.safeParse(JSON.parse(raw)) : null;
      this.index = parsed?.success ? parsed.data : null;
    } catch {
      this.index = null;
    }
    return this.index;
  }
  private async purge() {
    const index = await this.readIndex();
    const keys = new Set(index?.keys ?? []);
    for (const key of this.written.keys()) keys.add(key);
    this.written.clear();
    await Promise.all(
      [...keys, LIST_CACHE_INDEX_KEY].map((key) => this.remove(key)),
    );
    this.index = null;
  }
  private async remove(key: string) {
    try {
      await this.storage.removeItem(key);
    } catch {
      // Best effort: an unreadable copy is ignored on the next read anyway.
    }
  }

  /**
   * The items shown last in this session, synchronously (a re-opened screen
   * starts with them).
   */
  peek<T>(owner: ListOwner, spec: CachedListSpec<T>): T[] | undefined {
    if (!this.allowed(owner)) return undefined;
    return this.memory
      .get(owner)
      ?.get(listCacheKey(owner.identityKey, spec))
      ?.items.slice() as T[] | undefined;
  }
  /** The items from this session or, failing that, from the device. */
  async read<T>(
    owner: ListOwner,
    spec: CachedListSpec<T>,
  ): Promise<T[] | undefined> {
    const shown = this.peek(owner, spec);
    if (shown || !this.allowed(owner)) return shown;
    const key = listCacheKey(owner.identityKey, spec);
    const epoch = this.epoch;
    const items = await this.serial(async () => {
      if (epoch !== this.epoch) return undefined;
      const index = await this.readIndex();
      if (index && index.identity !== owner.identityKey) return undefined;
      let raw: string | null | undefined;
      try {
        raw = await this.storage.getItem(key);
      } catch {
        return undefined;
      }
      if (!raw) return undefined;
      const parsed = (() => {
        try {
          const envelope = Envelope.parse(JSON.parse(raw));
          return z
            .array(spec.item)
            .max(spec.limit)
            .parse(envelope.items) as T[];
        } catch {
          return undefined;
        }
      })();
      // An older or damaged copy is removed, never shown.
      if (!parsed) await this.remove(key);
      return parsed;
    });
    if (!items || epoch !== this.epoch || !this.allowed(owner))
      return undefined;
    const entries = this.entries(owner);
    // A server answer that arrived meanwhile wins.
    const current = entries.get(key);
    if (current) return current.items.slice() as T[];
    entries.set(key, { items });
    return items.slice();
  }
  /** Whether the server answered for this list in this session within
   * `freshMs`, with the same change `mark`. */
  fresh(owner: ListOwner, spec: CachedListSpec<unknown>, mark?: string) {
    if (!this.allowed(owner)) return false;
    const entry = this.memory
      .get(owner)
      ?.get(listCacheKey(owner.identityKey, spec));
    return (
      entry?.fetchedAt !== undefined &&
      this.now() - entry.fetchedAt < spec.freshMs &&
      entry.mark === mark
    );
  }
  /** The next screen that shows the list asks the server again. */
  invalidate(owner: ListOwner, spec?: CachedListSpec<unknown>) {
    const entries = this.memory.get(owner);
    if (!entries) return;
    for (const [key, entry] of entries)
      if (!spec || key === listCacheKey(owner.identityKey, spec))
        entries.set(key, { items: entry.items });
  }
  /**
   * Keeps `items` as the list's current state. A server answer (`fresh`)
   * counts as current for `freshMs` with its change `mark`; a local edit
   * (`fresh: false`) only replaces what is shown. The device keeps the first
   * `limit` items, fewer when they exceed `LIST_CACHE_MAX_BYTES`.
   */
  async write<T>(
    owner: ListOwner,
    spec: CachedListSpec<T>,
    items: readonly T[],
    { fresh = true, mark }: { fresh?: boolean; mark?: string } = {},
  ) {
    if (!this.allowed(owner)) return;
    if (this.identity === undefined) void this.adopt(owner.identityKey);
    const key = listCacheKey(owner.identityKey, spec);
    const kept = items.slice(0, spec.limit);
    this.entries(owner).set(
      key,
      fresh ? { items: kept, fetchedAt: this.now(), mark } : { items: kept },
    );
    const epoch = this.epoch;
    await this.serial(async () => {
      if (epoch !== this.epoch) return;
      let stored = kept;
      let value = this.envelope(stored);
      while (value.length > LIST_CACHE_MAX_BYTES && stored.length) {
        stored = stored.slice(0, Math.floor(stored.length / 2));
        value = this.envelope(stored);
      }
      if (this.written.get(key) === this.withoutTime(value)) return;
      const index = (await this.readIndex()) ?? {
        version: LIST_CACHE_VERSION as 1,
        identity: owner.identityKey,
        keys: [],
      };
      if (index.identity !== owner.identityKey || epoch !== this.epoch) return;
      if (!index.keys.includes(key)) {
        const next = { ...index, keys: [...index.keys, key] };
        await this.storage.setItem(LIST_CACHE_INDEX_KEY, JSON.stringify(next));
        this.index = next;
      }
      await this.storage.setItem(key, value);
      this.written.set(key, this.withoutTime(value));
    }).catch(() => {});
  }
  private envelope(items: readonly unknown[]) {
    return JSON.stringify({
      version: LIST_CACHE_VERSION,
      savedAt: this.now(),
      items,
    });
  }
  /** Rewriting the same items every poll would only wear the device. */
  private withoutTime(value: string) {
    return value.replace(/"savedAt":\d+,/, "");
  }

  /** The signed-in identity: lists of any other one leave the device. */
  adopt(identityKey: string) {
    if (this.identity === identityKey)
      return this.queue.then(
        () => {},
        () => {},
      );
    this.identity = identityKey;
    this.epoch++;
    this.memory = new WeakMap();
    return this.serial(async () => {
      const index = await this.readIndex();
      if (index?.identity === identityKey) return;
      await this.purge();
      if (this.identity !== identityKey) return;
      const fresh: Index = {
        version: LIST_CACHE_VERSION,
        identity: identityKey,
        keys: [],
      };
      await this.storage.setItem(LIST_CACHE_INDEX_KEY, JSON.stringify(fresh));
      this.index = fresh;
    }).catch(() => {});
  }
  /** Signed out: every list leaves memory and the device. */
  forget() {
    this.identity = null;
    this.epoch++;
    this.memory = new WeakMap();
    return this.serial(() => this.purge()).catch(() => {});
  }
}

/** The parts of `Connections` the cache follows. */
export type ListCacheConnections = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    status: "loading" | "signed_out" | "pairing" | "connected" | "expired";
    session: ListOwner | null;
  };
};
/**
 * Keeps the cache to the signed-in identity: a new identity (another person
 * or server) replaces the stored lists, signing out or an expired sign-in
 * removes them. Returns the unsubscribe.
 */
export function followConnections(
  connections: ListCacheConnections,
  cache: ListCache,
) {
  let last: string | null | undefined;
  const check = () => {
    const { status, session } = connections.getSnapshot();
    if (status === "connected" && session) {
      if (last === session.identityKey) return;
      last = session.identityKey;
      void cache.adopt(session.identityKey);
    } else if (status === "signed_out" || status === "expired") {
      if (last === null) return;
      last = null;
      void cache.forget();
    }
  };
  check();
  return connections.subscribe(check);
}

/** The menu's chats: the newest 200 active ones (titles, times, counts). */
export const CHAT_LIST: CachedListSpec<ConversationSummary> = {
  name: "chats",
  version: 1,
  item: ConversationSummarySchema,
  limit: 200,
  freshMs: 2 * 60_000,
};
/** The meeting list: the newest 50 meetings as listed (no records). */
export const MEETING_LIST: CachedListSpec<Meeting> = {
  name: "meetings",
  version: 1,
  item: MeetingSchema,
  limit: 50,
  freshMs: 2 * 60_000,
};
const taskList = (tab: HumanTaskTab): CachedListSpec<HumanTask> => ({
  name: `tasks-${tab}`,
  version: 1,
  item: HumanTaskSchema,
  limit: 50,
  freshMs: 2 * 60_000,
});
/** The first page of each Tasks tab. */
export const TASK_LISTS: Record<HumanTaskTab, CachedListSpec<HumanTask>> = {
  open: taskList("open"),
  done: taskList("done"),
};
/** Where Niaro reads for the person (Settings): no addresses or credentials. */
export const SERVICE_LIST: CachedListSpec<MemberService> = {
  name: "services",
  version: 1,
  item: MemberService,
  limit: 100,
  freshMs: 2 * 60_000,
};
