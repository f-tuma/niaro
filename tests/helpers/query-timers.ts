import { timeoutManager } from "@tanstack/react-query";

/**
 * React Query keeps finished queries and mutations for five minutes behind a
 * garbage-collection timer. A test that never unmounts its client would hold
 * Jest open that long after its last test ("Jest did not exit"). The same
 * timers, unreferenced, still fire while a test runs and never keep the
 * process alive. Fake timers keep working: the globals are read per call.
 */
const unref = <T>(timer: T): T => {
  (timer as { unref?: () => void }).unref?.();
  return timer;
};
timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) =>
    unref(globalThis.setTimeout(callback, delay)),
  clearTimeout: (id) =>
    globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (callback, delay) =>
    unref(globalThis.setInterval(callback, delay)),
  clearInterval: (id) =>
    globalThis.clearInterval(id as ReturnType<typeof setInterval>),
});
