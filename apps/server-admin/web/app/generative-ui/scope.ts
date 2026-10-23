import { createContext, useContext } from "react";
import type { ComponentRenderer, ElementNode } from "@openuidev/react-lang";
import type { FollowUpField } from "../../../../../packages/openui-library/follow-up";

/** What one generated answer shares with its components. */
export type GeneratedUiScope = {
  /** A read-only chat: controls are off and actions do nothing. */
  disabled: boolean;
  /** Labels of the form fields this answer shows, by `followUpKey`. */
  fields: Map<string, FollowUpField>;
};
export const GeneratedUiScopeContext = createContext<GeneratedUiScope>({
  disabled: true,
  fields: new Map(),
});
export const useGeneratedUiScope = () => useContext(GeneratedUiScopeContext);

/** A component's evaluated props; while streaming any of them may be missing. */
export type View<P> = ComponentRenderer<Partial<P>>;
export const isElement = (value: unknown): value is ElementNode =>
  !!value &&
  typeof value === "object" &&
  (value as { type?: unknown }).type === "element";
/** The child elements of a list prop, without partial non-elements. */
export const elements = (value: unknown): ElementNode[] =>
  Array.isArray(value) ? value.filter(isElement) : [];
export const text = (value: unknown) =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : "";
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
