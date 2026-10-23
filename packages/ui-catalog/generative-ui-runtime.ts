import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Linking } from "react-native";
import {
  ACTION_STEPS,
  BuiltinActionType,
  createStore,
  createStreamingParser,
  evaluate,
  evaluateRoot,
  isReactiveAssign,
  resolveStateField,
  type ActionPlan,
  type ElementNode,
  type EvaluationContext,
  type ParseResult,
  type Store,
} from "@openuidev/lang-core";
import type { Language } from "../protocol";
import { generativeUiLibrary } from "../openui-library/spec";
import { checkProgram, safeUrl } from "../openui-library/program";
import {
  followUpKey,
  followUpMessage,
  type FollowUpField,
} from "../openui-library/follow-up";

/**
 * The phone's OpenUI runtime on lang-core, mirroring react-lang's semantics
 * without Query, Mutation or tool calls: `$variables` and form fields live
 * in one store, actions run locally (@Set, @Reset), open a checked web link,
 * or put a follow-up in the person's message box. Nothing is ever sent here.
 */
export type FieldKind = FollowUpField["kind"];
export type FieldError = "required" | "date";
type Field = FollowUpField & { required?: boolean };
export type GenerativeUiRuntime = {
  store: Store;
  context: EvaluationContext;
  streaming: boolean;
  disabled: boolean;
  language: Language;
  /** Labels of the shown form fields, by followUpKey(form, name). */
  fields: Map<string, Field>;
  getFieldValue(form: string | undefined, name: string): unknown;
  setFieldValue(
    form: string | undefined,
    kind: FieldKind | undefined,
    name: string,
    value: unknown,
  ): void;
  /** What a press does: its action, or by default its label as a follow-up. */
  trigger(label: string, form: string | undefined, action: unknown): void;
  openUrl(url: unknown): void;
  /** Fields of a form that stop its follow-up. */
  invalid(form: string): Record<string, FieldError>;
};

export const RuntimeContext = createContext<GenerativeUiRuntime | null>(null);
export const FormNameContext = createContext<string | undefined>(undefined);
export const RenderNodeContext = createContext<
  (value: unknown) => React.ReactNode
>(() => null);
export function useRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("Generated UI renders inside its view");
  return runtime;
}
export const useRenderNode = () => useContext(RenderNodeContext);

const schema = generativeUiLibrary.toJSONSchema();
const NONE: Record<string, unknown> = {};
const unwrap = (value: unknown) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  "value" in value
    ? (value as { value: unknown }).value
    : value;
const isPlan = (value: unknown): value is ActionPlan =>
  !!value &&
  typeof value === "object" &&
  Array.isArray((value as ActionPlan).steps);
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Props of a streaming or model-written element are checked where read.
export const isElement = (
  value: unknown,
  name?: string,
): value is ElementNode =>
  !!value &&
  typeof value === "object" &&
  (value as ElementNode).type === "element" &&
  (!name || (value as ElementNode).typeName === name);
export const str = (value: unknown) =>
  typeof value === "string"
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;
export const num = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
export const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
export const elements = (value: unknown, name: string) =>
  list(value).filter((item): item is ElementNode => isElement(item, name));
