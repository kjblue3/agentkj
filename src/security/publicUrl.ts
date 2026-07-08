import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 4;

export class UnsafeUrlError extends Error {}

export async function validatePublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("That is not a valid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new UnsafeUrlError("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs containing embedded credentials are not allowed.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new UnsafeUrlError("Local and private-network hosts are not allowed.");
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
        throw new UnsafeUrlError("The hostname could not be resolved.");
      });

  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new UnsafeUrlError("Local, private-network, and cloud-metadata addresses are not allowed.");
  }
  return url;
}

export async function safeFetch(
  rawUrl: string | URL,
  init: RequestInit = {},
  maxRedirects = MAX_REDIRECTS
): Promise<Response> {
  let url = await validatePublicUrl(String(rawUrl));
  let requestInit = { ...init, redirect: "manual" as const };

  for (let redirect = 0; ; redirect += 1) {
    const response = await fetch(url, requestInit);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirect >= maxRedirects) throw new UnsafeUrlError("The URL redirected too many times.");

    const location = response.headers.get("location");
    if (!location) throw new UnsafeUrlError("The URL returned an invalid redirect.");
    url = await validatePublicUrl(new URL(location, url).toString());
    if (response.status === 303) {
      requestInit = { method: "GET", headers: init.headers, redirect: "manual" };
    }
  }
}

function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized.startsWith("::ffff:")) return isPublicIp(normalized.slice(7));
  if (isIP(normalized) === 4) return isPublicIpv4(normalized);
  if (isIP(normalized) !== 6) return false;

  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

function isPublicIpv4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}
