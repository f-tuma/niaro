const authorityKey = "agent-admin-design-authority";
export const designStoragePrefix = "agent-admin-design/1/";
let currentAuthority: string | undefined;

/** A local login generation, retained across reloads but never across sign-in/out. */
export function designAuthority(): string {
  if (currentAuthority) return currentAuthority;
  try {
    const prior = sessionStorage.getItem(authorityKey);
    if (prior) return (currentAuthority = prior);
    const id = crypto.randomUUID();
    sessionStorage.setItem(authorityKey, id);
    return (currentAuthority = id);
  } catch {
    return (currentAuthority = crypto.randomUUID());
  }
}
export function resetDesignAuthority(): string {
  // Rotation is independent of cleanup/storage availability, including same-account login.
  currentAuthority = crypto.randomUUID();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(designStoragePrefix)) {
        try {
          sessionStorage.removeItem(key);
        } catch {
          /* Continue cleaning other keys. */
        }
      }
    }
    sessionStorage.setItem(authorityKey, currentAuthority);
  } catch {
    /* The mounted controller is still fenced and disposed. */
  }
  return currentAuthority;
}
