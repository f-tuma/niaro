export function normalizeAddress(
  raw: string,
  allowInsecureDevelopment = false,
): string {
  const url = new URL(raw.trim());
  if (url.username || url.password || url.search || url.hash)
    throw new Error("invalid_address");
  const host = url.hostname;
  const octets = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    ? host.split(".").map(Number)
    : [];
  const privateIPv4 =
    octets.length === 4 &&
    octets.every((n) => n <= 255) &&
    (octets[0] === 127 ||
      octets[0] === 10 ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31));
  const local = host === "localhost" || host === "[::1]" || privateIPv4;
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && allowInsecureDevelopment && local)
  )
    throw new Error("https_required");
  return url.toString().replace(/\/$/, "");
}
