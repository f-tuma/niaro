import { createContext, useContext } from "react";
import type { AdminOverview } from "../../../packages/protocol/admin";
import type { Copy } from "./i18n";
export const AdminContext = createContext<{
  data: AdminOverview;
  authorityGeneration: string;
  refreshGeneration: number;
  selectedOrganization: string | null;
  setSelectedOrganization: (id: string) => void;
  selectedWorkspace: string | null;
  setSelectedWorkspace: (id: string | null) => void;
  copy: Copy;
  language: "en" | "cs";
  setLanguage: (value: "en" | "cs") => void;
} | null>(null);
export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error("Administrator session required");
  return value;
}
/** The UI language for shared components the web app mounts outside the
 * console (process designer and process page); the console's own value wins. */
export const UiLanguageContext = createContext<"en" | "cs" | null>(null);
export function useUiLanguage(): "en" | "cs" {
  const admin = useContext(AdminContext);
  const language = useContext(UiLanguageContext);
  return admin?.language ?? language ?? "en";
}