export function formatNumber(value: number, language: string) {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(
    value,
  );
}
export function validDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function useGenerativeUi({
  program,
  streaming,
  disabled,
  language,
  onFollowUp,
  onOpenUrl,
}: {
  program: string;
  streaming: boolean;
  disabled: boolean;
  language: Language;
  onFollowUp: (text: string) => void;
  onOpenUrl?: (href: string) => void;
}) {
  const parser = useMemo(
    () => createStreamingParser(schema, generativeUiLibrary.root),
    [],
  );
  const result = useMemo<ParseResult | null>(() => {
    try {
      // While streaming the raw text renders as it grows; a finished program
      // renders only what the shared checker admits.
      if (streaming) return parser.set(program, false);
      const checked = checkProgram(program);
      return checked.ok ? parser.set(checked.program, true) : null;
    } catch {
      // A chunk the parser cannot take yet keeps its last result.
      try {
        return streaming ? parser.getResult(false) : null;
      } catch {
        return null;
      }
    }
  }, [parser, program, streaming]);
  const store = useMemo(() => createStore(), []);
  const declarations = result?.stateDeclarations ?? NONE;
  const declared = JSON.stringify(declarations);
  useEffect(() => {
    store.initialize(JSON.parse(declared), {});
  }, [store, declared]);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const context = useMemo<EvaluationContext>(
    () => ({
      // Declared defaults hold until the store is initialized after the
      // first render, so that render already shows them.
      getState: (name) =>
        unwrap(
          name in store.getSnapshot() ? store.get(name) : declarations[name],
        ),
      resolveRef: () => null,
    }),
    [store, declarations],
  );
  const root = useMemo<ElementNode | null>(() => {
    if (!result) return null;
    try {
      return evaluateRoot(result, {
        ctx: context,
        library: generativeUiLibrary,
        store,
        errors: [],
      });
    } catch {
      // Unevaluated props read as missing; element boundaries keep the rest.
      return result.root;
    }
    // The snapshot is what changes the evaluated state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, context, store, snapshot]);

  const [fields] = useState(() => new Map<string, Field>());
  const latest = useRef({ onFollowUp, onOpenUrl, language });
  useEffect(() => {
    latest.current = { onFollowUp, onOpenUrl, language };
  });
  const getFieldValue = useCallback(
    (form: string | undefined, name: string) =>
      unwrap(form ? record(store.get(form))[name] : store.get(name)),
    [store],
  );
  const setFieldValue = useCallback(
    (
      form: string | undefined,
      kind: FieldKind | undefined,
      name: string,
      value: unknown,
    ) => {
      const wrapped = { value, componentType: kind };
      if (!form) store.set(name, wrapped);
      else store.set(form, { ...record(store.get(form)), [name]: wrapped });
    },
    [store],
  );
  const openUrl = useCallback((url: unknown) => {
    const href = safeUrl(url);
    if (!href) return;
    const open = latest.current.onOpenUrl;
    if (open) open(href);
    else void Linking.openURL(href).catch(() => {});
  }, []);
  const inactive = disabled || streaming;
  const trigger = useCallback(
    (label: string, form: string | undefined, action: unknown) => {
      if (inactive) return;
      // The step's words and the answered fields, for the person to send.
      // A step's hidden `context` is never added.
      const followUp = (message: string) => {
        const text = followUpMessage({
          message,
          formName: form,
          formState: store.getSnapshot(),
          fields,
          language: latest.current.language,
        });
        if (text) latest.current.onFollowUp(text);
      };
      if (!isPlan(action)) {
        const legacy = record(action);
        if (legacy.type === BuiltinActionType.OpenUrl) openUrl(legacy.url);
        else if (
          !legacy.type ||
          legacy.type === BuiltinActionType.ContinueConversation
        )
          followUp(label);
        return;
      }
      for (const step of action.steps)
        switch (step.type) {
          case ACTION_STEPS.ToAssistant:
            followUp(step.message || label);
            break;
          case ACTION_STEPS.OpenUrl:
            openUrl(step.url);
            break;
          case ACTION_STEPS.Set:
            if (step.valueAST)
              store.set(step.target, evaluate(step.valueAST, context));
            break;
          case ACTION_STEPS.Reset:
            for (const target of step.targets)
              store.set(target, declarations[target] ?? null, {
                pristine: true,
              });
            break;
          // @Run and library actions: nothing runs on the phone.
        }
    },
    [inactive, store, fields, context, declarations, openUrl],
  );
  const invalid = useCallback(
    (form: string) => {
      const errors: Record<string, FieldError> = {};
      const prefix = followUpKey(form, "");
      for (const [key, field] of fields) {
        if (!key.startsWith(prefix)) continue;
        const name = key.slice(prefix.length);
        const value = getFieldValue(form, name);
        if (
          value === undefined ||
          value === null ||
          (typeof value === "string" && !value.trim())
        ) {
          if (field.required) errors[name] = "required";
        } else if (field.kind === "date" && !validDate(value))
          errors[name] = "date";
      }
      return errors;
    },
    [fields, getFieldValue],
  );
  const runtime = useMemo<GenerativeUiRuntime>(
    () => ({
      store,
      context,
      streaming,
      disabled,
      language,
      fields,
      getFieldValue,
      setFieldValue,
      trigger,
      openUrl,
      invalid,
    }),
    [
      store,
      context,
      streaming,
      disabled,
      language,
      fields,
      getFieldValue,
      setFieldValue,
      trigger,
      openUrl,
      invalid,
    ],
  );
  return { root, runtime };
}

/**
 * One form input's value: its `$variable` binding or its form field, like
 * react-lang's useStateField. A bound value is mirrored into the form so
 * the follow-up still names it.
 */
export function useGenerativeField({
  name,
  label,
  kind,
  value,
  required,
}: {
  name: string;
  label: string;
  kind: FieldKind;
  value: unknown;
  required?: boolean;
}) {
  const runtime = useRuntime();
  const form = useContext(FormNameContext);
  runtime.fields.set(followUpKey(form, name), { label, kind, required });
  const field = resolveStateField(
    name,
    value,
    runtime.store,
    runtime.context,
    (fieldName) => runtime.getFieldValue(form, fieldName),
    (fieldName, next) => runtime.setFieldValue(form, kind, fieldName, next),
  );
  const current =
    field.isReactive && isReactiveAssign(value)
      ? (field.value ?? runtime.context.getState(value.target))
      : field.value;
  const existing = runtime.getFieldValue(form, name);
  const { streaming, setFieldValue } = runtime;
  // A shown default counts as an answer once the program is complete.
  useEffect(() => {
    if (!streaming && existing === undefined && current != null)
      setFieldValue(form, kind, name, current);
  }, [streaming, existing, current, setFieldValue, form, kind, name]);
  return {
    value: current,
    setValue: (next: unknown) => {
      if (runtime.disabled || runtime.streaming) return;
      field.setValue(next);
      if (field.isReactive) runtime.setFieldValue(form, kind, name, next);
    },
  };
}
