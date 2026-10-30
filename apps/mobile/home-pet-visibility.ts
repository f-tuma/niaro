import { useCallback, useRef, useState } from "react";
export type HomePetBounds = { top: number; height: number };
/** Layout events capture geometry once; scroll uses numbers only and publishes crossings. */
export function useHomePetVisibility() {
  const bounds = useRef<HomePetBounds | null>(null);
  const viewport = useRef(0),
    offset = useRef(0),
    shown = useRef(true);
  const [visible, setVisible] = useState(true);
  const update = useCallback(() => {
    const b = bounds.current;
    const next =
      !b ||
      viewport.current <= 0 ||
      (b.top + b.height > offset.current &&
        b.top < offset.current + viewport.current);
    if (next !== shown.current) {
      shown.current = next;
      setVisible(next);
    }
  }, []);
  const onBounds = useCallback(
    (value: HomePetBounds | null) => {
      bounds.current = value;
      update();
    },
    [update],
  );
  const onViewport = useCallback(
    (height: number) => {
      if (Number.isFinite(height) && height > 0) viewport.current = height;
      update();
    },
    [update],
  );
  const onScroll = useCallback(
    (y: number, height: number) => {
      if (Number.isFinite(y)) offset.current = y;
      if (Number.isFinite(height) && height > 0) viewport.current = height;
      update();
    },
    [update],
  );
  return { visible, onBounds, onViewport, onScroll };
}
