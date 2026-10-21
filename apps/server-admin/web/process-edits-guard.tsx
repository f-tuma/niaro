import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from "@admin/components/ui/alert-dialog";
import type { DesignCopy } from "./process-design-copy";

type Scope = { organizationId: string; workspaceId: string };
type Guard = {
  register(scope: Scope, dirty: boolean): () => void;
  request(action: () => void, scope?: Scope): void;
};
const ProcessEditsContext = createContext<Guard>({
  register: () => () => {},
  request: (action) => action(),
});
export const useProcessEditsGuard = () => useContext(ProcessEditsContext);

/** Mounted editors register only dirty state, never proposal content. */
export function ProcessEditsGuard({
  children,
  copy,
}: {
  children: ReactNode;
  copy: DesignCopy;
}) {
  const editors = useRef(new Map<object, Scope>());
  const pending = useRef<{ action: () => void; owners: object[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const close = useCallback(() => {
    pending.current = null;
    setAsking(false);
  }, []);
  const register = useCallback(
    (scope: Scope, dirty: boolean) => {
      if (!dirty) return () => {};
      const owner = {};
      editors.current.set(owner, scope);
      return () => {
        editors.current.delete(owner);
        if (pending.current?.owners.includes(owner)) close();
      };
    },
    [close],
  );
  const request = useCallback((action: () => void, scope?: Scope) => {
    const owners = [...editors.current]
      .filter(
        ([, editor]) =>
          !scope ||
          (editor.organizationId === scope.organizationId &&
            editor.workspaceId === scope.workspaceId),
      )
      .map(([owner]) => owner);
    if (!owners.length) {
      action();
      return;
    }
    pending.current = { action, owners };
    setAsking(true);
  }, []);
  const guard = useMemo(() => ({ register, request }), [register, request]);
  return (
    <ProcessEditsContext.Provider value={guard}>
      {children}
      <AlertDialog open={asking} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.leaveTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.leaveHint}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={close}>
              {copy.stayAction}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const next = pending.current;
                close();
                if (next?.owners.every((owner) => editors.current.has(owner)))
                  next.action();
              }}
            >
              {copy.leaveAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ProcessEditsContext.Provider>
  );
}
