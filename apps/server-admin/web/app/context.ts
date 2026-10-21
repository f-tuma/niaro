import { createContext, useContext } from "react";
import type { ClientSession } from "../../../../packages/client-core/session";
import type { IdentityState } from "../../../../packages/protocol/identity";

export type AppWorkspace = {
  organizationId: string;
  organizationName: string;
  role: string;
  workspaceId: string;
  name: string;
};

/** The signed-in person, their chosen workspace and its chat session. */
export type AppContextValue = {
  language: "en" | "cs";
  setLanguage(language: "en" | "cs"): void;
  identity: IdentityState;
  workspaces: AppWorkspace[];
  workspace: AppWorkspace;
  selectWorkspace(workspaceId: string): void;
  /** Owners and administrators of the workspace's organization. */
  isAdmin: boolean;
  /** Null while connecting or after a failure; see `sessionError`. */
  session: ClientSession | null;
  sessionError: "sessionFailed" | "sessionEnded" | "deviceLimit" | null;
  reconnect(): void;
  signOut(): void;
};
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("App context is missing");
  return value;
}
/** The chat session once connected; pages render only inside a ready shell. */
export function useAppSession() {
  const { session } = useApp();
  if (!session) throw new Error("Chat session is not ready");
  return session;
}
