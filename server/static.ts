/// Static asset serving + security headers (spec §8.2, §9; overview C6).

const repoRoot = new URL("../", import.meta.url);

/**
 * CSP hash of the inline theme-boot script in index.html — the only inline
 * script allowed. static_test.ts recomputes it from index.html, so editing
 * the script without updating this constant fails tests, not production.
 */
export const THEME_BOOT_SCRIPT_HASH =
  "sha256-F7NeMJtAxDWGKR58UDe5oR8hJk7NfB6Iuf1hMRcXAw4=";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    `default-src 'self'; script-src 'self' '${THEME_BOOT_SCRIPT_HASH}'; ` +
    "style-src 'self'; " +
    "connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * Return a copy of `res` carrying the three pinned security headers.
 * WebSocket upgrade responses (101) pass through untouched — their headers
 * are immutable and CSP is meaningless on them.
 */
export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res;
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** /r/<22-char base64url path token> — same shape as shared/protocol.ts PATH_TOKEN_RE. */
const PATH_TOKEN_ROUTE = /^\/r\/[A-Za-z0-9_-]{22}$/;

/** /themes/<id>.css — theme ids are lowercase alphanumerics and hyphens only. */
const THEME_ROUTE = /^\/themes\/([a-z0-9-]{1,32})\.css$/;

/** /favicons/<id>.svg — same id shape, one wax-seal recolor per theme. */
const FAVICON_ROUTE = /^\/favicons\/([a-z0-9-]{1,32})\.svg$/;

/** /og-images/<id>.png — same id shape, one static share-preview image per theme. */
const OG_IMAGE_ROUTE = /^\/og-images\/([a-z0-9-]{1,32})\.png$/;

async function textAsset(
  relPath: string,
  contentType: string,
): Promise<Response> {
  const body = await Deno.readTextFile(new URL(relPath, repoRoot));
  return new Response(body, {
    headers: { "content-type": contentType, "cache-control": "no-cache" },
  });
}

async function bytesAsset(
  relPath: string,
  contentType: string,
): Promise<Response> {
  const body = await Deno.readFile(new URL(relPath, repoRoot));
  return new Response(body, {
    headers: { "content-type": contentType, "cache-control": "no-cache" },
  });
}

let devBundleCache: string | null = null;

/** Dev fallback: bundle client/app.ts in-process (production serves dist/app.js). */
async function devBundle(): Promise<string> {
  if (devBundleCache !== null) return devBundleCache;
  const esbuild = await import("esbuild");
  const { denoPlugins } = await import("@luca/esbuild-deno-loader");
  const result = await esbuild.build({
    plugins: [...denoPlugins()],
    entryPoints: [new URL("client/app.ts", repoRoot).pathname],
    bundle: true,
    format: "esm",
    write: false,
    target: "es2022",
  });
  devBundleCache = result.outputFiles[0].text;
  return devBundleCache;
}

const JS_TYPE = "application/javascript; charset=utf-8";

async function serveAppJs(): Promise<Response> {
  try {
    // Production path: prebuilt, minified bundle.
    return await textAsset("dist/app.js", JS_TYPE);
  } catch {
    // Dev path: `deno task dev` restarts on change, which clears the cache.
    return new Response(await devBundle(), {
      headers: { "content-type": JS_TYPE, "cache-control": "no-cache" },
    });
  }
}

/**
 * Serve the static routes: `/` and `/r/:pathToken` (both the shell —
 * role is decided client-side), `/styles.css`, `/app.js`, `/themes/<id>.css`.
 * Returns null for anything else so the caller can 404.
 */
export async function handleStaticRequest(
  req: Request,
): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const { pathname } = new URL(req.url);
  if (pathname === "/" || PATH_TOKEN_ROUTE.test(pathname)) {
    return await textAsset("index.html", "text/html; charset=utf-8");
  }
  if (pathname === "/styles.css") {
    return await textAsset("client/styles.css", "text/css; charset=utf-8");
  }
  if (pathname === "/app.js") {
    return await serveAppJs();
  }
  const theme = THEME_ROUTE.exec(pathname);
  if (theme) {
    try {
      return await textAsset(
        `client/themes/${theme[1]}.css`,
        "text/css; charset=utf-8",
      );
    } catch {
      return null; // registry/regex-shaped name but no such file
    }
  }
  const favicon = FAVICON_ROUTE.exec(pathname);
  if (favicon) {
    try {
      return await textAsset(
        `client/favicons/${favicon[1]}.svg`,
        "image/svg+xml",
      );
    } catch {
      return null; // registry/regex-shaped name but no such file
    }
  }
  const ogImage = OG_IMAGE_ROUTE.exec(pathname);
  if (ogImage) {
    try {
      return await bytesAsset(
        `client/og-images/${ogImage[1]}.png`,
        "image/png",
      );
    } catch {
      return null; // registry/regex-shaped name but no such file
    }
  }
  return null;
}
