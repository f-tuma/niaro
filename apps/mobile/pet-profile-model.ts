import { AppState } from "react-native";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ClientSession } from "../../packages/client-core/session";
import type {
  PetProfile,
  SavePetProfile,
} from "../../packages/protocol/work-pet";
export { profilePetAppearance as nativePetAppearance } from "../shared/pet-appearance";

/** Polling interval for servers that cannot stream pet changes. */
export const PET_PROFILE_REFRESH_MS = 30_000;

export function useNativePetProfile(session: ClientSession | null) {
  const scope = useMemo(() => ({ session }), [session]);
  const [state, setState] = useState<{
    owner: typeof scope;
    profile: PetProfile | null;
  }>();
  const [error, setError] = useState(false);
  const owner = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => {
    owner.current = scope;
    return () => {
      if (owner.current === scope) owner.current = null;
    };
  }, [scope]);
  const request = useRef(0);
  const read = useCallback(async () => {
    if (!session) return;
    const ticket = ++request.current;
    setError(false);
    try {
      const profile = await session.petProfile();
      if (owner.current === scope && request.current === ticket)
        setState((previous) =>
          previous?.owner === scope &&
          previous.profile &&
          profile &&
          previous.profile.revision > profile.revision
            ? previous
            : { owner: scope, profile },
        );
    } catch {
      if (owner.current === scope && request.current === ticket) setError(true);
    }
  }, [session, scope]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Synchronize the session-owned remote profile and its loading state.
    void read();
    const tickets = request;
    return () => {
      tickets.current++;
    };
  }, [read]);
  // Bumped when the pet changed elsewhere, so open screens re-read memory too.
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (!session) return;
    let following: AbortController | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let failures = 0;
    const changed = () => {
      void read();
      setChanges((count) => count + 1);
    };
    const stop = () => {
      following?.abort();
      following = undefined;
      clearTimeout(retry);
      clearInterval(poll);
      poll = undefined;
    };
    // The server says when the pet changed; a reconnect may have missed one.
    const follow = (caughtUp: boolean) => {
      const own = new AbortController();
      following = own;
      let missed = !caughtUp;
      const current = () => !own.signal.aborted && following === own;
      // Sessions that cannot follow (older clients, stand-ins) poll instead.
      const watch: ClientSession["watchPet"] =
        typeof session.watchPet === "function"
          ? session.watchPet.bind(session)
          : async () => "unsupported";
      watch((type) => {
        if (!current()) return;
        if (type === "ready") failures = 0;
        if (type === "pet" || missed) changed();
        missed = false;
      }, own.signal).then(
        (result) => {
          if (!current()) return;
          if (result === "unsupported")
            poll = setInterval(changed, PET_PROFILE_REFRESH_MS);
          else retry = setTimeout(() => follow(false), 1000);
        },
        () => {
          if (!current()) return;
          failures++;
          retry = setTimeout(
            () => follow(false),
            Math.min(30_000, 1000 * 2 ** failures),
          );
        },
      );
    };
    if (AppState.currentState === "active") follow(true);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return stop();
      if (following || poll) return;
      // Back in front: pick up what changed meanwhile, then follow again.
      changed();
      follow(true);
    });
    return () => {
      subscription.remove();
      stop();
    };
  }, [session, read]);
  return {
    profile: state?.owner === scope ? state.profile : undefined,
    error,
    changes,
    read,
    save: async (command: SavePetProfile) => {
      if (!session) throw Error("unsupported");
      const profile = await session.savePetProfile(command);
      if (owner.current !== scope) throw Error("owner_changed");
      if (!profile) throw Error("unsupported");
      // An acknowledgement supersedes every read already in flight.
      request.current++;
      setState((previous) =>
        previous?.owner === scope &&
        previous.profile &&
        profile &&
        previous.profile.revision > profile.revision
          ? previous
          : { owner: scope, profile },
      );
      return profile;
    },
  };
}
