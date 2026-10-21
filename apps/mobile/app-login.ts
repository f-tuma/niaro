import { Linking, Platform } from "react-native";
import {
  randomUUID,
  digestStringAsync,
  CryptoDigestAlgorithm,
  CryptoEncoding,
} from "expo-crypto";
export async function loginProof() {
  const verifier = (randomUUID() + randomUUID()).replaceAll("-", "");
  const state = (randomUUID() + randomUUID()).replaceAll("-", "");
  const challenge = (
    await digestStringAsync(CryptoDigestAlgorithm.SHA256, verifier, {
      encoding: CryptoEncoding.BASE64,
    })
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return { verifier, state, challenge };
}
export function authorizeApp(
  url: string,
  state: string,
  signal: AbortSignal,
  popup?: Window | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let subscription: ReturnType<typeof Linking.addEventListener> | undefined;
    const finish = (code?: string) => {
      clearTimeout(timer);
      subscription?.remove();
      signal.removeEventListener("abort", abort);
      if (Platform.OS === "web") window.removeEventListener("message", message);
      if (code) resolve(code);
      else reject(Error("connection_failed"));
    };
    const receive = (code: unknown, returnedState: unknown) => {
      if (
        returnedState === state &&
        typeof code === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(code)
      )
        finish(code);
    };
    const message = (event: MessageEvent) => {
      if (
        event.origin === new URL(url).origin &&
        event.source === popup &&
        event.data?.type === "agent-app-login"
      )
        receive(event.data.code, event.data.state);
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 300000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    if (Platform.OS === "web") {
      if (!popup) {
        abort();
        return;
      }
      window.addEventListener("message", message);
      popup.location.href = url;
    } else {
      subscription = Linking.addEventListener("url", (event) => {
        const target = new URL(event.url);
        if (target.protocol === "agentclient:" && target.hostname === "auth")
          receive(
            target.searchParams.get("code"),
            target.searchParams.get("state"),
          );
      });
      void Linking.openURL(url).catch(abort);
    }
  });
}
