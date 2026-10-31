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
  return {
    profile: state?.owner === scope ? state.profile : undefined,
    error,
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
