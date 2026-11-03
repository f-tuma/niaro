import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import {
  ListCache,
  type CachedListSpec,
  type ListOwner,
} from "../../packages/client-core/list-cache";

/** The phone's lists from their last server answers (`ListCache`). The app
 * keeps it to the signed-in identity with `followConnections`. */
export const phoneLists = new ListCache(AsyncStorage);

/**
 * The last known items of a list while the server has not answered yet: at
 * once from this session, shortly after from the device. `remember` keeps a
 * server answer for next time; any answer replaces the seed on screen.
 */
export function useListSeed<T>(
  session: ListOwner | null,
  spec: CachedListSpec<T>,
  cache: ListCache = phoneLists,
) {
  const [seed, setSeed] = useState(() => ({
    session,
    spec,
    items: session ? cache.peek(session, spec) : undefined,
  }));
  useEffect(() => {
    if (!session) return;
    let current = true;
    void cache.read(session, spec).then(
      (items) => {
        if (current && items)
          setSeed((previous) =>
            previous.session === session &&
            previous.spec === spec &&
            previous.items
              ? previous
              : { session, spec, items },
          );
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [session, spec, cache]);
  const remember = useCallback(
    (items: readonly T[], options?: { fresh?: boolean; mark?: string }) => {
      if (session) void cache.write(session, spec, items, options);
    },
    [session, spec, cache],
  );
  const owned = seed.session === session && seed.spec === spec;
  return {
    seed: owned ? seed.items : session ? cache.peek(session, spec) : undefined,
    remember,
  };
}
