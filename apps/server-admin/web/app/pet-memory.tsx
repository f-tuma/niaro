import {
  useEffectEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "./context";
import { api } from "../lib/api";
import {
  PetProfileSchema,
  PetMemoryPageSchema,
} from "../../../../packages/protocol/work-pet";
import type {
  PetMemoryCommand,
  PetMemoryPage,
  PetMemoryQuery,
  SavePetProfile,
} from "../../../../packages/protocol/work-pet";
export { profilePetAppearance as profileAppearance } from "../../../shared/pet-appearance";

/**
 * One event stream per pet scope, shared by every hook on the page: the
 * server says `pet` when the profile or its memory changed anywhere (the
 * phone included), and `ready` after each (re)connect, when a change may
 * have been missed.
 */
const petStreams = new Map<
  string,
  { source: EventSource; listeners: Set<() => void> }
>();
function watchPet(query: string, listener: () => void) {
  if (typeof EventSource === "undefined") return () => {};
  let stream = petStreams.get(query);
  if (!stream) {
    const source = new EventSource(`/admin/api/identity/pet/events?${query}`);
    const listeners = new Set<() => void>();
    let opened = false;
    const notify = () => listeners.forEach((fn) => fn());
    source.addEventListener("pet", notify);
    source.addEventListener("ready", () => {
      // The first connect follows the initial read; reconnects catch up.
      if (opened) notify();
      opened = true;
    });
    stream = { source, listeners };
    petStreams.set(query, stream);
  }
  const current = stream;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size) return;
    current.source.close();
    if (petStreams.get(query) === current) petStreams.delete(query);
  };
}
function usePetTransport() {
  const { workspace, identity } = useApp();
  const userId = identity.user?.id;
  return useMemo(() => {
    const suffix = new URLSearchParams({
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
      profile: "work-pet/1",
    });
    const validate = <
      T extends { organizationId: string; workspaceId: string; userId: string },
    >(
      value: T,
    ): T => {
      if (
        value.organizationId !== workspace.organizationId ||
        value.workspaceId !== workspace.workspaceId ||
        value.userId !== userId
      )
        throw Error("owner_changed");
      return value;
    };
    return {
      events: suffix.toString(),
      petProfile: async (signal?: AbortSignal) =>
        validate(
          PetProfileSchema.parse(
            await api(`identity/pet?${suffix}`, undefined, signal),
          ),
        ),
      savePetProfile: async (body: SavePetProfile) =>
        validate(
          PetProfileSchema.parse(await api(`identity/pet?${suffix}`, body)),
        ),
      petMemory: async (query: PetMemoryQuery) => {
        const params = new URLSearchParams(suffix);
        Object.entries(query).forEach(([k, v]) => {
          if (v !== undefined) params.set(k, String(v));
        });
        return validate(
          PetMemoryPageSchema.parse(await api(`identity/pet/memory?${params}`)),
        );
      },
      savePetMemory: async (body: PetMemoryCommand) =>
        validate(
          PetMemoryPageSchema.parse(
            await api(`identity/pet/memory?${suffix}`, body),
          ),
        ),
    };
  }, [workspace.organizationId, workspace.workspaceId, userId]);
}
export function usePetProfile() {
  const { workspace, identity } = useApp();
  const session = usePetTransport();
  const key = [
    "pet-profile",
    workspace.organizationId,
    workspace.workspaceId,
    identity.user?.id,
  ];
  const client = useQueryClient();
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => session!.petProfile(signal),
    enabled: !!session,
    retry: false,
  });
  const events = session?.events;
  const keyText = JSON.stringify(key);
  useEffect(() => {
    if (!events) return;
    return watchPet(events, () => {
      void client.invalidateQueries({ queryKey: JSON.parse(keyText) });
    });
  }, [events, client, keyText]);
  return {
    ...query,
    save: async (update: SavePetProfile) => {
      const next = await session!.savePetProfile(update);
      if (!next) throw Error("unsupported");
      client.setQueryData(key, next);
      return next;
    },
  };
}
export function usePetMemory(query: PetMemoryQuery) {
  const session = usePetTransport();
  const filter = JSON.stringify(query);
  const owner = useMemo(() => ({ session, filter }), [session, filter]);
  const current = useRef(owner);
  useLayoutEffect(() => {
    current.current = owner;
  }, [owner]);
  const [result, setResult] = useState<{
    owner: typeof owner;
    page: PetMemoryPage | null;
  }>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  async function read(more = false) {
    const ticket = ++version.current;
    setBusy(true);
    setError(false);
    try {
      const page = await session!.petMemory({
        ...JSON.parse(filter),
        ...(more && result?.owner === owner && result.page?.nextCursor
          ? { cursor: result.page.nextCursor }
          : {}),
      });
      if (current.current !== owner || ticket !== version.current) return;
      if (more && page && result?.page && page.version !== result.page.version)
        throw Error("memory_context_changed");
      setResult({
        owner,
        page:
          more && page && result?.page
            ? { ...page, items: [...result.page.items, ...page.items] }
            : page,
      });
      return page;
    } catch {
      if (current.current === owner && ticket === version.current)
        setError(true);
    } finally {
      if (current.current === owner && ticket === version.current)
        setBusy(false);
    }
  }
  const readSelection = useEffectEvent(read);
  useEffect(() => {
    const tickets = version;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Loading state belongs to the newly selected server query.
    void readSelection();
    return () => {
      tickets.current++;
    };
  }, [owner]); // owner binds both identity and filters
  const events = session?.events;
  useEffect(() => {
    if (!events) return;
    // A change made on the phone shows here without reloading.
    return watchPet(events, () => void readSelection());
  }, [events]);
  async function save(command: PetMemoryCommand) {
    const page = await session!.savePetMemory(command);
    if (current.current !== owner) throw Error("owner_changed");
    if (!page) throw Error("unsupported");
    return page;
  }
  return {
    page: result?.owner === owner ? result.page : undefined,
    busy,
    error,
    read,
    save,
    owner,
  };
}
