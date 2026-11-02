import * as React from "react";
import { Button } from "@admin/components/ui/button";

/** How long each kind stays; hovering or focusing it holds it. */
const TOAST_MS = { copied: 2000, undo: 6000 } as const;

type ToastState = {
  id: number;
  kind: keyof typeof TOAST_MS;
  message: string;
  onUndo?: () => void;
};

/**
 * The app's one toast, and only for two things (apps/server-admin/DESIGN.md):
 * "Copied" after a copy, and a change that can be taken back with Undo.
 * Errors stay where they happened; approvals and questions are never toasts.
 */
export type Toast = {
  copied: () => void;
  undo: (message: string, onUndo: () => void) => void;
};

const ToastContext = React.createContext<Toast | null>(null);

/** The toast where a provider is mounted; outside one, nothing is shown. */
function useToast(): Toast | null {
  return React.useContext(ToastContext);
}

function ToastProvider({
  labels,
  children,
}: {
  labels: { copied: string; undo: string };
  children: React.ReactNode;
}) {
  const [toast, setToast] = React.useState<ToastState | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const next = React.useRef(0);
  const hide = React.useCallback(() => {
    clearTimeout(timer.current);
    setToast(null);
  }, []);
  const schedule = React.useCallback((kind: ToastState["kind"]) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), TOAST_MS[kind]);
  }, []);
  const api = React.useMemo<Toast>(() => {
    // One at a time: a new toast replaces the one shown.
    const show = (value: Omit<ToastState, "id">) => {
      setToast({ ...value, id: ++next.current });
      schedule(value.kind);
    };
    return {
      copied: () => show({ kind: "copied", message: labels.copied }),
      undo: (message, onUndo) => show({ kind: "undo", message, onUndo }),
    };
  }, [labels.copied, schedule]);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const hold = () => clearTimeout(timer.current);
  const release = () => {
    if (toast) schedule(toast.kind);
  };
  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Always mounted, so each message is read out as it appears. */}
      <div
        role="status"
        aria-live="polite"
        data-slot="toast-region"
        className="pointer-events-none fixed inset-x-4 bottom-28 z-50 flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6"
      >
        {toast && (
          <div
            key={toast.id}
            data-slot="toast"
            data-kind={toast.kind}
            className="pointer-events-auto flex items-center gap-3 rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 animate-in fade-in-0"
            onMouseEnter={hold}
            onMouseLeave={release}
            onFocus={hold}
            onBlur={release}
          >
            <span>{toast.message}</span>
            {toast.onUndo && (
              <Button
                variant="link"
                size="xs"
                onClick={() => {
                  const undo = toast.onUndo;
                  hide();
                  undo?.();
                }}
              >
                {labels.undo}
              </Button>
            )}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export { ToastProvider, useToast };
