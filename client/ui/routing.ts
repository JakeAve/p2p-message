import { PATH_TOKEN_RE } from "../../shared/protocol.ts";
import { base64urlToBytes, derivePathToken } from "../crypto.ts";

/** 32 random bytes base64url-encode to exactly 43 chars, no padding (spec §2). */
const FRAGMENT_RE = /^[A-Za-z0-9_-]{43}$/;

export type Route =
  | { view: "create" }
  | { view: "join"; pathToken: string; fragment: string }
  | { view: "invalid-link" }
  | { view: "not-found" };

/**
 * Decide which view a URL addresses. Pure — pass `location.pathname` and
 * `location.hash`. A join URL whose token or fragment is malformed is
 * "invalid-link" (mangled copy/paste), not a 404.
 */
export function parseRoute(pathname: string, hash: string): Route {
  if (pathname === "/") return { view: "create" };
  const match = pathname.match(/^\/r\/([^/]+)$/);
  if (!match) return { view: "not-found" };
  const pathToken = match[1];
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!PATH_TOKEN_RE.test(pathToken) || !FRAGMENT_RE.test(fragment)) {
    return { view: "invalid-link" };
  }
  return { view: "join", pathToken, fragment };
}

/** Full shareable link: https://host/r/<path-token>#<fragment-secret> (spec §2). */
export function buildShareLink(
  origin: string,
  pathToken: string,
  fragment: string,
): string {
  return `${origin}/r/${pathToken}#${fragment}`;
}

/**
 * Spec §2: recompute the path token from the fragment and compare with the
 * URL path BEFORE any network traffic. Never throws — any failure is false.
 */
export async function fragmentMatchesPath(
  fragment: string,
  pathToken: string,
): Promise<boolean> {
  let secret: Uint8Array<ArrayBuffer>;
  try {
    secret = base64urlToBytes(fragment);
  } catch {
    return false;
  }
  if (secret.length !== 32) return false;
  return (await derivePathToken(secret)) === pathToken;
}
