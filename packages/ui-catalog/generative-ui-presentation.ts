import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ElementNode } from "@openuidev/lang-core";

/** Local presentation state belongs to this answer, not its inline/modal mount. */
export const PresentationContext = createContext<Map<string, unknown> | null>(
  null,
);
export const ElementPathContext = createContext("root");
export const ElementPathsContext = createContext<WeakMap<ElementNode, string>>(
  new WeakMap(),
);

/** Paths include prop names and array positions, including currently hidden tabs. */
export function elementPaths(root: ElementNode) {
  const paths = new WeakMap<ElementNode, string>();
  function visit(value: unknown, path: string) {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}/${index}`));
    } else if (value && typeof value === "object") {
      if ((value as ElementNode).type === "element")
        paths.set(value as ElementNode, path);
      for (const [key, child] of Object.entries(value))
        if (key !== "type") visit(child, `${path}/${key}`);
    }
  }
  visit(root, "root");
  return paths;
}

export function usePresentationState<T>(
  name: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const cache = useContext(PresentationContext);
  const key = `${useContext(ElementPathContext)}/${name}`;
  const [value, setValue] = useState<T>(() =>
    cache?.has(key) ? (cache.get(key) as T) : initial,
  );
  const latest = useRef(value);
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      const resolved =
        typeof next === "function"
          ? (next as (previous: T) => T)(latest.current)
          : next;
      latest.current = resolved;
      cache?.set(key, resolved);
      setValue(resolved);
    },
    [cache, key],
  );
  return [value, update];
}

/** Scroll offsets do not need a React render on every frame. */
export function usePresentationScroll(name: string) {
  const cache = useContext(PresentationContext);
  const key = `${useContext(ElementPathContext)}/${name}`;
  const [initialOffset] = useState(
    () =>
      (cache?.get(key) as { x: number; y: number } | undefined) ?? {
        x: 0,
        y: 0,
      },
  );
  const saveOffset = useCallback(
    (offset: { x: number; y: number }) => {
      cache?.set(key, offset);
    },
    [cache, key],
  );
  return { initialOffset, saveOffset };
}
