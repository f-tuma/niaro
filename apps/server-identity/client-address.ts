import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

/** Loopback and private networks: where the bundled proxy connects from. */
function privatePeer(address: string) {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const lower = address.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd");
}

/**
 * Whether the server sits behind the bundled reverse proxy. `1` trusts it,
 * `0` (or unset) does not, and `auto` (the compose default) trusts it only
 * when the public URL is HTTPS: that is the `https` profile, where Caddy is
 * the only way in. The plain-HTTP local trial has no proxy to trust.
 */
export function trustProxyFromEnv(
  env: Partial<Record<string, string>> = process.env,
) {
  const value = env.NIARO_TRUST_PROXY?.trim().toLowerCase();
  if (value === "1") return true;
  if (value === "auto")
    return /^https:\/\//i.test(env.NIARO_PUBLIC_URL?.trim() ?? "");
  return false;
}

let parsed: { value: string; list: BlockList } | undefined;
/**
 * `NIARO_TRUSTED_PROXIES`: the proxy's own addresses (IPs or CIDR ranges,
 * comma-separated). Set, only a peer among them may name the client; unset
 * (null), any loopback or private-network peer may, which is right only where
 * nothing but the proxy shares the server's network. An entry that is not an
 * address is ignored, so a typo trusts less, never more.
 */
export function trustedProxiesFromEnv(
  env: Partial<Record<string, string>> = process.env,
): BlockList | null {
  const value = env.NIARO_TRUSTED_PROXIES?.trim() ?? "";
  if (!value) return null;
  if (parsed?.value === value) return parsed.list;
  const list = new BlockList();
  for (const entry of value.split(/[\s,]+/).filter(Boolean)) {
    const [address = "", prefix, extra] = entry.split("/");
    const family = isIP(address);
    if (!family || extra !== undefined) continue;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(address, type);
    else if (
      /^\d{1,3}$/.test(prefix) &&
      Number(prefix) <= (family === 4 ? 32 : 128)
    )
      list.addSubnet(address, Number(prefix), type);
  }
  parsed = { value, list };
  return list;
}
function listedPeer(list: BlockList, address: string) {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) return list.check(v4, "ipv4");
  return isIP(address) === 6 && list.check(address, "ipv6");
}

/**
 * The address rate limits count against. Behind the bundled reverse proxy
 * (see trustProxyFromEnv), a request from a loopback or private-network peer is
 * counted by the last address the proxy appended to `X-Forwarded-For`; a client
 * cannot choose it, because the proxy appends the peer it actually saw. Enable
 * it only when the server port is reachable solely through that proxy (the
 * compose file publishes it on 127.0.0.1), or name the proxy's addresses in
 * `NIARO_TRUSTED_PROXIES` where other containers share its network (Dokploy).
 * Otherwise the socket address counts.
 */
export function clientAddress(
  req: IncomingMessage,
  trustProxy = trustProxyFromEnv(),
  proxies = trustedProxiesFromEnv(),
): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!trustProxy || !(proxies ? listedPeer(proxies, peer) : privatePeer(peer)))
    return peer;
  const header = req.headers["x-forwarded-for"];
  const value = Array.isArray(header) ? header.at(-1) : header;
  const last = value?.split(",").at(-1)?.trim();
  return last && isIP(last) ? last : peer;
}
