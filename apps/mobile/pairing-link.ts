/** A pairing link from the web account page's QR code: niaro://pair?address=…&code=… */
export type PairingLink = { address: string; host: string; code: string };

/**
 * Reads the link by hand (React Native's URL is partial). Only a workspace
 * address on http(s) and a one-time code pass; anything else is ignored.
 */
export function pairingLink(
  url: string | null | undefined,
): PairingLink | null {
  const query = url?.match(/^niaro:\/\/pair\/?\?(.*)$/)?.[1];
  if (!query) return null;
  const params = new Map<string, string>();
  for (const part of query.split("&")) {
    const [key, value = ""] = part.split("=");
    try {
      params.set(
        decodeURIComponent(key!),
        decodeURIComponent(value.replace(/\+/g, " ")),
      );
    } catch {
      return null;
    }
  }
  const address = params.get("address") ?? "";
  const code = params.get("code") ?? "";
  const host = address.match(/^https?:\/\/([^/?#\s]+)\/v1\/[\w-]{1,128}$/)?.[1];
  if (!host || !/^[a-f0-9]{32}$/.test(code)) return null;
  return { address, host, code };
}
